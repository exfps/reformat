use crate::files::{
    display_name, prepare_output_dir, sanitize_stem, strip_known_extension, unique_output_path,
    validate_input_file,
};
use crate::job::{emit_progress, FileError, JobOutcome, OutputFile};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tempfile::tempdir;

const MAX_VIDEO_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_GIF_FRAMES: u32 = 300;
const MAX_GIF_SECONDS: f64 = 30.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProbe {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub thumbnail: String,
    pub supported: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifRequest {
    pub job_id: String,
    pub input: String,
    pub output_dir: Option<String>,
    pub file_name: String,
    pub start: f64,
    pub duration: f64,
    pub fps: f64,
    pub width: u32,
    pub r#loop: bool,
}

fn target_arch() -> &'static str {
    std::env::consts::ARCH
}

fn helper_path() -> Result<PathBuf, String> {
    let name = "reformat-video";
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
            candidates.push(dir.join(format!("{name}-{}-apple-darwin", target_arch())));
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("{name}-{}-apple-darwin", target_arch())),
    );
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(name),
    );
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("The video helper is missing from this build. Reinstall Reformat or rebuild the app with the Swift helper.".to_string())
}

fn run_probe_helper(command: &mut Command) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Couldn't start the video helper: {e}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|e| format!("Couldn't read the video helper result: {e}"));
            }
            Ok(None) => {
                if started.elapsed() > Duration::from_secs(30) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(
                        "The video took too long to inspect. It may be malformed.".to_string()
                    );
                }
                thread::sleep(Duration::from_millis(60));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("The video helper stopped unexpectedly: {error}"));
            }
        }
    }
}

fn probe_duration(path: &str, thumbnail_path: &Path) -> Result<(f64, u32, u32), String> {
    let helper = helper_path()?;
    let mut command = Command::new(&helper);
    command.args([
        "--mode",
        "probe",
        "--input",
        path,
        "--thumbnail",
        &thumbnail_path.to_string_lossy(),
    ]);
    let output = run_probe_helper(&mut command)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "This video couldn't be read.".to_string()
        } else {
            stderr
        });
    }
    let json = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(json.trim())
        .map_err(|_| "The video helper returned an unexpected result.".to_string())?;
    let duration = value
        .get("duration")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let width = value.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let height = value.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if duration <= 0.0 || width == 0 || height == 0 {
        return Err("This video has no readable duration or picture.".to_string());
    }
    Ok((duration, width, height))
}

pub fn probe_video(path: String) -> Result<VideoProbe, String> {
    let source = validate_input_file(&path)?;
    let metadata = fs::metadata(&source).map_err(|e| format!("Couldn't inspect the video: {e}"))?;
    if metadata.len() > MAX_VIDEO_BYTES {
        return Err("This video is larger than 8 GB. Trim it before making a GIF.".to_string());
    }
    let temp = tempdir().map_err(|e| format!("Couldn't create a preview workspace: {e}"))?;
    let thumbnail_path = temp.path().join("poster.jpg");
    let (duration, width, height) = probe_duration(&path, &thumbnail_path)?;
    let thumb =
        fs::read(&thumbnail_path).map_err(|_| "The video preview couldn't be read.".to_string())?;
    Ok(VideoProbe {
        path: path.clone(),
        name: display_name(&path),
        bytes: metadata.len(),
        duration,
        width,
        height,
        thumbnail: format!("data:image/jpeg;base64,{}", BASE64.encode(thumb)),
        supported: true,
    })
}

fn temp_gif_path(dir: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.join(format!(".reformat-video-{stamp}.part"))
}

fn drain_stderr(child: &mut std::process::Child) -> String {
    let mut text = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        use std::io::Read;
        let _ = stderr.read_to_string(&mut text);
    }
    text
}

