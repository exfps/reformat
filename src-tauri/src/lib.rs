mod archive;
mod files;
mod job;
mod media;
mod pdf;
mod video;

pub use job::{JobOutcome, JobRegistry};

use archive::{
    ArchiveInspection, ArchiveJobOutcome, ArchiveTestOutcome, ArchiveTestRequest, CreateRequest,
    ExtractPlan, ExtractRequest, InspectRequest, PlanRequest,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use media::{ConvertRequest, ImageProbe};
use pdf::{
    CompressRequest, ExportDocumentRequest, ImagesToPdfRequest, MergeRequest, PdfInfo, PdfPreview,
    ReorderRequest, SplitRequest,
};
use std::panic::{catch_unwind, AssertUnwindSafe};
use tauri::{AppHandle, Manager, State};
use video::{GifRequest, VideoProbe};

fn panic_message() -> String {
    "Something unexpected happened while processing this file. The queue is still safe — try the file again or remove it.".to_string()
}

async fn blocking_job<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let joined = tauri::async_runtime::spawn_blocking(move || {
        catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| Err(panic_message()))
    })
    .await
    .map_err(|e| format!("A background worker stopped unexpectedly: {e}"))?;
    joined
}

#[tauri::command]
fn probe_images(paths: Vec<String>) -> Vec<ImageProbe> {
    catch_unwind(AssertUnwindSafe(|| media::probe_images(paths))).unwrap_or_else(|_| Vec::new())
}

#[tauri::command]
async fn convert_images(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    request: ConvertRequest,
) -> Result<JobOutcome, String> {
    let job_id = request.job_id.clone();
    let token = registry.start(&job_id);
    let result = blocking_job(move || media::run_convert(Some(&app), token, request)).await;
    registry.finish(&job_id);
    result
}

#[tauri::command]
fn cancel_job(registry: State<'_, JobRegistry>, job_id: String) -> bool {
    registry.cancel(&job_id)
}

#[tauri::command]
fn pdf_info(path: String) -> Result<PdfInfo, String> {
    catch_unwind(AssertUnwindSafe(|| pdf::pdf_info(path))).unwrap_or_else(|_| Err(panic_message()))
}

#[tauri::command]
fn read_pdf_preview(path: String) -> Result<PdfPreview, String> {
    catch_unwind(AssertUnwindSafe(|| pdf::read_pdf_preview(path)))
        .unwrap_or_else(|_| Err(panic_message()))
}

#[tauri::command]
async fn merge_pdfs(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    request: MergeRequest,
) -> Result<JobOutcome, String> {
    let job_id = request.job_id.clone();
    let token = registry.start(&job_id);
    let result = blocking_job(move || pdf::run_merge(Some(&app), token, request)).await;
    registry.finish(&job_id);
    result
}

#[tauri::command]
async fn split_pdf(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    request: SplitRequest,
) -> Result<JobOutcome, String> {
    let job_id = request.job_id.clone();
    let token = registry.start(&job_id);
    let result = blocking_job(move || pdf::run_split(Some(&app), token, request)).await;
    registry.finish(&job_id);
    result
}

#[tauri::command]
async fn reorder_pdf(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    request: ReorderRequest,
) -> Result<JobOutcome, String> {
    let job_id = request.job_id.clone();
    let token = registry.start(&job_id);
    let result = blocking_job(move || pdf::run_reorder(Some(&app), token, request)).await;
    registry.finish(&job_id);
    result
}

#[tauri::command]
async fn compress_pdf(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    request: CompressRequest,
) -> Result<JobOutcome, String> {
    let job_id = request.job_id.clone();
    let token = registry.start(&job_id);
    let result = blocking_job(move || pdf::run_compress(Some(&app), token, request)).await;
    registry.finish(&job_id);
    result
}

#[tauri::command]
async fn images_to_pdf(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    request: ImagesToPdfRequest,
) -> Result<JobOutcome, String> {
    let job_id = request.job_id.clone();
    let token = registry.start(&job_id);
    let result = blocking_job(move || pdf::run_images_to_pdf(Some(&app), token, request)).await;
    registry.finish(&job_id);
    result
}

#[tauri::command]
fn archive_inspect(request: InspectRequest) -> Result<ArchiveInspection, String> {
    catch_unwind(AssertUnwindSafe(|| archive::archive_inspect(request)))
        .unwrap_or_else(|_| Err(panic_message()))
}

