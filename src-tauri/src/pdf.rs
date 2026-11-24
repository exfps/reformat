use crate::files::{
    display_name, prepare_output_dir, render_template, sanitize_stem, strip_known_extension,
    unique_output_path, validate_input_file,
};
use crate::job::{cancelled, check_cancel, emit_progress, FileError, JobOutcome, OutputFile};
use crate::media::{jpeg_for_pdf, load_for_pdf};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use tauri::AppHandle;
use tempfile::Builder as TempBuilder;

pub const MAX_PDF_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_PDF_PAGES: usize = 5_000;
const MAX_PREVIEW_BYTES: u64 = 96 * 1024 * 1024;
const MAX_SPLIT_OUTPUTS: usize = 2_000;
const INHERITED_KEYS: [&[u8]; 5] = [
    b"Resources".as_slice(),
    b"MediaBox".as_slice(),
    b"CropBox".as_slice(),
    b"Rotate".as_slice(),
    b"UserUnit".as_slice(),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInfo {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub pages: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPreview {
    pub page_count: usize,
    pub bytes: u64,
    pub data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    pub job_id: String,
    pub inputs: Vec<String>,
    pub output_dir: Option<String>,
    pub file_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitRequest {
    pub job_id: String,
    pub input: String,
    pub output_dir: Option<String>,
    pub mode: String,
    pub ranges: Option<String>,
    pub template: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderRequest {
    pub job_id: String,
    pub input: String,
    pub output_dir: Option<String>,
    pub file_name: String,
    pub order: Vec<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressRequest {
    pub job_id: String,
    pub input: String,
    pub output_dir: Option<String>,
    pub file_name: String,
    pub strip_metadata: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagesToPdfRequest {
    pub job_id: String,
    pub inputs: Vec<String>,
    pub output_dir: Option<String>,
    pub file_name: String,
    pub page_size: String,
    pub margin: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDocumentRequest {
    pub job_id: String,
    pub input: String,
    pub output_dir: Option<String>,
    pub file_name: String,
    pub format: String,
    pub ranges: Option<String>,
}

pub fn pdf_info(path: String) -> Result<PdfInfo, String> {
    let parsed = validate_input_file(&path)?;
    let bytes = fs::metadata(&parsed).map(|m| m.len()).unwrap_or(0);
    let doc = load_pdf(&path)?;
    Ok(PdfInfo {
        path: path.clone(),
        name: display_name(&path),
        bytes,
        pages: doc.get_pages().len(),
    })
}

pub fn read_pdf_preview(path: String) -> Result<PdfPreview, String> {
    let parsed = validate_input_file(&path)?;
    let doc = load_pdf(&path)?;
    let bytes = fs::metadata(&parsed)
        .map_err(|e| format!("Couldn't inspect the PDF: {e}"))?
        .len();
    if bytes > MAX_PREVIEW_BYTES {
        return Err(
            "This PDF is too large to preview here. You can still merge, split, or compress it."
                .to_string(),
        );
    }
    let data = fs::read(&parsed).map_err(|e| format!("Couldn't read the PDF: {e}"))?;
    Ok(PdfPreview {
        page_count: doc.get_pages().len(),
        bytes,
        data: BASE64.encode(data),
    })
}

fn load_pdf(path: &str) -> Result<Document, String> {
    let parsed = validate_input_file(path)?;
    let size = fs::metadata(&parsed)
        .map_err(|e| format!("Couldn't inspect {}: {e}", display_name(path)))?
        .len();
    if size > MAX_PDF_BYTES {
        return Err(format!(
            "{} is larger than 512 MB. That's beyond Reformat's safe working limit.",
            display_name(path)
        ));
    }
    if size < 8 {
        return Err(format!("{} isn't a PDF.", display_name(path)));
    }
    let doc = Document::load(&parsed).map_err(|_| {
        format!(
            "{} couldn't be read. It may be damaged, encrypted, or not a PDF.",
            display_name(path)
        )
    })?;
    if doc.is_encrypted() {
        return Err(format!(
            "{} is password-protected. Unlock it before bringing it into Reformat.",
            display_name(path)
        ));
    }
    let page_count = doc.get_pages().len();
    if page_count == 0 {
        return Err(format!("{} doesn't contain any pages.", display_name(path)));
    }
    if page_count > MAX_PDF_PAGES {
        return Err(format!(
            "{} has {page_count} pages. Reformat handles up to {MAX_PDF_PAGES} pages per file.",
            display_name(path)
        ));
    }
    Ok(doc)
}

fn materialize_inherited(doc: &mut Document) -> Result<(), String> {
    let pages: Vec<ObjectId> = doc.page_iter().collect();
    for page_id in pages {
        let page_dict = doc
            .get_dictionary(page_id)
            .map_err(|_| "The PDF has a damaged page tree.".to_string())?
            .clone();
        let mut inherited: Vec<(Vec<u8>, Object)> = Vec::new();
        let mut parent = page_dict
            .get(b"Parent")
            .ok()
            .and_then(|object| object.as_reference().ok());
        let mut seen = HashSet::new();
        while let Some(parent_id) = parent {
            if !seen.insert(parent_id) {
                break;
            }
            let Ok(parent_dict) = doc.get_dictionary(parent_id) else {
                break;
            };
            for key in INHERITED_KEYS {
                if page_dict.has(key) {
                    continue;
                }
                if inherited
                    .iter()
                    .any(|(existing, _)| existing.as_slice() == key)
                {
                    continue;
                }
                if let Ok(value) = parent_dict.get(key) {
                    inherited.push((key.to_vec(), value.clone()));
                }
            }
            parent = parent_dict
                .get(b"Parent")
                .ok()
                .and_then(|object| object.as_reference().ok());
        }
        let page_mut = doc
            .get_dictionary_mut(page_id)
            .map_err(|_| "The PDF has a damaged page tree.".to_string())?;
        for (key, value) in inherited {
            if !page_mut.has(&key) {
                page_mut.set(key, value);
            }
        }
    }
    Ok(())
}

fn rebuild_page_tree(doc: &mut Document, ordered: &[ObjectId]) -> Result<(), String> {
    let pages_id = doc
        .catalog()
        .and_then(|catalog| catalog.get(b"Pages"))
        .and_then(Object::as_reference)
        .map_err(|_| "The PDF's page tree is missing.".to_string())?;
    let mut pages_dict = doc
        .get_dictionary(pages_id)
        .map_err(|_| "The PDF's page tree is damaged.".to_string())?
        .clone();
    pages_dict.set("Type", "Pages");
    pages_dict.set(
        "Kids",
        Object::Array(
            ordered
                .iter()
                .map(|id| Object::Reference(*id))
                .collect::<Vec<_>>(),
        ),
    );
    pages_dict.set("Count", ordered.len() as i64);
    pages_dict.remove(b"Parent");
    doc.set_object(pages_id, Object::Dictionary(pages_dict));
    for page_id in ordered {
        let page = doc
            .get_dictionary_mut(*page_id)
            .map_err(|_| "The PDF has a damaged page reference.".to_string())?;
        page.set("Parent", Object::Reference(pages_id));
    }
    doc.prune_objects();
    doc.renumber_objects();
    Ok(())
}

fn save_pdf(doc: &mut Document, target: &Path, token: &AtomicBool) -> Result<u64, String> {
    check_cancel(token)?;
    let dir = target
        .parent()
        .ok_or_else(|| "The output folder is invalid.".to_string())?;
    let mut temp = TempBuilder::new()
        .prefix(".reformat-")
        .suffix(".part")
        .tempfile_in(dir)
        .map_err(|e| format!("Couldn't create a temporary file: {e}"))?;
    doc.save_to(temp.as_file_mut())
        .map_err(|e| format!("Couldn't write the PDF: {e}"))?;
    temp.as_file_mut()
        .flush()
        .map_err(|e| format!("Couldn't finish writing the PDF: {e}"))?;
    check_cancel(token)?;
    let persisted = temp
        .persist_noclobber(target)
        .map_err(|e| format!("Couldn't save {}: {}", target.display(), e.error))?;
    Ok(persisted
        .metadata()
        .map_err(|e| format!("Couldn't inspect the saved PDF: {e}"))?
        .len())
}

fn target_for(
    source: &Path,
    output_dir: Option<&str>,
    requested: &str,
    fallback: &str,
    token: &AtomicBool,
) -> Result<PathBuf, String> {
    check_cancel(token)?;
    let dir = prepare_output_dir(source, output_dir)?;
    let name = if requested.trim().is_empty() {
        fallback.to_string()
    } else {
        requested.to_string()
    };
    let stem = sanitize_stem(&strip_known_extension(name.trim()), fallback);
    Ok(unique_output_path(&dir, &stem, "pdf"))
}

fn output_from(target: &Path, source: &str, bytes: u64, pages: usize) -> OutputFile {
    OutputFile {
        path: target.to_string_lossy().into_owned(),
        name: target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "document.pdf".to_string()),
        source_path: source.to_string(),
        bytes,
        width: None,
        height: None,
        pages: Some(pages),
    }
}

#[allow(clippy::too_many_arguments)]
fn cancelled_job(
    app: Option<&AppHandle>,
    job_id: &str,
    tool: &str,
    total: usize,
    completed: usize,
    outputs: Vec<OutputFile>,
    errors: Vec<FileError>,
    started: Instant,
) -> JobOutcome {
    emit_progress(app, job_id, tool, total, completed, None, "cancelled");
    JobOutcome {
        job_id: job_id.to_string(),
        outputs,
        errors,
        cancelled: true,
        elapsed_ms: started.elapsed().as_millis(),
    }
}

pub fn run_merge(
    app: Option<&AppHandle>,
    token: std::sync::Arc<AtomicBool>,
    request: MergeRequest,
) -> Result<JobOutcome, String> {
    let started = Instant::now();
    if request.inputs.len() < 2 {
        return Err("Add at least two PDFs to merge.".to_string());
    }
    let total = request.inputs.len();
    emit_progress(
        app,
        &request.job_id,
        "pdf-merge",
        total,
        0,
        request.inputs.first().cloned(),
        "running",
    );

    let mut base = load_pdf(&request.inputs[0])?;
    materialize_inherited(&mut base)?;
    let mut ordered: Vec<ObjectId> = base.page_iter().collect();

    for (index, path) in request.inputs.iter().enumerate().skip(1) {
        if cancelled(&token) {
            return Ok(cancelled_job(
                app,
                &request.job_id,
                "pdf-merge",
                total,
                index,
                vec![],
                vec![],
                started,
            ));
        }
        let mut doc = load_pdf(path)?;
        materialize_inherited(&mut doc)?;
        let starting_id = base
            .max_id
            .checked_add(1)
            .ok_or_else(|| "This PDF is too complex to merge.".to_string())?;
        doc.renumber_objects_with(starting_id);
        let page_ids: Vec<ObjectId> = doc.page_iter().collect();
        ordered.extend(page_ids);
        let imported_max = doc.max_id;
        base.objects.extend(std::mem::take(&mut doc.objects));
        base.max_id = base.max_id.max(imported_max);
        emit_progress(
            app,
            &request.job_id,
            "pdf-merge",
            total,
            index,
            request.inputs.get(index + 1).cloned(),
            "running",
        );
    }
    if cancelled(&token) {
        return Ok(cancelled_job(
            app,
            &request.job_id,
            "pdf-merge",
            total,
            total,
            vec![],
            vec![],
            started,
        ));
    }
    rebuild_page_tree(&mut base, &ordered)?;
    base.compress();
    if cancelled(&token) {
        return Ok(cancelled_job(
            app,
            &request.job_id,
            "pdf-merge",
            total,
            total,
            vec![],
            vec![],
            started,
        ));
    }

    let source = Path::new(&request.inputs[0]);
    let target = match target_for(
        source,
        request.output_dir.as_deref(),
        &request.file_name,
        "merged",
        &token,
    ) {
        Ok(target) => target,
        Err(error) if error == "Cancelled" => {
            return Ok(cancelled_job(
                app,
                &request.job_id,
                "pdf-merge",
                total,
                total,
                vec![],
                vec![],
                started,
            ))
        }
        Err(error) => return Err(error),
    };
    let bytes = match save_pdf(&mut base, &target, &token) {
        Ok(bytes) => bytes,
        Err(error) if error == "Cancelled" => {
            return Ok(cancelled_job(
                app,
                &request.job_id,
                "pdf-merge",
                total,
                total,
                vec![],
                vec![],
                started,
            ))
        }
        Err(error) => return Err(error),
    };
    let total_pages = ordered.len();
    emit_progress(
        app,
        &request.job_id,
        "pdf-merge",
        total,
        total,
        None,
        "finished",
    );
    Ok(JobOutcome {
        job_id: request.job_id,
        outputs: vec![output_from(&target, &request.inputs[0], bytes, total_pages)],
        errors: vec![],
        cancelled: false,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn parse_ranges(input: &str, page_count: usize) -> Result<Vec<(u32, u32)>, String> {
    let normalized = input.replace(['–', '—'], "-");
    let mut ranges = Vec::new();
    for piece in normalized.split([',', ';']) {
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        let (start, end) = if let Some((left, right)) = piece.split_once('-') {
            let start = left
                .trim()
                .parse::<u32>()
                .map_err(|_| format!("“{piece}” isn't a valid page range."))?;
            let end = if right.trim().is_empty() {
                page_count as u32
            } else {
                right
                    .trim()
                    .parse::<u32>()
                    .map_err(|_| format!("“{piece}” isn't a valid page range."))?
            };
            (start, end)
        } else {
            let page = piece
                .parse::<u32>()
                .map_err(|_| format!("“{piece}” isn't a valid page range."))?;
            (page, page)
        };
        if start == 0 || end == 0 {
            return Err("Pages are numbered from 1.".to_string());
        }
        if start > end {
            return Err(format!("“{piece}” runs backwards. Use {end}-{start}."));
        }
        if end as usize > page_count {
            return Err(format!(
                "Page {end} doesn't exist. This PDF has {page_count} pages."
            ));
        }
        ranges.push((start, end));
    }
    if ranges.is_empty() {
        return Err("Enter at least one page or range.".to_string());
    }
    if ranges.len() > MAX_SPLIT_OUTPUTS {
        return Err(format!(
            "That would create {} files. Reformat caps a split at {MAX_SPLIT_OUTPUTS}.",
            ranges.len()
        ));
    }
    Ok(ranges)
}

pub fn run_split(
    app: Option<&AppHandle>,
    token: std::sync::Arc<AtomicBool>,
    request: SplitRequest,
) -> Result<JobOutcome, String> {
    let started = Instant::now();
    let source = load_pdf(&request.input)?;
    let page_count = source.get_pages().len();
    let ranges = if request.mode == "every" {
        (1..=page_count as u32).map(|p| (p, p)).collect::<Vec<_>>()
    } else {
        parse_ranges(request.ranges.as_deref().unwrap_or(""), page_count)?
    };
    if ranges.len() > MAX_SPLIT_OUTPUTS {
        return Err(format!(
            "That would create {} files. Reformat caps a split at {MAX_SPLIT_OUTPUTS}.",
            ranges.len()
        ));
    }
    let digits = page_count.to_string().len().max(2);
    let default_template = if request.mode == "every" {
        format!("{{name}}-page-{{page:0{digits}}}")
    } else {
        "{name}-pages-{range}".to_string()
    };
    // `{page:0N}` is not one of our template tokens; render the padded page
    // number directly instead.
    let default_template = default_template.replace(&format!("{{page:0{digits}}}"), "{page}");
    let template = request
        .template
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(&default_template)
        .to_string();
    let source_stem = Path::new(&request.input)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".to_string());
    let source_path = Path::new(&request.input);
    let output_dir = prepare_output_dir(source_path, request.output_dir.as_deref())?;
    let total = ranges.len();
    let mut outputs = Vec::new();
    let mut errors = Vec::new();
    emit_progress(
        app,
        &request.job_id,
        "pdf-split",
        total,
        0,
        Some(display_name(&request.input)),
        "running",
    );

    for (index, (start, end)) in ranges.iter().enumerate() {
        if cancelled(&token) {
            emit_progress(
                app,
                &request.job_id,
                "pdf-split",
                total,
                index,
                None,
                "cancelled",
            );
            return Ok(JobOutcome {
                job_id: request.job_id,
                outputs,
                errors,
                cancelled: true,
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
        let keep: HashSet<u32> = (*start..=*end).collect();
        let page_token = if start == end {
            format!("{start:0digits$}")
        } else {
            format!("{start:0digits$}-{end:0digits$}")
        };
        let range_token = if start == end {
            start.to_string()
        } else {
            format!("{start}-{end}")
        };
        let stem = sanitize_stem(
            &strip_known_extension(&render_template(
                &template,
                &[
                    ("name", source_stem.clone()),
                    ("page", page_token),
                    ("range", range_token),
                    ("index", (index + 1).to_string()),
                ],
            )),
            &source_stem,
        );
        let target = unique_output_path(&output_dir, &stem, "pdf");
        let result = (|| -> Result<OutputFile, String> {
            let mut doc = source.clone();
            let remove: Vec<u32> = (1..=page_count as u32)
                .filter(|page| !keep.contains(page))
                .collect();
            if !remove.is_empty() {
                doc.delete_pages(&remove);
            }
            doc.prune_objects();
            doc.renumber_objects();
            doc.compress();
            check_cancel(&token)?;
            let bytes = save_pdf(&mut doc, &target, &token)?;
            Ok(output_from(
                &target,
                &request.input,
                bytes,
                (*end - *start + 1) as usize,
            ))
        })();
        match result {
            Ok(output) => outputs.push(output),
            Err(error) if error == "Cancelled" => {
                emit_progress(
                    app,
                    &request.job_id,
                    "pdf-split",
                    total,
                    index,
                    None,
                    "cancelled",
                );
                return Ok(JobOutcome {
                    job_id: request.job_id,
                    outputs,
                    errors,
                    cancelled: true,
                    elapsed_ms: started.elapsed().as_millis(),
                });
            }
            Err(error) => errors.push(FileError {
                path: request.input.clone(),
                name: target
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "split.pdf".to_string()),
                message: error,
            }),
        }
        emit_progress(
            app,
            &request.job_id,
            "pdf-split",
            total,
            index + 1,
            None,
            "running",
        );
    }
    emit_progress(
        app,
        &request.job_id,
        "pdf-split",
        total,
        total,
        None,
        "finished",
    );
    Ok(JobOutcome {
        job_id: request.job_id,
        outputs,
        errors,
        cancelled: false,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

pub fn run_reorder(
    app: Option<&AppHandle>,
    token: std::sync::Arc<AtomicBool>,
    request: ReorderRequest,
) -> Result<JobOutcome, String> {
    let started = Instant::now();
    let mut doc = load_pdf(&request.input)?;
    materialize_inherited(&mut doc)?;
    let pages = doc.get_pages();
    if request.order.len() != pages.len() {
        return Err("The new page order is incomplete.".to_string());
    }
    let mut seen = HashSet::new();
    for page in &request.order {
        if !seen.insert(*page) || !pages.contains_key(page) {
            return Err("The new page order isn't valid.".to_string());
        }
    }
    let ordered: Vec<ObjectId> = request
        .order
        .iter()
        .filter_map(|page| pages.get(page).copied())
        .collect();
    emit_progress(
        app,
        &request.job_id,
        "pdf-organize",
        1,
        0,
        Some(display_name(&request.input)),
        "running",
    );
    if cancelled(&token) {
        return Ok(cancelled_job(
            app,
            &request.job_id,
            "pdf-organize",
            1,
            0,
            vec![],
            vec![],
            started,
        ));
    }
    rebuild_page_tree(&mut doc, &ordered)?;
    doc.compress();
    if cancelled(&token) {
        return Ok(cancelled_job(
            app,
            &request.job_id,
            "pdf-organize",
            1,
            0,
            vec![],
            vec![],
            started,
        ));
    }
    let target = match target_for(
        Path::new(&request.input),
        request.output_dir.as_deref(),
        &request.file_name,
        "reordered",
        &token,
    ) {
        Ok(target) => target,
        Err(error) if error == "Cancelled" => {
            return Ok(cancelled_job(
                app,
                &request.job_id,
                "pdf-organize",
                1,
                0,
                vec![],
                vec![],
                started,
            ))
        }
        Err(error) => return Err(error),
    };
    let bytes = match save_pdf(&mut doc, &target, &token) {
        Ok(bytes) => bytes,
        Err(error) if error == "Cancelled" => {
            return Ok(cancelled_job(
                app,
                &request.job_id,
                "pdf-organize",
                1,
                0,
                vec![],
                vec![],
                started,
            ))
        }
        Err(error) => return Err(error),
    };
    emit_progress(app, &request.job_id, "pdf-organize", 1, 1, None, "finished");
    Ok(JobOutcome {
        job_id: request.job_id,
        outputs: vec![output_from(&target, &request.input, bytes, ordered.len())],
        errors: vec![],
        cancelled: false,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

pub fn run_compress(
    app: Option<&AppHandle>,
    token: std::sync::Arc<AtomicBool>,
    request: CompressRequest,
) -> Result<JobOutcome, String> {
    let started = Instant::now();
    let mut doc = load_pdf(&request.input)?;
    let pages = doc.get_pages().len();
    emit_progress(
        app,
        &request.job_id,
        "pdf-compress",
        1,
        0,
        Some(display_name(&request.input)),
        "running",
    );
    if cancelled(&token) {
        return Ok(cancelled_job(
            app,
            &request.job_id,
            "pdf-compress",
            1,
            0,
            vec![],
            vec![],
            started,
        ));
    }
    if request.strip_metadata {
        doc.trailer.remove(b"Info");
        if let Ok(catalog) = doc.catalog_mut() {
            catalog.remove(b"Metadata");
            catalog.remove(b"PieceInfo");
        }
    }
    doc.prune_objects();
    doc.compress();
    if cancelled(&token) {
        return Ok(cancelled_job(
            app,
            &request.job_id,
            "pdf-compress",
            1,
            0,
            vec![],
            vec![],
            started,
        ));
    }
    let target = match target_for(
        Path::new(&request.input),
        request.output_dir.as_deref(),
        &request.file_name,
        "compressed",
        &token,
    ) {
        Ok(target) => target,
        Err(error) if error == "Cancelled" => {
            return Ok(cancelled_job(
                app,
                &request.job_id,
                "pdf-compress",
                1,
                0,
                vec![],
                vec![],
                started,
            ))
        }
        Err(error) => return Err(error),
    };
    let bytes = match save_pdf(&mut doc, &target, &token) {
        Ok(bytes) => bytes,
        Err(error) if error == "Cancelled" => {
            return Ok(cancelled_job(
                app,
                &request.job_id,
                "pdf-compress",
                1,
                0,
                vec![],
                vec![],
                started,
            ))
        }
        Err(error) => return Err(error),
    };
    emit_progress(app, &request.job_id, "pdf-compress", 1, 1, None, "finished");
    Ok(JobOutcome {
        job_id: request.job_id,
        outputs: vec![output_from(&target, &request.input, bytes, pages)],
        errors: vec![],
        cancelled: false,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn layout(
    page_size: &str,
    image_width: u32,
    image_height: u32,
    margin: f32,
) -> Result<(f32, f32, f32, f32, f32, f32), String> {
    let margin = margin.clamp(0.0, 144.0);
    let iw = image_width as f32;
    let ih = image_height as f32;
    if iw <= 0.0 || ih <= 0.0 {
        return Err("An image has an empty area.".to_string());
    }
    let (page_w, page_h) = match page_size {
        "a4" => (595.28, 841.89),
        "letter" => (612.0, 792.0),
        "fit" => {
            let max_side = 1200.0f32;
            let base_scale = (0.75f32).min(max_side / iw).min(max_side / ih);
            let draw_w = (iw * base_scale).max(1.0);
            let draw_h = (ih * base_scale).max(1.0);
            return Ok((
                draw_w + margin * 2.0,
                draw_h + margin * 2.0,
                draw_w,
                draw_h,
                margin,
                margin,
            ));
        }
        other => return Err(format!("Unknown page size: {other}")),
    };
    let available_w = (page_w - margin * 2.0).max(1.0);
    let available_h = (page_h - margin * 2.0).max(1.0);
    let scale = f32::min(available_w / iw, available_h / ih);
    let draw_w = (iw * scale).max(0.1);
    let draw_h = (ih * scale).max(0.1);
    let x = (page_w - draw_w) / 2.0;
    let y = (page_h - draw_h) / 2.0;
    Ok((page_w, page_h, draw_w, draw_h, x, y))
}

pub fn run_images_to_pdf(
    app: Option<&AppHandle>,
    token: std::sync::Arc<AtomicBool>,
    request: ImagesToPdfRequest,
) -> Result<JobOutcome, String> {
    let started = Instant::now();
    if request.inputs.is_empty() {
        return Err("Add at least one image.".to_string());
    }
    if request.inputs.len() > 500 {
        return Err("Reformat can place up to 500 images in one PDF.".to_string());
    }
    let total = request.inputs.len();
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let catalog_id = doc.new_object_id();
    let mut kids: Vec<Object> = Vec::new();
    let mut errors: Vec<FileError> = Vec::new();

    emit_progress(
        app,
        &request.job_id,
        "images-to-pdf",
        total,
        0,
        request.inputs.first().cloned(),
        "running",
    );

    for (index, input) in request.inputs.iter().enumerate() {
        if cancelled(&token) {
            emit_progress(
                app,
                &request.job_id,
                "images-to-pdf",
                total,
                index,
                None,
                "cancelled",
            );
            return Ok(JobOutcome {
                job_id: request.job_id,
                outputs: vec![],
                errors,
                cancelled: true,
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
        let result = (|| -> Result<(), String> {
            let image = load_for_pdf(input)?;
            let (page_w, page_h, draw_w, draw_h, x, y) = layout(
                &request.page_size,
                image.width(),
                image.height(),
                request.margin,
            )?;
            let jpeg = jpeg_for_pdf(&image, 88)?;
            let mut image_dict = Dictionary::new();
            image_dict.set("Type", "XObject");
            image_dict.set("Subtype", "Image");
            image_dict.set("Width", image.width() as i64);
            image_dict.set("Height", image.height() as i64);
            image_dict.set("ColorSpace", "DeviceRGB");
            image_dict.set("BitsPerComponent", 8);
            image_dict.set("Filter", "DCTDecode");
            let image_id = doc.add_object(Object::Stream(
                Stream::new(image_dict, jpeg).with_compression(false),
            ));
            let content = format!("q {draw_w:.3} 0 0 {draw_h:.3} {x:.3} {y:.3} cm /Im0 Do Q");
            let content_id = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                content.into_bytes(),
            )));
            let mut xobject = Dictionary::new();
            xobject.set("Im0", Object::Reference(image_id));
            let mut resources = Dictionary::new();
            resources.set("XObject", Object::Dictionary(xobject));
            let mut page = Dictionary::new();
            page.set("Type", "Page");
            page.set("Parent", Object::Reference(pages_id));
            page.set(
                "MediaBox",
                Object::Array(vec![
                    Object::Real(0.0),
                    Object::Real(0.0),
                    Object::Real(page_w),
                    Object::Real(page_h),
                ]),
            );
            page.set("Resources", Object::Dictionary(resources));
            page.set("Contents", Object::Reference(content_id));
            let page_id = doc.add_object(Object::Dictionary(page));
            kids.push(Object::Reference(page_id));
            Ok(())
        })();
        match result {
            Ok(()) => {}
            Err(error) => errors.push(FileError {
                path: input.clone(),
                name: display_name(input),
                message: error,
            }),
        }
        emit_progress(
            app,
            &request.job_id,
            "images-to-pdf",
            total,
            index + 1,
            request.inputs.get(index + 1).cloned(),
            "running",
        );
    }

    if kids.is_empty() {
        emit_progress(
            app,
            &request.job_id,
            "images-to-pdf",
            total,
            total,
            None,
            "failed",
        );
        let detail = errors
            .first()
            .map(|e| format!(" {}", e.message))
            .unwrap_or_default();
        return Err(format!(
            "None of those images could be added to a PDF.{detail}"
        ));
    }

    let mut pages_dict = Dictionary::new();
    pages_dict.set("Type", "Pages");
    pages_dict.set("Kids", Object::Array(kids.clone()));
    pages_dict.set("Count", kids.len() as i64);
    doc.set_object(pages_id, Object::Dictionary(pages_dict));
    let mut catalog = Dictionary::new();
    catalog.set("Type", "Catalog");
    catalog.set("Pages", Object::Reference(pages_id));
    doc.set_object(catalog_id, Object::Dictionary(catalog));
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc.compress();
    if cancelled(&token) {
        return Ok(cancelled_job(
            app,
            &request.job_id,
            "images-to-pdf",
            total,
            total,
            vec![],
            errors,
            started,
        ));
    }

    let target = match target_for(
        Path::new(&request.inputs[0]),
        request.output_dir.as_deref(),
        &request.file_name,
        "images",
        &token,
    ) {
        Ok(target) => target,
        Err(error) if error == "Cancelled" => {
            return Ok(cancelled_job(
                app,
                &request.job_id,
                "images-to-pdf",
                total,
                total,
                vec![],
                errors,
                started,
            ))
        }
        Err(error) => return Err(error),
    };
    let bytes = match save_pdf(&mut doc, &target, &token) {
        Ok(bytes) => bytes,
        Err(error) if error == "Cancelled" => {
            return Ok(cancelled_job(
                app,
                &request.job_id,
                "images-to-pdf",
                total,
                total,
                vec![],
                errors,
                started,
            ))
        }
        Err(error) => return Err(error),
    };
    emit_progress(
        app,
        &request.job_id,
        "images-to-pdf",
        total,
        total,
        None,
        "finished",
    );
    Ok(JobOutcome {
        job_id: request.job_id,
        outputs: vec![output_from(&target, &request.inputs[0], bytes, kids.len())],
        errors,
        cancelled: false,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn write_bytes_atomically(target: &Path, bytes: &[u8], token: &AtomicBool) -> Result<u64, String> {
    check_cancel(token)?;
    let dir = target
        .parent()
        .ok_or_else(|| "The output folder is invalid.".to_string())?;
    let mut temp = TempBuilder::new()
        .prefix(".reformat-")
        .suffix(".part")
        .tempfile_in(dir)
        .map_err(|e| format!("Couldn't create a temporary file: {e}"))?;
    temp.as_file_mut()
        .write_all(bytes)
        .map_err(|e| format!("Couldn't write the exported document: {e}"))?;
    temp.as_file_mut()
        .flush()
        .map_err(|e| format!("Couldn't finish writing the exported document: {e}"))?;
    check_cancel(token)?;
    let persisted = temp
        .persist_noclobber(target)
        .map_err(|e| format!("Couldn't save {}: {}", target.display(), e.error))?;
    Ok(persisted
        .metadata()
        .map_err(|e| format!("Couldn't inspect the saved document: {e}"))?
        .len())
}

fn docx_for_pages(pages: &[(u32, String)]) -> Result<Vec<u8>, String> {
    use docx_rs::{BreakType, Docx, Paragraph, Run};

    let mut docx = Docx::new();
    let mut has_content = false;
    for (index, (_, text)) in pages.iter().enumerate() {
        let cleaned = text.replace('\u{000c}', "\n\n");
        let mut wrote_any = false;
        for line in cleaned.lines() {
            let line = line.trim_end();
            if line.trim().is_empty() {
                if wrote_any {
                    docx = docx.add_paragraph(Paragraph::new());
                }
                continue;
            }
            if !wrote_any && index > 0 {
                docx = docx
                    .add_paragraph(Paragraph::new().add_run(Run::new().add_break(BreakType::Page)));
            }
            docx =
                docx.add_paragraph(Paragraph::new().add_run(Run::new().add_text(line.to_string())));
            wrote_any = true;
            has_content = true;
        }
        if index > 0 && !wrote_any {
            docx =
                docx.add_paragraph(Paragraph::new().add_run(Run::new().add_break(BreakType::Page)));
        }
    }
    if !has_content {
        return Err("No selectable text was found in this PDF. It may be a scan or use fonts that can't be read; OCR is needed.".to_string());
    }
    let mut bytes = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut bytes);
    docx.pack(&mut cursor)
        .map_err(|e| format!("Couldn't prepare the Word document: {e}"))?;
    Ok(bytes)
}

pub fn run_export_document(
    app: Option<&AppHandle>,
    token: std::sync::Arc<AtomicBool>,
    request: ExportDocumentRequest,
) -> Result<JobOutcome, String> {
    let started = Instant::now();
    let format = request.format.to_ascii_lowercase();
    if format != "txt" && format != "docx" {
        return Err("Choose text or Word as the export format.".to_string());
    }
    let doc = load_pdf(&request.input)?;
    let page_count = doc.get_pages().len();
    let page_numbers: Vec<u32> = match request.ranges.as_deref().filter(|r| !r.trim().is_empty()) {
        Some(ranges) => parse_ranges(ranges, page_count)?
            .into_iter()
            .flat_map(|(start, end)| start..=end)
            .collect(),
        None => (1..=page_count as u32).collect(),
    };
    if page_numbers.is_empty() {
        return Err("Choose at least one page to export.".to_string());
    }
    emit_progress(
        app,
        &request.job_id,
        "pdf-export",
        1,
        0,
        Some(display_name(&request.input)),
        "running",
    );
    if cancelled(&token) {
        return Ok(cancelled_job(
            app,
            &request.job_id,
            "pdf-export",
            1,
            0,
            vec![],
            vec![],
            started,
        ));
    }
    let chunks = doc.extract_text_chunks_with_limit(&page_numbers, 64 * 1024 * 1024);
    let pages: Vec<(u32, String)> = page_numbers
        .iter()
        .zip(chunks)
        .map(|(page, chunk)| {
            chunk
                .map(|text| (*page, text))
                .map_err(|_| format!("Text on page {page} couldn't be read."))
        })
        .collect::<Result<_, _>>()?;
    if pages.iter().all(|(_, text)| text.trim().is_empty()) {
        return Err("No selectable text was found. This looks like a scanned PDF, which needs OCR before exporting.".to_string());
    }
    if cancelled(&token) {
        return Ok(cancelled_job(
            app,
            &request.job_id,
            "pdf-export",
            1,
            0,
            vec![],
            vec![],
            started,
        ));
    }
    let source = Path::new(&request.input);
    let source_stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".to_string());
    let ext = if format == "docx" { "docx" } else { "txt" };
    let requested_name = if request.file_name.trim().is_empty() {
        format!("{source_stem}.{ext}")
    } else {
        request.file_name.clone()
    };
    let stem = sanitize_stem(&strip_known_extension(&requested_name), &source_stem);
    let target = prepare_output_dir(source, request.output_dir.as_deref())
        .map(|dir| unique_output_path(&dir, &stem, ext))?;
    let bytes = if format == "txt" {
        let content = pages
            .iter()
            .map(|(_, text)| text.trim_end())
            .collect::<Vec<_>>()
            .join("\n\n");
        write_bytes_atomically(&target, content.as_bytes(), &token)
    } else {
        let docx_bytes = docx_for_pages(&pages)?;
        write_bytes_atomically(&target, &docx_bytes, &token)
    };
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(error) if error == "Cancelled" => {
            return Ok(cancelled_job(
                app,
                &request.job_id,
                "pdf-export",
                1,
                0,
                vec![],
                vec![],
                started,
            ))
        }
        Err(error) => return Err(error),
    };
    emit_progress(app, &request.job_id, "pdf-export", 1, 1, None, "finished");
    Ok(JobOutcome {
        job_id: request.job_id,
        outputs: vec![output_from(
            &target,
            &request.input,
            bytes,
            page_numbers.len(),
        )],
        errors: vec![],
        cancelled: false,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn make_pdf(path: &Path, page_count: u32) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut kids = Vec::new();
        for index in 0..page_count {
            let content_id = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                format!("q Q % page {index}").into_bytes(),
            )));
            let mut page = Dictionary::new();
            page.set("Type", "Page");
            page.set("Parent", Object::Reference(pages_id));
            page.set(
                "MediaBox",
                Object::Array(vec![
                    Object::Integer(0),
                    Object::Integer(0),
                    Object::Integer(100),
                    Object::Integer(100 + index as i64),
                ]),
            );
            page.set("Contents", Object::Reference(content_id));
            let page_id = doc.add_object(Object::Dictionary(page));
            kids.push(Object::Reference(page_id));
        }
        let mut pages = Dictionary::new();
        pages.set("Type", "Pages");
        pages.set("Kids", Object::Array(kids));
        pages.set("Count", page_count as i64);
        doc.set_object(pages_id, Object::Dictionary(pages));
        let catalog_id = doc.new_object_id();
        let mut catalog = Dictionary::new();
        catalog.set("Type", "Catalog");
        catalog.set("Pages", Object::Reference(pages_id));
        doc.set_object(catalog_id, Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(catalog_id));
        doc.save(path).unwrap();
    }

    fn page_heights(path: &Path) -> Vec<i64> {
        let doc = Document::load(path).unwrap();
        doc.get_pages()
            .values()
            .map(|id| {
                doc.get_dictionary(*id)
                    .unwrap()
                    .get(b"MediaBox")
                    .unwrap()
                    .as_array()
                    .unwrap()[3]
                    .as_i64()
                    .unwrap()
            })
            .collect()
    }

    #[test]
    fn oversized_pdfs_are_rejected_before_parsing() {
        let dir = tempdir().unwrap();
        let huge = dir.path().join("huge.pdf");
        let file = std::fs::File::create(&huge).unwrap();
        file.set_len(MAX_PDF_BYTES + 1).unwrap();
        drop(file);
        let error = pdf_info(huge.to_string_lossy().into_owned()).unwrap_err();
        assert!(error.contains("larger than 512 MB"));
    }

    #[test]
    fn merge_preserves_all_pages() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.pdf");
        let b = dir.path().join("b.pdf");
        make_pdf(&a, 2);
        make_pdf(&b, 3);
        let request = MergeRequest {
            job_id: "merge-test".into(),
            inputs: vec![
                a.to_string_lossy().into_owned(),
                b.to_string_lossy().into_owned(),
            ],
            output_dir: Some(dir.path().to_string_lossy().into_owned()),
            file_name: "merged.pdf".into(),
        };
        let outcome = run_merge(None, Arc::new(AtomicBool::new(false)), request).unwrap();
        assert_eq!(outcome.outputs.len(), 1);
        let merged = Document::load(&outcome.outputs[0].path).unwrap();
        assert_eq!(merged.get_pages().len(), 5);
        assert_eq!(outcome.outputs[0].pages, Some(5));
    }

    #[test]
    fn split_every_page_creates_valid_documents() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("source.pdf");
        make_pdf(&input, 3);
        let request = SplitRequest {
            job_id: "split-test".into(),
            input: input.to_string_lossy().into_owned(),
            output_dir: Some(dir.path().to_string_lossy().into_owned()),
            mode: "every".into(),
            ranges: None,
            template: None,
        };
        let outcome = run_split(None, Arc::new(AtomicBool::new(false)), request).unwrap();
        assert_eq!(outcome.outputs.len(), 3);
        for output in &outcome.outputs {
            let doc = Document::load(&output.path).unwrap();
            assert_eq!(doc.get_pages().len(), 1);
        }
    }

    #[test]
    fn ranges_are_parsed_and_validated() {
        assert_eq!(
            parse_ranges("1-2, 4; 6-", 6).unwrap(),
            vec![(1, 2), (4, 4), (6, 6)]
        );
        assert!(parse_ranges("0", 10).is_err());
        assert!(parse_ranges("4-2", 10).is_err());
        assert!(parse_ranges("11", 10).is_err());
    }

    #[test]
    fn reorder_changes_visual_page_order() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("source.pdf");
        make_pdf(&input, 3);
        let request = ReorderRequest {
            job_id: "reorder-test".into(),
            input: input.to_string_lossy().into_owned(),
            output_dir: Some(dir.path().to_string_lossy().into_owned()),
            file_name: "reordered.pdf".into(),
            order: vec![3, 1, 2],
        };
        let outcome = run_reorder(None, Arc::new(AtomicBool::new(false)), request).unwrap();
        let heights = page_heights(Path::new(&outcome.outputs[0].path));
        assert_eq!(heights, vec![102, 100, 101]);
    }

    #[test]
    fn compress_keeps_the_document_readable() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("source.pdf");
        make_pdf(&input, 2);
        let request = CompressRequest {
            job_id: "compress-test".into(),
            input: input.to_string_lossy().into_owned(),
            output_dir: Some(dir.path().to_string_lossy().into_owned()),
            file_name: "compressed.pdf".into(),
            strip_metadata: true,
        };
        let outcome = run_compress(None, Arc::new(AtomicBool::new(false)), request).unwrap();
        let doc = Document::load(&outcome.outputs[0].path).unwrap();
        assert_eq!(doc.get_pages().len(), 2);
    }

    #[test]
    fn corrupt_pdf_returns_an_error() {
        let dir = tempdir().unwrap();
        let bad = dir.path().join("bad.pdf");
        std::fs::write(&bad, b"%PDF-1.7\nthis is not a PDF").unwrap();
        let error = pdf_info(bad.to_string_lossy().into_owned()).unwrap_err();
        assert!(error.contains("couldn't be read") || error.contains("doesn't contain"));
    }

    #[test]
    fn images_to_pdf_creates_pages_and_skips_corrupt_inputs() {
        let dir = tempdir().unwrap();
        let good = dir.path().join("orange.png");
        let image = image::RgbImage::from_pixel(30, 20, image::Rgb([230, 110, 60]));
        image.save(&good).unwrap();
        let bad = dir.path().join("bad.png");
        std::fs::write(&bad, b"nope").unwrap();
        let request = ImagesToPdfRequest {
            job_id: "images-pdf-test".into(),
            inputs: vec![
                good.to_string_lossy().into_owned(),
                bad.to_string_lossy().into_owned(),
            ],
            output_dir: Some(dir.path().to_string_lossy().into_owned()),
            file_name: "album.pdf".into(),
            page_size: "fit".into(),
            margin: 18.0,
        };
        let outcome = run_images_to_pdf(None, Arc::new(AtomicBool::new(false)), request).unwrap();
        assert_eq!(outcome.outputs.len(), 1);
        assert_eq!(outcome.errors.len(), 1);
        let doc = Document::load(&outcome.outputs[0].path).unwrap();
        assert_eq!(doc.get_pages().len(), 1);
    }

    fn make_text_pdf(path: &Path, text: &str) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(Object::Dictionary({
            let mut font = Dictionary::new();
            font.set("Type", "Font");
            font.set("Subtype", "Type1");
            font.set("BaseFont", "Helvetica");
            font
        }));
        let escaped = text
            .replace('\\', "\\\\")
            .replace('(', "\\(")
            .replace(')', "\\)");
        let content = format!("BT /F1 24 Tf 72 700 Td ({escaped}) Tj ET");
        let content_id = doc.add_object(Object::Stream(Stream::new(
            Dictionary::new(),
            content.into_bytes(),
        )));
        let mut resources = Dictionary::new();
        let mut fonts = Dictionary::new();
        fonts.set("F1", Object::Reference(font_id));
        resources.set("Font", Object::Dictionary(fonts));
        let mut page = Dictionary::new();
        page.set("Type", "Page");
        page.set("Parent", Object::Reference(pages_id));
        page.set(
            "MediaBox",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(612),
                Object::Integer(792),
            ]),
        );
        page.set("Resources", Object::Dictionary(resources));
        page.set("Contents", Object::Reference(content_id));
        let page_id = doc.add_object(Object::Dictionary(page));
        let mut pages = Dictionary::new();
        pages.set("Type", "Pages");
        pages.set("Kids", Object::Array(vec![Object::Reference(page_id)]));
        pages.set("Count", 1_i64);
        doc.set_object(pages_id, Object::Dictionary(pages));
        let catalog_id = doc.new_object_id();
        let mut catalog = Dictionary::new();
        catalog.set("Type", "Catalog");
        catalog.set("Pages", Object::Reference(pages_id));
        doc.set_object(catalog_id, Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(catalog_id));
        doc.save(path).unwrap();
    }

    fn make_multipage_text_pdf(path: &Path, texts: &[&str]) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(Object::Dictionary({
            let mut font = Dictionary::new();
            font.set("Type", "Font");
            font.set("Subtype", "Type1");
            font.set("BaseFont", "Helvetica");
            font
        }));
        let mut page_ids = Vec::new();
        for text in texts {
            let escaped = text
                .replace('\\', "\\\\")
                .replace('(', "\\(")
                .replace(')', "\\)");
            let content = format!("BT /F1 24 Tf 72 700 Td ({escaped}) Tj ET");
            let content_id = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                content.into_bytes(),
            )));
            let mut resources = Dictionary::new();
            let mut fonts = Dictionary::new();
            fonts.set("F1", Object::Reference(font_id));
            resources.set("Font", Object::Dictionary(fonts));
            let mut page = Dictionary::new();
            page.set("Type", "Page");
            page.set("Parent", Object::Reference(pages_id));
            page.set(
                "MediaBox",
                Object::Array(vec![
                    Object::Integer(0),
                    Object::Integer(0),
                    Object::Integer(612),
                    Object::Integer(792),
                ]),
            );
            page.set("Resources", Object::Dictionary(resources));
            page.set("Contents", Object::Reference(content_id));
            page_ids.push(doc.add_object(Object::Dictionary(page)));
        }
        let mut pages = Dictionary::new();
        pages.set("Type", "Pages");
        pages.set(
            "Kids",
            Object::Array(page_ids.into_iter().map(Object::Reference).collect()),
        );
        pages.set("Count", texts.len() as i64);
        doc.set_object(pages_id, Object::Dictionary(pages));
        let catalog_id = doc.new_object_id();
        let mut catalog = Dictionary::new();
        catalog.set("Type", "Catalog");
        catalog.set("Pages", Object::Reference(pages_id));
        doc.set_object(catalog_id, Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(catalog_id));
        doc.save(path).unwrap();
    }

    #[test]
    fn exports_the_requested_pages_in_order() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("pages.pdf");
        make_multipage_text_pdf(
            &input,
            &["First page text", "Second page text", "Third page text"],
        );
        let outcome = run_export_document(
            None,
            Arc::new(AtomicBool::new(false)),
            ExportDocumentRequest {
                job_id: "pages".into(),
                input: input.to_string_lossy().into_owned(),
                output_dir: Some(dir.path().to_string_lossy().into_owned()),
                file_name: "pages.txt".into(),
                format: "txt".into(),
                ranges: Some("3, 1".into()),
            },
        )
        .unwrap();
        let text = std::fs::read_to_string(&outcome.outputs[0].path).unwrap();
        assert!(text.contains("Third page text"), "{text}");
        assert!(text.contains("First page text"), "{text}");
        assert!(!text.contains("Second page text"), "{text}");
        let third = text.find("Third page text").unwrap();
        let first = text.find("First page text").unwrap();
        assert!(third < first, "{text}");
    }

    #[test]
    fn exports_pdf_text_to_txt_and_docx() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("speech.pdf");
        make_text_pdf(&input, "Hello PDF readers");
        for (format, extension) in [("txt", "txt"), ("docx", "docx")] {
            let outcome = run_export_document(
                None,
                Arc::new(AtomicBool::new(false)),
                ExportDocumentRequest {
                    job_id: format!("export-{format}"),
                    input: input.to_string_lossy().into_owned(),
                    output_dir: Some(dir.path().to_string_lossy().into_owned()),
                    file_name: format!("speech.{extension}"),
                    format: format.into(),
                    ranges: None,
                },
            )
            .unwrap();
            assert_eq!(outcome.outputs.len(), 1);
            assert_eq!(outcome.outputs[0].name, format!("speech.{extension}"));
            let output = Path::new(&outcome.outputs[0].path);
            assert!(output.exists());
            if format == "txt" {
                let text = std::fs::read_to_string(output).unwrap();
                assert!(text.contains("Hello PDF readers"), "{text}");
            } else {
                let file = std::fs::File::open(output).unwrap();
                let mut archive = zip::ZipArchive::new(file).unwrap();
                let mut document = archive.by_name("word/document.xml").unwrap();
                let mut xml = String::new();
                std::io::Read::read_to_string(&mut document, &mut xml).unwrap();
                assert!(xml.contains("Hello PDF readers"), "{xml}");
            }
        }
    }

    #[test]
    fn canceled_pdf_jobs_return_clean_outcomes() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("source.pdf");
        make_pdf(&input, 2);
        let merge = MergeRequest {
            job_id: "merge-cancel".into(),
            inputs: vec![
                input.to_string_lossy().into_owned(),
                input.to_string_lossy().into_owned(),
            ],
            output_dir: Some(dir.path().to_string_lossy().into_owned()),
            file_name: "never.pdf".into(),
        };
        let outcome = run_merge(None, Arc::new(AtomicBool::new(true)), merge).unwrap();
        assert!(outcome.cancelled);
        assert!(outcome.outputs.is_empty());

        let compress = CompressRequest {
            job_id: "compress-cancel".into(),
            input: input.to_string_lossy().into_owned(),
            output_dir: Some(dir.path().to_string_lossy().into_owned()),
            file_name: "never-compressed.pdf".into(),
            strip_metadata: true,
        };
        let outcome = run_compress(None, Arc::new(AtomicBool::new(true)), compress).unwrap();
        assert!(outcome.cancelled);
        assert!(outcome.outputs.is_empty());
    }

    #[test]
    fn merge_and_split_keep_embedded_image_resources() {
        let dir = tempdir().unwrap();
        let image_a = dir.path().join("a.png");
        let image_b = dir.path().join("b.png");
        image::RgbImage::from_pixel(60, 40, image::Rgb([235, 120, 60]))
            .save(&image_a)
            .unwrap();
        image::RgbImage::from_pixel(40, 60, image::Rgb([70, 110, 80]))
            .save(&image_b)
            .unwrap();
        let album_a = run_images_to_pdf(
            None,
            Arc::new(AtomicBool::new(false)),
            ImagesToPdfRequest {
                job_id: "album-a".into(),
                inputs: vec![
                    image_a.to_string_lossy().into_owned(),
                    image_b.to_string_lossy().into_owned(),
                ],
                output_dir: Some(dir.path().to_string_lossy().into_owned()),
                file_name: "album-a.pdf".into(),
                page_size: "a4".into(),
                margin: 18.0,
            },
        )
        .unwrap();
        let album_b = run_images_to_pdf(
            None,
            Arc::new(AtomicBool::new(false)),
            ImagesToPdfRequest {
                job_id: "album-b".into(),
                inputs: vec![image_b.to_string_lossy().into_owned()],
                output_dir: Some(dir.path().to_string_lossy().into_owned()),
                file_name: "album-b.pdf".into(),
                page_size: "fit".into(),
                margin: 0.0,
            },
        )
        .unwrap();
        let merged = run_merge(
            None,
            Arc::new(AtomicBool::new(false)),
            MergeRequest {
                job_id: "album-merge".into(),
                inputs: vec![
                    album_a.outputs[0].path.clone(),
                    album_b.outputs[0].path.clone(),
                ],
                output_dir: Some(dir.path().to_string_lossy().into_owned()),
                file_name: "album-merged.pdf".into(),
            },
        )
        .unwrap();
        let merged_doc = Document::load(&merged.outputs[0].path).unwrap();
        assert_eq!(merged_doc.get_pages().len(), 3);
        for page_id in merged_doc.get_pages().values() {
            let images = merged_doc.get_page_images(*page_id).unwrap();
            assert_eq!(images.len(), 1, "merged page lost its embedded image");
        }

        let split = run_split(
            None,
            Arc::new(AtomicBool::new(false)),
            SplitRequest {
                job_id: "album-split".into(),
                input: merged.outputs[0].path.clone(),
                output_dir: Some(dir.path().to_string_lossy().into_owned()),
                mode: "every".into(),
                ranges: None,
                template: None,
            },
        )
        .unwrap();
        assert_eq!(split.outputs.len(), 3);
        for output in split.outputs {
            let doc = Document::load(&output.path).unwrap();
            assert_eq!(doc.get_pages().len(), 1);
            let images = doc
                .get_page_images(*doc.get_pages().values().next().unwrap())
                .unwrap();
            assert_eq!(images.len(), 1, "split page lost its embedded image");
        }
    }

    #[test]
    fn cancellation_stops_before_writing() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("source.pdf");
        make_pdf(&input, 2);
        let token = Arc::new(AtomicBool::new(true));
        let request = SplitRequest {
            job_id: "split-cancel".into(),
            input: input.to_string_lossy().into_owned(),
            output_dir: Some(dir.path().to_string_lossy().into_owned()),
            mode: "every".into(),
            ranges: None,
            template: None,
        };
        let outcome = run_split(None, token.clone(), request).unwrap();
        assert!(outcome.cancelled);
        assert!(outcome.outputs.is_empty());
        assert!(token.load(Ordering::SeqCst));
    }
}
