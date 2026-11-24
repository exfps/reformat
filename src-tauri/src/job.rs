use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Tracks the cancellation flag for every job that is currently running.
#[derive(Default)]
pub struct JobRegistry {
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl JobRegistry {
    pub fn start(&self, job_id: &str) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.insert(job_id.to_string(), token.clone());
        }
        token
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        if let Ok(jobs) = self.jobs.lock() {
            if let Some(token) = jobs.get(job_id) {
                token.store(true, Ordering::SeqCst);
                return true;
            }
        }
        false
    }

    pub fn finish(&self, job_id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(job_id);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub job_id: String,
    pub tool: String,
    pub total: usize,
    pub completed: usize,
    pub current: Option<String>,
    pub status: String,
}

pub fn emit_progress(
    app: Option<&AppHandle>,
    job_id: &str,
    tool: &str,
    total: usize,
    completed: usize,
    current: Option<String>,
    status: &str,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "job-progress",
            ProgressEvent {
                job_id: job_id.to_string(),
                tool: tool.to_string(),
                total,
                completed,
                current,
                status: status.to_string(),
            },
        );
    }
}

pub fn cancelled(token: &AtomicBool) -> bool {
    token.load(Ordering::SeqCst)
}

pub fn check_cancel(token: &AtomicBool) -> Result<(), String> {
    if cancelled(token) {
        Err("Cancelled".to_string())
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputFile {
    pub path: String,
    pub name: String,
    pub source_path: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileError {
    pub path: String,
    pub name: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOutcome {
    pub job_id: String,
    pub outputs: Vec<OutputFile>,
    pub errors: Vec<FileError>,
    pub cancelled: bool,
    pub elapsed_ms: u128,
}