#[tauri::command]
fn plan_archive_extract(request: PlanRequest) -> Result<ExtractPlan, String> {
    catch_unwind(AssertUnwindSafe(|| {
        archive::plan_archive_extraction(request)
    }))
    .unwrap_or_else(|_| Err(panic_message()))
}

#[tauri::command]
async fn create_archive(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    request: CreateRequest,
) -> Result<ArchiveJobOutcome, String> {
    let job_id = request.job_id.clone();
    let token = registry.start(&job_id);
    let result =
        blocking_job(move || archive::run_create_archive(Some(&app), token, request)).await;
    registry.finish(&job_id);
    result
}

#[tauri::command]
async fn extract_archive(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    request: ExtractRequest,
) -> Result<ArchiveJobOutcome, String> {
    let job_id = request.job_id.clone();
    let token = registry.start(&job_id);
    let result =
        blocking_job(move || archive::run_extract_archive(Some(&app), token, request)).await;
    registry.finish(&job_id);
    result
}

#[tauri::command]
async fn test_archive(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    request: ArchiveTestRequest,
) -> Result<ArchiveTestOutcome, String> {
    let job_id = request.job_id.clone();
    let token = registry.start(&job_id);
    let result = blocking_job(move || archive::run_archive_test(Some(&app), token, request)).await;
    registry.finish(&job_id);
    result
}

#[tauri::command]
fn probe_video(path: String) -> Result<VideoProbe, String> {
    catch_unwind(AssertUnwindSafe(|| video::probe_video(path)))
        .unwrap_or_else(|_| Err(panic_message()))
}

#[tauri::command]
async fn create_gif(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    request: GifRequest,
) -> Result<JobOutcome, String> {
    let job_id = request.job_id.clone();
    let token = registry.start(&job_id);
    let result = blocking_job(move || video::run_create_gif(Some(&app), token, request)).await;
    registry.finish(&job_id);
    result
}

#[tauri::command]
async fn export_document(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    request: ExportDocumentRequest,
) -> Result<JobOutcome, String> {
    let job_id = request.job_id.clone();
    let token = registry.start(&job_id);
    let result = blocking_job(move || pdf::run_export_document(Some(&app), token, request)).await;
    registry.finish(&job_id);
    result
}

#[tauri::command]
fn read_output_preview(path: String) -> Result<String, String> {
    let candidate = std::path::PathBuf::from(&path);
    let metadata = std::fs::metadata(&candidate)
        .map_err(|_| "That output file isn't on disk anymore.".to_string())?;
    if !metadata.is_file() {
        return Err("That output isn't a file.".to_string());
    }
    if metadata.len() > 40 * 1024 * 1024 {
        return Err(
            "This output is too large to preview here. Open it in Finder instead.".to_string(),
        );
    }
    let extension = candidate
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match extension.as_str() {
        "gif" => "image/gif",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return Err("This file type doesn't have an inline preview.".to_string()),
    };
    let bytes =
        std::fs::read(&candidate).map_err(|e| format!("Couldn't read the output preview: {e}"))?;
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let candidate = std::path::PathBuf::from(&path);
    if !candidate.exists() {
        return Err("That file isn't on disk anymore.".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("/usr/bin/open");
        if candidate.is_file() {
            command.arg("-R");
        }
        command.arg(&candidate);
        command
            .spawn()
            .map_err(|e| format!("Couldn't open Finder: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&candidate)
            .spawn()
            .map_err(|e| format!("Couldn't open Explorer: {e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let folder = if candidate.is_file() {
            candidate.parent().unwrap_or(&candidate).to_path_buf()
        } else {
            candidate
        };
        std::process::Command::new("xdg-open")
            .arg(folder)
            .spawn()
            .map_err(|e| format!("Couldn't open the file manager: {e}"))?;
        Ok(())
    }
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(JobRegistry::default())
        .invoke_handler(tauri::generate_handler![
            probe_images,
            convert_images,
            cancel_job,
            pdf_info,
            read_pdf_preview,
            merge_pdfs,
            split_pdf,
            reorder_pdf,
            compress_pdf,
            images_to_pdf,
            export_document,
            archive_inspect,
            plan_archive_extract,
            create_archive,
            extract_archive,
            test_archive,
            probe_video,
            create_gif,
            read_output_preview,
            reveal_in_finder,
            app_version
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Regular);
            }
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Reformat");
}
