use std::fs;
use std::path::{Path, PathBuf};

/// Keep generated file names safe and readable on macOS and across file systems.
pub fn sanitize_stem(raw: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_was_space = false;
    for ch in raw.chars() {
        let ch = if ch == '/' || ch == '\\' || ch == ':' || ch.is_control() {
            '-'
        } else {
            ch
        };
        if ch.is_whitespace() {
            if !last_was_space {
                out.push(' ');
            }
            last_was_space = true;
        } else {
            out.push(ch);
            last_was_space = false;
        }
    }
    let mut cleaned = out
        .trim()
        .trim_matches('.')
        .trim_end_matches([' ', '.'])
        .to_string();
    if cleaned.is_empty() {
        cleaned = fallback.to_string();
    }
    let mut limited: String = cleaned.chars().take(110).collect();
    limited = limited.trim_end_matches([' ', '.']).to_string();
    if limited.is_empty() {
        limited = "output".to_string();
    }
    limited
}

pub fn render_template(template: &str, tokens: &[(&str, String)]) -> String {
    let mut output = if template.trim().is_empty() {
        "{name}".to_string()
    } else {
        template.to_string()
    };
    for (key, value) in tokens {
        output = output.replace(&format!("{{{key}}}"), value);
    }
    output
}

pub fn strip_known_extension(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    for ext in [
        ".tar.bz2", ".tar.gz", ".tar.xz", ".jpeg", ".jpg", ".png", ".webp", ".pdf", ".zip", ".7z",
        ".tar", ".tgz", ".tbz2", ".txz", ".gz", ".bz2", ".xz", ".rar", ".gif", ".docx", ".txt",
    ] {
        if lower.ends_with(ext) {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    name.to_string()
}

pub fn unique_output_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let ext = ext.trim_start_matches('.');
    let base = sanitize_stem(stem, "output");
    let mut candidate = dir.join(format!("{base}.{ext}"));
    let mut counter = 2u32;
    while candidate.exists() && counter < 10_000 {
        candidate = dir.join(format!("{base}-{counter}.{ext}"));
        counter += 1;
    }
    candidate
}

pub fn prepare_output_dir(input: &Path, requested: Option<&str>) -> Result<PathBuf, String> {
    if let Some(raw) = requested {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let dir = PathBuf::from(trimmed);
            if !dir.exists() {
                fs::create_dir_all(&dir)
                    .map_err(|e| format!("Couldn't create the output folder: {e}"))?;
            }
            if !dir.is_dir() {
                return Err("The selected output destination isn't a folder.".to_string());
            }
            return Ok(dir);
        }
    }
    input
        .parent()
        .map(Path::to_path_buf)
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "Couldn't work out where to save this file.".to_string())
}

pub fn display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

pub fn validate_input_file(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let metadata = fs::metadata(&p).map_err(|_| {
        format!(
            "{} can't be read. It may have been moved or deleted.",
            display_name(path)
        )
    })?;
    if !metadata.is_file() {
        return Err(format!("{} isn't a regular file.", display_name(path)));
    }
    Ok(p)
}