pub fn run_create_gif(
    app: Option<&AppHandle>,
    token: std::sync::Arc<AtomicBool>,
    request: GifRequest,
) -> Result<JobOutcome, String> {
    let started = Instant::now();
    let source = validate_input_file(&request.input)?;
    let output_dir = prepare_output_dir(&source, request.output_dir.as_deref())?;
    let source_stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "animation".to_string());
    let requested_name = if request.file_name.trim().is_empty() {
        format!("{source_stem}.gif")
    } else {
        request.file_name.clone()
    };
    let stem = sanitize_stem(&strip_known_extension(&requested_name), &source_stem);
    let target = unique_output_path(&output_dir, &stem, "gif");
    let width = request.width.clamp(160, 1280);
    let fps = request.fps.clamp(4.0, 20.0);
    let duration = request.duration.clamp(0.15, MAX_GIF_SECONDS);
    let start = request.start.max(0.0);
    let estimated_frames = ((duration * fps).round() as u32).clamp(1, MAX_GIF_FRAMES);
    let total = estimated_frames as usize;
    let temp_path = temp_gif_path(&output_dir);
    let helper = helper_path()?;

    emit_progress(
        app,
        &request.job_id,
        "video-to-gif",
        total,
        0,
        Some(display_name(&request.input)),
        "running",
    );

    let mut child = Command::new(&helper)
        .args([
            "--mode".to_string(),
            "gif".to_string(),
            "--input".to_string(),
            request.input.clone(),
            "--output".to_string(),
            temp_path.to_string_lossy().into_owned(),
            "--start".to_string(),
            format!("{start:.3}"),
            "--duration".to_string(),
            format!("{duration:.3}"),
            "--fps".to_string(),
            format!("{fps:.2}"),
            "--width".to_string(),
            width.to_string(),
            "--loop".to_string(),
            if request.r#loop {
                "true".to_string()
            } else {
                "false".to_string()
            },
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start the video helper: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Couldn't read the video helper output.".to_string())?;
    let (tx, rx) = mpsc::channel::<String>();
    let reader = thread::spawn(move || {
        let lines = BufReader::new(stdout).lines();
        for line in lines.map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });

    let mut completed = 0usize;
    let status = loop {
        while let Ok(line) = rx.try_recv() {
            if let Some(rest) = line.strip_prefix("PROGRESS ") {
                if let Some((done, reported_total)) = rest.split_once('/') {
                    if let (Ok(done), Ok(reported_total)) =
                        (done.parse::<usize>(), reported_total.parse::<usize>())
                    {
                        completed = done;
                        emit_progress(
                            app,
                            &request.job_id,
                            "video-to-gif",
                            reported_total,
                            completed,
                            Some(display_name(&request.input)),
                            "running",
                        );
                    }
                }
            }
        }
        if token.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            let _ = fs::remove_file(&temp_path);
            emit_progress(
                app,
                &request.job_id,
                "video-to-gif",
                total,
                completed,
                None,
                "cancelled",
            );
            return Ok(JobOutcome {
                job_id: request.job_id,
                outputs: vec![],
                errors: vec![],
                cancelled: true,
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
        if started.elapsed() > Duration::from_secs(300) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            let _ = fs::remove_file(&temp_path);
            return Err(
                "Making this GIF took too long. Try a shorter clip or fewer frames.".to_string(),
            );
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(80)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&temp_path);
                let _ = reader.join();
                return Err(format!("The video helper stopped unexpectedly: {error}"));
            }
        }
    };

    let stderr = drain_stderr(&mut child);
    let _ = reader.join();
    while let Ok(line) = rx.try_recv() {
        if line.starts_with("PROGRESS ") {
            completed = total;
        }
    }
    if !status.success() {
        let _ = fs::remove_file(&temp_path);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            "The GIF couldn't be created from this video.".to_string()
        } else {
            detail.to_string()
        });
    }
    if !temp_path.is_file() {
        return Err("The video helper finished without writing a GIF.".to_string());
    }
    let bytes = fs::metadata(&temp_path)
        .map_err(|e| format!("Couldn't inspect the GIF: {e}"))?
        .len();
    // A tiny final check closes the temp-file window before the atomic publish.
    if token.load(Ordering::SeqCst) {
        let _ = fs::remove_file(&temp_path);
        emit_progress(
            app,
            &request.job_id,
            "video-to-gif",
            total,
            completed,
            None,
            "cancelled",
        );
        return Ok(JobOutcome {
            job_id: request.job_id,
            outputs: vec![],
            errors: vec![],
            cancelled: true,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }
    match fs::hard_link(&temp_path, &target) {
        Ok(()) => {
            let _ = fs::remove_file(&temp_path);
        }
        Err(_) => {
            if target.exists() {
                let _ = fs::remove_file(&temp_path);
                return Err("A GIF with that name already exists. Choose another name.".to_string());
            }
            fs::rename(&temp_path, &target).map_err(|e| format!("Couldn't save the GIF: {e}"))?;
        }
    }
    emit_progress(
        app,
        &request.job_id,
        "video-to-gif",
        total,
        total,
        None,
        "finished",
    );
    Ok(JobOutcome {
        job_id: request.job_id,
        outputs: vec![OutputFile {
            path: target.to_string_lossy().into_owned(),
            name: target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "animation.gif".to_string()),
            source_path: request.input.clone(),
            bytes,
            width: Some(width),
            height: None,
            pages: None,
        }],
        errors: Vec::<FileError>::new(),
        cancelled: false,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_a_gif_from_a_real_video() {
        if !cfg!(target_os = "macos") || helper_path().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("clip.mp4");
        std::fs::write(&input, include_bytes!("../tests/fixtures/sample.mp4")).unwrap();
        let probe = probe_video(input.to_string_lossy().into_owned()).unwrap();
        assert!(probe.duration > 1.0);
        assert!(probe.thumbnail.starts_with("data:image/jpeg;base64,"));
        let outcome = run_create_gif(
            None,
            std::sync::Arc::new(AtomicBool::new(false)),
            GifRequest {
                job_id: "gif-test".into(),
                input: input.to_string_lossy().into_owned(),
                output_dir: Some(dir.path().to_string_lossy().into_owned()),
                file_name: "clip.gif".into(),
                start: 0.5,
                duration: 0.8,
                fps: 8.0,
                width: 320,
                r#loop: true,
            },
        )
        .unwrap();
        assert!(!outcome.cancelled);
        assert_eq!(outcome.outputs[0].name, "clip.gif");
        let output = std::fs::read(&outcome.outputs[0].path).unwrap();
        assert!(output.starts_with(b"GIF87a") || output.starts_with(b"GIF89a"));
        assert!(output.len() > 1000);
    }

    #[test]
    fn helper_locator_finds_a_packaged_or_development_binary() {
        // On macOS the helper ships as a sidecar; elsewhere the command is not
        // exposed by the UI.
        if cfg!(target_os = "macos") {
            assert!(helper_path().is_ok(), "video helper is missing");
        }
    }
}
