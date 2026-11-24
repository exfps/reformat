use crate::files::{
    display_name, prepare_output_dir, sanitize_stem, strip_known_extension, unique_output_path,
    validate_input_file,
};
use crate::job::{cancelled, check_cancel, emit_progress, FileError, OutputFile};
use bzip2::read::BzDecoder;
use bzip2::write::BzEncoder;
use bzip2::Compression as BzCompression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression as GzCompression;
use serde::{Deserialize, Serialize};
use sevenz_rust::{Password, SevenZArchiveEntry, SevenZReader, SevenZWriter};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::AtomicBool;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use tar::{Archive as TarArchive, Builder as TarBuilder, EntryType, Header};
use tauri::AppHandle;
use tempfile::Builder as TempBuilder;
use walkdir::WalkDir;
use xz2::read::XzDecoder;
use xz2::write::XzEncoder;
use zip::write::SimpleFileOptions;
use zip::{AesMode, CompressionMethod, ZipArchive, ZipWriter};

const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024 * 1024;
const MAX_INSPECT_ENTRIES: usize = 5_000;
const MAX_CREATE_FILES: usize = 20_000;
const DEFAULT_MAX_EXTRACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_EXTRACT_FILES: u64 = 100_000;
const PROGRESS_EVERY_FILES: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Zip,
    SevenZ,
    Tar,
    TarGz,
    TarBz2,
    TarXz,
    Gzip,
    Bzip2,
    Xz,
    Rar,
}

impl Format {
    fn from_id(id: &str) -> Option<Self> {
        match id.to_ascii_lowercase().replace(' ', "").as_str() {
            "zip" => Some(Self::Zip),
            "7z" | "7zip" => Some(Self::SevenZ),
            "tar" => Some(Self::Tar),
            "tar.gz" | "tgz" | "targz" => Some(Self::TarGz),
            "tar.bz2" | "tbz2" | "tbz" | "tarbz2" => Some(Self::TarBz2),
            "tar.xz" | "txz" | "tarxz" => Some(Self::TarXz),
            "gzip" | "gz" => Some(Self::Gzip),
            "bzip2" | "bz2" => Some(Self::Bzip2),
            "xz" => Some(Self::Xz),
            "rar" => Some(Self::Rar),
            _ => None,
        }
    }

    fn detect(path: &Path) -> Option<Self> {
        let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
        if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
            Some(Self::TarGz)
        } else if name.ends_with(".tar.bz2") || name.ends_with(".tbz2") || name.ends_with(".tbz") {
            Some(Self::TarBz2)
        } else if name.ends_with(".tar.xz") || name.ends_with(".txz") {
            Some(Self::TarXz)
        } else if name.ends_with(".tar") {
            Some(Self::Tar)
        } else if name.ends_with(".zip") {
            Some(Self::Zip)
        } else if name.ends_with(".7z") {
            Some(Self::SevenZ)
        } else if name.ends_with(".rar") {
            Some(Self::Rar)
        } else if name.ends_with(".gz") {
            Some(Self::Gzip)
        } else if name.ends_with(".bz2") {
            Some(Self::Bzip2)
        } else if name.ends_with(".xz") {
            Some(Self::Xz)
        } else {
            None
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Zip => "zip",
            Self::SevenZ => "7z",
            Self::Tar => "tar",
            Self::TarGz => "tar.gz",
            Self::TarBz2 => "tar.bz2",
            Self::TarXz => "tar.xz",
            Self::Gzip => "gzip",
            Self::Bzip2 => "bzip2",
            Self::Xz => "xz",
            Self::Rar => "rar",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Zip => "ZIP",
            Self::SevenZ => "7Z",
            Self::Tar => "TAR",
            Self::TarGz => "TAR.GZ",
            Self::TarBz2 => "TAR.BZ2",
            Self::TarXz => "TAR.XZ",
            Self::Gzip => "GZIP",
            Self::Bzip2 => "BZIP2",
            Self::Xz => "XZ",
            Self::Rar => "RAR",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Zip => "zip",
            Self::SevenZ => "7z",
            Self::Tar => "tar",
            Self::TarGz => "tar.gz",
            Self::TarBz2 => "tar.bz2",
            Self::TarXz => "tar.xz",
            Self::Gzip => "gz",
            Self::Bzip2 => "bz2",
            Self::Xz => "xz",
            Self::Rar => "rar",
        }
    }

    fn can_create(self) -> bool {
        !matches!(self, Self::Rar)
    }

    fn can_password(self) -> bool {
        matches!(self, Self::Zip | Self::SevenZ)
    }

    fn is_single_stream(self) -> bool {
        matches!(self, Self::Gzip | Self::Bzip2 | Self::Xz)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntryInfo {
    pub path: String,
    pub size: u64,
    pub compressed_size: Option<u64>,
    pub is_dir: bool,
    pub encrypted: bool,
    pub nested: bool,
    pub safe: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInspection {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub format: String,
    pub format_label: String,
    pub entries: Vec<ArchiveEntryInfo>,
    pub file_count: usize,
    pub dir_count: usize,
    pub total_size: u64,
    pub ratio: f64,
    pub encrypted: bool,
    pub can_create: bool,
    pub can_password: bool,
    pub nested_count: usize,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractConflict {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractPlan {
    pub root: String,
    pub conflicts: Vec<ExtractConflict>,
    pub conflict_count: usize,
    pub file_count: usize,
    pub total_size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectRequest {
    pub path: String,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub job_id: String,
    pub sources: Vec<String>,
    pub output_dir: Option<String>,
    pub file_name: String,
    pub format: String,
    pub level: String,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractRequest {
    pub job_id: String,
    pub input: String,
    pub destination: Option<String>,
    pub password: Option<String>,
    pub conflict: String,
    pub selected: Vec<String>,
    pub folder_mode: String,
    pub folder_name: Option<String>,
    pub max_total_mb: Option<u64>,
    pub max_files: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    pub input: String,
    pub destination: Option<String>,
    pub password: Option<String>,
    pub selected: Vec<String>,
    pub folder_mode: String,
    pub folder_name: Option<String>,
    pub max_total_mb: Option<u64>,
    pub max_files: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveTestRequest {
    pub job_id: String,
    pub path: String,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveJobOutcome {
    pub job_id: String,
    pub output: Option<OutputFile>,
    pub destination: Option<String>,
    pub files: usize,
    pub skipped: usize,
    pub warnings: Vec<String>,
    pub errors: Vec<FileError>,
    pub cancelled: bool,
    pub elapsed_ms: u128,
}

fn file_modified(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .filter(|s| *s > 0)
}

fn is_nested_archive_name(name: &str) -> bool {
    Format::detect(Path::new(name)).is_some()
}

fn safe_relative_path(name: &str) -> Result<PathBuf, String> {
    let normalized = name.replace('\\', "/");
    if normalized.contains('\0') {
        return Err("Archive entry contains an invalid character.".to_string());
    }
    let path = Path::new(&normalized);
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                if part.is_empty() {
                    continue;
                }
                result.push(part.as_ref());
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Unsafe archive path: “{name}”"));
            }
        }
    }
    if result.as_os_str().is_empty() {
        return Err(format!("Archive entry has no file name: “{name}”"));
    }
    Ok(result)
}

fn safe_display_path(name: &str) -> bool {
    safe_relative_path(name).is_ok()
}

fn selected_entry(name: &str, selected: &[String]) -> bool {
    if selected.is_empty() {
        return true;
    }
    let name = name.trim_end_matches('/');
    selected.iter().any(|item| {
        let item = item.trim_end_matches('/');
        name == item || name.starts_with(&format!("{item}/"))
    })
}

fn open_archive(path: &Path) -> Result<File, String> {
    let file = File::open(path).map_err(|e| format!("Couldn't open the archive: {e}"))?;
    let size = file
        .metadata()
        .map_err(|e| format!("Couldn't inspect the archive: {e}"))?
        .len();
    if size > MAX_ARCHIVE_BYTES {
        return Err(
            "This archive is larger than 32 GB, beyond Reformat's safe working limit.".to_string(),
        );
    }
    Ok(file)
}

fn derived_stream_name(path: &Path, format: Format) -> String {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return "extracted-file".to_string();
    };
    let lower = name.to_ascii_lowercase();
    let suffix = match format {
        Format::Gzip => ".gz",
        Format::Bzip2 => ".bz2",
        Format::Xz => ".xz",
        _ => "",
    };
    if !suffix.is_empty() && lower.ends_with(suffix) {
        name[..name.len() - suffix.len()].to_string()
    } else if lower.ends_with(".tgz") {
        name[..name.len() - 4].to_string() + ".tar"
    } else {
        format!("{name}.out")
    }
}

fn gzip_isize(path: &Path) -> Option<u64> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len < 4 {
        return None;
    }
    file.seek(SeekFrom::End(-4)).ok()?;
    let mut raw = [0u8; 4];
    file.read_exact(&mut raw).ok()?;
    Some(u32::from_le_bytes(raw) as u64)
}

fn inspect_zip(path: &Path, archive_size: u64) -> Result<ArchiveInspection, String> {
    let file = open_archive(path)?;
    let mut archive = ZipArchive::new(file).map_err(|e| {
        format!("This ZIP couldn't be opened. It may be damaged or password-protected. ({e})")
    })?;
    let total_entries = archive.len();
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut file_count = 0usize;
    let mut dir_count = 0usize;
    let mut total_size = 0u64;
    let mut encrypted = false;
    let mut nested_count = 0usize;
    for index in 0..total_entries {
        let Ok(raw) = archive.by_index_raw(index) else {
            warnings.push(format!("Entry {} couldn't be read.", index + 1));
            continue;
        };
        let Ok(name) = raw.name().map(|n| n.into_owned()) else {
            warnings.push(format!("Entry {} has an invalid name.", index + 1));
            continue;
        };
        let is_dir = raw.is_dir();
        let size = raw.size();
        let compressed = raw.compressed_size();
        let entry_encrypted = raw.encrypted();
        if entry_encrypted {
            encrypted = true;
        }
        let safe = safe_display_path(&name);
        if !safe {
            warnings.push(format!("Unsafe path was ignored: “{name}”"));
        }
        if raw
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            warnings.push(format!("Symbolic link was ignored: “{name}”"));
        }
        if is_dir {
            dir_count += 1;
        } else {
            file_count += 1;
            total_size = total_size.saturating_add(size);
            if is_nested_archive_name(&name) {
                nested_count += 1;
            }
        }
        if entries.len() < MAX_INSPECT_ENTRIES {
            entries.push(ArchiveEntryInfo {
                path: name,
                size,
                compressed_size: Some(compressed),
                is_dir,
                encrypted: entry_encrypted,
                nested: !is_dir && is_nested_archive_name(&raw.name().unwrap_or_default()),
                safe,
            });
        }
    }
    Ok(ArchiveInspection {
        path: path.to_string_lossy().into_owned(),
        name: display_name(&path.to_string_lossy()),
        bytes: archive_size,
        format: Format::Zip.id().to_string(),
        format_label: Format::Zip.label().to_string(),
        entries,
        file_count,
        dir_count,
        total_size,
        ratio: archive_ratio(total_size, archive_size),
        encrypted,
        can_create: true,
        can_password: true,
        nested_count,
        truncated: total_entries > MAX_INSPECT_ENTRIES,
        warnings,
    })
}

fn archive_ratio(total_size: u64, archive_size: u64) -> f64 {
    if archive_size == 0 {
        0.0
    } else {
        (total_size as f64 / archive_size as f64 * 100.0).round() / 100.0
    }
}

fn tar_reader(path: &Path, format: Format) -> Result<Box<dyn Read>, String> {
    let file = open_archive(path)?;
    match format {
        Format::Tar => Ok(Box::new(BufReader::new(file))),
        Format::TarGz => Ok(Box::new(GzDecoder::new(BufReader::new(file)))),
        Format::TarBz2 => Ok(Box::new(BzDecoder::new(BufReader::new(file)))),
        Format::TarXz => Ok(Box::new(XzDecoder::new(BufReader::new(file)))),
        _ => Err("Not a TAR format.".to_string()),
    }
}

fn inspect_tar(
    path: &Path,
    format: Format,
    archive_size: u64,
) -> Result<ArchiveInspection, String> {
    let reader = tar_reader(path, format)?;
    let mut archive = TarArchive::new(reader);
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut file_count = 0usize;
    let mut dir_count = 0usize;
    let mut total_size = 0u64;
    let mut nested_count = 0usize;
    let mut truncated = false;
    let mut index = 0usize;
    let iterator = archive
        .entries()
        .map_err(|e| format!("This archive couldn't be read: {e}"))?;
    for item in iterator {
        index += 1;
        let Ok(entry) = item else {
            warnings.push(format!(
                "An archive entry near position {index} couldn't be read."
            ));
            continue;
        };
        let path_value = entry
            .path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| format!("entry-{index}"));
        let header = entry.header();
        let entry_type = header.entry_type();
        let is_dir = entry_type.is_dir();
        let size = header.size().unwrap_or(0);
        let safe = safe_display_path(&path_value);
        if !safe {
            warnings.push(format!("Unsafe path was ignored: “{path_value}”"));
        }
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            warnings.push(format!("Symbolic link was ignored: “{path_value}”"));
        }
        if is_dir {
            dir_count += 1;
        } else {
            file_count += 1;
            total_size = total_size.saturating_add(size);
            if is_nested_archive_name(&path_value) {
                nested_count += 1;
            }
        }
        if entries.len() < MAX_INSPECT_ENTRIES {
            entries.push(ArchiveEntryInfo {
                path: path_value,
                size,
                compressed_size: None,
                is_dir,
                encrypted: false,
                nested: !is_dir && is_nested_archive_name(&entry_path_lossy(&entry)),
                safe,
            });
        } else {
            truncated = true;
        }
    }
    Ok(ArchiveInspection {
        path: path.to_string_lossy().into_owned(),
        name: display_name(&path.to_string_lossy()),
        bytes: archive_size,
        format: format.id().to_string(),
        format_label: format.label().to_string(),
        entries,
        file_count,
        dir_count,
        total_size,
        ratio: archive_ratio(total_size, archive_size),
        encrypted: false,
        can_create: true,
        can_password: false,
        nested_count,
        truncated,
        warnings,
    })
}

fn entry_path_lossy<R: Read>(entry: &tar::Entry<'_, R>) -> String {
    entry
        .path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn inspect_sevenz(
    path: &Path,
    password: Option<&str>,
    archive_size: u64,
) -> Result<ArchiveInspection, String> {
    let pass = Password::from(password.unwrap_or(""));
    let reader = SevenZReader::open(path, pass).map_err(|e| {
        let text = e.to_string();
        if text.to_ascii_lowercase().contains("password") || text.contains("Bad password") {
            "This 7Z archive is password-protected. Enter its password to inspect it.".to_string()
        } else {
            format!("This 7Z archive couldn't be read. It may be damaged. ({text})")
        }
    })?;
    let archive = reader.archive();
    let total_entries = archive.files.len();
    let mut entries = Vec::new();
    let mut file_count = 0usize;
    let mut dir_count = 0usize;
    let mut total_size = 0u64;
    let mut nested_count = 0usize;
    let mut warnings = Vec::new();
    for file in archive.files.iter() {
        let name = file.name();
        let is_dir = file.is_directory();
        let size = file.size;
        let safe = safe_display_path(name);
        if !safe {
            warnings.push(format!("Unsafe path was ignored: “{name}”"));
        }
        if is_dir {
            dir_count += 1;
        } else {
            file_count += 1;
            total_size = total_size.saturating_add(size);
            if is_nested_archive_name(name) {
                nested_count += 1;
            }
        }
        if entries.len() < MAX_INSPECT_ENTRIES {
            entries.push(ArchiveEntryInfo {
                path: name.to_string(),
                size,
                compressed_size: if file.compressed_size > 0 {
                    Some(file.compressed_size)
                } else {
                    None
                },
                is_dir,
                encrypted: password.is_some_and(|p| !p.is_empty()),
                nested: !is_dir && is_nested_archive_name(name),
                safe,
            });
        }
    }
    Ok(ArchiveInspection {
        path: path.to_string_lossy().into_owned(),
        name: display_name(&path.to_string_lossy()),
        bytes: archive_size,
        format: Format::SevenZ.id().to_string(),
        format_label: Format::SevenZ.label().to_string(),
        entries,
        file_count,
        dir_count,
        total_size,
        ratio: archive_ratio(total_size, archive_size),
        encrypted: password.is_some_and(|p| !p.is_empty()),
        can_create: true,
        can_password: true,
        nested_count,
        truncated: total_entries > MAX_INSPECT_ENTRIES,
        warnings,
    })
}

fn walk_size_and_count(root: &Path) -> Result<(u64, usize), String> {
    let mut bytes = 0u64;
    let mut files = 0usize;
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|e| format!("Couldn't measure the archive output: {e}"))?;
        if entry.file_type().is_file() {
            files += 1;
            bytes = bytes.saturating_add(entry.metadata().map(|m| m.len()).unwrap_or(0));
        }
    }
    Ok((bytes, files))
}

/// Run a helper process with a hard deadline and optional cancellation. A
/// malicious archive should never be able to wedge the app in `bsdtar`.
fn run_command_bounded(
    mut command: Command,
    timeout: Duration,
    token: Option<&AtomicBool>,
    mut guard: Option<&mut dyn FnMut() -> Result<(), String>>,
) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Couldn't start the archive helper: {e}"))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(stream) = stdout.as_mut() {
            let _ = stream.read_to_end(&mut buffer);
        }
        buffer
    });
    let stderr_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = stream.read_to_end(&mut buffer);
        }
        buffer
    });
    let started = Instant::now();
    let mut last_guard = Instant::now();
    let status = loop {
        if let Some(guard) = guard.as_mut() {
            if last_guard.elapsed() >= Duration::from_millis(180) {
                if let Err(error) = guard() {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(error);
                }
                last_guard = Instant::now();
            }
        }
        if let Some(token) = token {
            if token.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err("Cancelled".to_string());
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err("The archive took too long to process. It may be malformed or unusually large.".to_string());
                }
                thread::sleep(Duration::from_millis(40));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("Couldn't finish the archive helper: {error}"));
            }
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

type RarEntry = (String, bool, u64, bool);
type RarListing = (Vec<RarEntry>, Vec<String>);

fn rar_list(path: &Path) -> Result<RarListing, String> {
    let mut command = Command::new("/usr/bin/bsdtar");
    command.env("LC_ALL", "C").arg("-tvf").arg(path);
    let output = run_command_bounded(command, Duration::from_secs(120), None, None)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("passphrase") || stderr.contains("password") {
            return Err(
                "Encrypted RAR archives aren't supported. Extract this one with its original tool."
                    .to_string(),
            );
        }
        return Err("This RAR archive couldn't be read. It may be damaged or use an unsupported compression method.".to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    for line in text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 8 {
            continue;
        }
        let permissions = tokens[0];
        let Some(kind) = permissions.chars().next() else {
            continue;
        };
        let is_dir = kind == 'd';
        let is_link = kind == 'l' || kind == 'h';
        // bsdtar's verbose listing includes a link-count column on macOS:
        //   perms links owner group size Mon DD YYYY name...
        // Find the month so this keeps working if the owner/group columns change.
        let month_index = tokens.iter().position(|token| {
            matches!(
                *token,
                "Jan"
                    | "Feb"
                    | "Mar"
                    | "Apr"
                    | "May"
                    | "Jun"
                    | "Jul"
                    | "Aug"
                    | "Sep"
                    | "Oct"
                    | "Nov"
                    | "Dec"
            )
        });
        let Some(month_index) = month_index else {
            continue;
        };
        if tokens.len() < month_index + 4 {
            continue;
        }
        let size = tokens
            .get(month_index.saturating_sub(1))
            .and_then(|token| token.parse::<u64>().ok())
            .unwrap_or(0);
        let mut name = tokens[month_index + 3..].join(" ");
        if name.chars().any(|character| character.is_control()) {
            return Err("This RAR has an unusual filename and was not extracted.".to_string());
        }
        if is_link {
            if let Some((actual, _)) = name.split_once(" -> ") {
                name = actual.to_string();
            }
            warnings.push(format!("Symbolic link was ignored: “{name}”"));
        }
        entries.push((name, is_dir, size, is_link));
    }
    Ok((entries, warnings))
}

fn inspect_rar(path: &Path, archive_size: u64) -> Result<ArchiveInspection, String> {
    let (raw_entries, mut warnings) = rar_list(path)?;
    let mut entries = Vec::new();
    let mut file_count = 0usize;
    let mut dir_count = 0usize;
    let mut total_size = 0u64;
    let mut nested_count = 0usize;
    let mut truncated = false;
    for (name, is_dir, size, is_link) in &raw_entries {
        let safe = safe_display_path(name);
        if !safe {
            warnings.push(format!("Unsafe path was ignored: “{name}”"));
        }
        if *is_dir {
            dir_count += 1;
        } else if !*is_link {
            file_count += 1;
            total_size = total_size.saturating_add(*size);
            if is_nested_archive_name(name) {
                nested_count += 1;
            }
        }
        if entries.len() < MAX_INSPECT_ENTRIES {
            entries.push(ArchiveEntryInfo {
                path: name.clone(),
                size: *size,
                compressed_size: None,
                is_dir: *is_dir,
                encrypted: false,
                nested: !*is_dir && is_nested_archive_name(name),
                safe,
            });
        } else {
            truncated = true;
        }
    }
    Ok(ArchiveInspection {
        path: path.to_string_lossy().into_owned(),
        name: display_name(&path.to_string_lossy()),
        bytes: archive_size,
        format: Format::Rar.id().to_string(),
        format_label: Format::Rar.label().to_string(),
        entries,
        file_count,
        dir_count,
        total_size,
        ratio: archive_ratio(total_size, archive_size),
        encrypted: false,
        can_create: false,
        can_password: false,
        nested_count,
        truncated,
        warnings,
    })
}

pub fn archive_inspect(request: InspectRequest) -> Result<ArchiveInspection, String> {
    let path = validate_input_file(&request.path)?;
    let archive_size = fs::metadata(&path)
        .map_err(|e| format!("Couldn't inspect the archive: {e}"))?
        .len();
    if archive_size == 0 {
        return Err("This file is empty, not a readable archive.".to_string());
    }
    let format = Format::detect(&path).ok_or_else(|| {
        "That file type isn't supported. Choose a ZIP, 7Z, TAR, TAR.GZ, TAR.BZ2, TAR.XZ, GZIP, BZIP2, XZ, or RAR archive.".to_string()
    })?;
    match format {
        Format::Zip => inspect_zip(&path, archive_size),
        Format::Tar | Format::TarGz | Format::TarBz2 | Format::TarXz => {
            inspect_tar(&path, format, archive_size)
        }
        Format::SevenZ => inspect_sevenz(&path, request.password.as_deref(), archive_size),
        Format::Rar => inspect_rar(&path, archive_size),
        Format::Gzip | Format::Bzip2 | Format::Xz => {
            let name = derived_stream_name(&path, format);
            let size = if format == Format::Gzip {
                gzip_isize(&path).unwrap_or(0)
            } else {
                0
            };
            Ok(ArchiveInspection {
                path: path.to_string_lossy().into_owned(),
                name: display_name(&path.to_string_lossy()),
                bytes: archive_size,
                format: format.id().to_string(),
                format_label: format.label().to_string(),
                entries: vec![ArchiveEntryInfo {
                    path: name.clone(),
                    size,
                    compressed_size: Some(archive_size),
                    is_dir: false,
                    encrypted: false,
                    nested: is_nested_archive_name(&name),
                    safe: safe_display_path(&name),
                }],
                file_count: 1,
                dir_count: 0,
                total_size: size,
                ratio: archive_ratio(size, archive_size),
                encrypted: false,
                can_create: true,
                can_password: false,
                nested_count: usize::from(is_nested_archive_name(&name)),
                truncated: false,
                warnings: if format != Format::Gzip {
                    vec!["Decompressed size is calculated when the file is extracted.".to_string()]
                } else {
                    Vec::new()
                },
            })
        }
    }
}

#[derive(Debug, Default)]
struct ExtractStats {
    files: usize,
    dirs: usize,
    bytes: u64,
    skipped: usize,
    warnings: Vec<String>,
}

struct ExtractLimits {
    max_bytes: u64,
    max_files: u64,
    files: u64,
    bytes: u64,
}

impl ExtractLimits {
    fn from_request(max_total_mb: Option<u64>, max_files: Option<u64>) -> Self {
        Self {
            max_bytes: max_total_mb
                .unwrap_or(DEFAULT_MAX_EXTRACT_BYTES / 1024 / 1024)
                .max(1)
                .saturating_mul(1024 * 1024),
            max_files: max_files.unwrap_or(DEFAULT_MAX_EXTRACT_FILES).max(1),
            files: 0,
            bytes: 0,
        }
    }

    fn preflight(&self, file_count: usize, total_size: u64) -> Result<(), String> {
        if file_count as u64 > self.max_files {
            return Err(format!(
                "This archive contains {file_count} files, above the {} file safety limit.",
                self.max_files
            ));
        }
        if total_size > self.max_bytes {
            return Err(format!(
                "This archive expands to {}, above the {} safety limit. Raise the limit in Archive settings if you trust it.",
                human_size(total_size),
                human_size(self.max_bytes)
            ));
        }
        Ok(())
    }

    fn count_file(&mut self, size: u64) -> Result<(), String> {
        self.files += 1;
        self.bytes = self.bytes.saturating_add(size);
        if self.files > self.max_files {
            return Err("Extraction stopped at the file-count safety limit.".to_string());
        }
        if self.bytes > self.max_bytes {
            return Err(format!(
                "Extraction stopped at the {} safety limit while expanding this archive.",
                human_size(self.max_bytes)
            ));
        }
        Ok(())
    }
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", bytes as f64 / 1024.0 / 1024.0 / 1024.0)
    } else if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    } else {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    }
}

fn archive_base_name(path: &Path) -> String {
    let mut name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "archive".to_string());
    for suffix in [
        ".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".tbz", ".txz", ".zip", ".7z", ".tar",
        ".rar", ".gz", ".bz2", ".xz",
    ] {
        if name.to_ascii_lowercase().ends_with(suffix) {
            name.truncate(name.len() - suffix.len());
            break;
        }
    }
    if name.is_empty() {
        "archive".to_string()
    } else {
        name
    }
}

fn extraction_destination(input: &Path, requested: Option<&str>) -> Result<PathBuf, String> {
    if let Some(dest) = requested.filter(|d| !d.trim().is_empty()) {
        let path = PathBuf::from(dest);
        if path.exists() && !path.is_dir() {
            return Err("The extraction destination isn't a folder.".to_string());
        }
        return Ok(path);
    }
    input
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Couldn't determine an extraction folder.".to_string())
}

fn resolve_extraction_root(
    input: &Path,
    destination: &Path,
    folder_mode: &str,
    folder_name: Option<&str>,
    inspection: &ArchiveInspection,
    selected: &[String],
) -> PathBuf {
    let folder = sanitize_stem(
        folder_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(&archive_base_name(input)),
        &archive_base_name(input),
    );
    match folder_mode {
        "never" => destination.to_path_buf(),
        "always" => destination.join(folder),
        _ => {
            let selected_entries: Vec<&ArchiveEntryInfo> = inspection
                .entries
                .iter()
                .filter(|entry| selected_entry(&entry.path, selected))
                .collect();
            let mut top_levels = std::collections::HashSet::new();
            let mut nested_root = false;
            for entry in &selected_entries {
                let normalized = entry.path.trim_end_matches('/');
                let mut parts = normalized.split('/');
                if let Some(first) = parts.next().filter(|part| !part.is_empty()) {
                    top_levels.insert(first.to_string());
                    if parts.next().is_some() {
                        nested_root = true;
                    }
                }
            }
            let all_share_top = top_levels.len() == 1;
            let top_is_dir = selected_entries.iter().any(|entry| {
                entry.is_dir
                    && entry.path.trim_end_matches('/').split('/').next()
                        == top_levels.iter().next().map(String::as_str)
            });
            if all_share_top && (nested_root || top_is_dir) {
                destination.to_path_buf()
            } else {
                destination.join(folder)
            }
        }
    }
}

fn extraction_conflicts(
    root: &Path,
    inspection: &ArchiveInspection,
    selected: &[String],
) -> Vec<ExtractConflict> {
    let mut conflicts = Vec::new();
    for entry in &inspection.entries {
        if !entry.safe || !selected_entry(&entry.path, selected) {
            continue;
        }
        let Ok(relative) = safe_relative_path(entry.path.trim_end_matches('/')) else {
            continue;
        };
        let target = root.join(relative);
        let Ok(metadata) = fs::symlink_metadata(&target) else {
            continue;
        };
        if entry.is_dir {
            if !metadata.is_dir() {
                conflicts.push(ExtractConflict {
                    path: entry.path.clone(),
                    kind: "A file is in the way".to_string(),
                });
            }
        } else {
            conflicts.push(ExtractConflict {
                path: entry.path.clone(),
                kind: if metadata.is_dir() {
                    "A folder is in the way".to_string()
                } else {
                    "A file already exists".to_string()
                },
            });
        }
    }
    conflicts
}

fn prepare_plan(
    request: &PlanRequest,
) -> Result<(ArchiveInspection, PathBuf, ExtractPlan), String> {
    let input = validate_input_file(&request.input)?;
    let inspection = archive_inspect(InspectRequest {
        path: request.input.clone(),
        password: request.password.clone(),
    })?;
    let destination = extraction_destination(&input, request.destination.as_deref())?;
    let limits = ExtractLimits::from_request(request.max_total_mb, request.max_files);
    limits.preflight(inspection.file_count, inspection.total_size)?;
    let root = resolve_extraction_root(
        &input,
        &destination,
        &request.folder_mode,
        request.folder_name.as_deref(),
        &inspection,
        &request.selected,
    );
    let selected_files = inspection
        .entries
        .iter()
        .filter(|entry| !entry.is_dir && selected_entry(&entry.path, &request.selected))
        .count();
    let selected_size = inspection
        .entries
        .iter()
        .filter(|entry| !entry.is_dir && selected_entry(&entry.path, &request.selected))
        .map(|entry| entry.size)
        .sum();
    let conflicts = extraction_conflicts(&root, &inspection, &request.selected);
    let plan = ExtractPlan {
        root: root.to_string_lossy().into_owned(),
        conflict_count: conflicts.len(),
        conflicts: conflicts.into_iter().take(100).collect(),
        file_count: selected_files,
        total_size: selected_size,
    };
    Ok((inspection, root, plan))
}

pub fn plan_archive_extraction(request: PlanRequest) -> Result<ExtractPlan, String> {
    prepare_plan(&request).map(|(_, _, plan)| plan)
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("Couldn't create {}: {e}", path.display()))
}

fn write_limited(
    reader: &mut dyn Read,
    target: &Path,
    total_limit: u64,
    already_written: u64,
    limits: &mut ExtractLimits,
    declared_size: Option<u64>,
) -> Result<u64, String> {
    if let Some(size) = declared_size {
        if size > limits.max_bytes.saturating_sub(already_written) {
            return Err(format!(
                "An entry is larger than the remaining {} extraction safety limit.",
                human_size(limits.max_bytes)
            ));
        }
    }
    if let Some(parent) = target.parent() {
        ensure_dir(parent)?;
    }
    let mut file =
        File::create(target).map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut written = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| format!("Archive data couldn't be read: {e}"))?;
        if read == 0 {
            break;
        }
        written = written.saturating_add(read as u64);
        if written > total_limit.saturating_sub(already_written) {
            let _ = fs::remove_file(target);
            return Err(format!(
                "Extraction stopped at the {} safety limit. This archive may be a decompression bomb.",
                human_size(limits.max_bytes)
            ));
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("Couldn't write extracted data: {e}"))?;
    }
    file.flush()
        .map_err(|e| format!("Couldn't finish an extracted file: {e}"))?;
    limits.count_file(written)?;
    Ok(written)
}

fn discard_entry(reader: &mut dyn Read, max: u64) -> Result<(), String> {
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| format!("Archive data couldn't be read: {e}"))?;
        if read == 0 {
            return Ok(());
        }
        total = total.saturating_add(read as u64);
        if total > max {
            return Err("An archive entry is too large to inspect safely.".to_string());
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn extract_zip(
    app: Option<&AppHandle>,
    job_id: &str,
    path: &Path,
    password: Option<&str>,
    staging: &Path,
    selected: &[String],
    total: usize,
    limits: &mut ExtractLimits,
    token: &AtomicBool,
) -> Result<ExtractStats, String> {
    let file = open_archive(path)?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("This ZIP couldn't be opened. ({e})"))?;
    let mut stats = ExtractStats::default();
    let mut completed = 0usize;
    for index in 0..archive.len() {
        check_cancel(token)?;
        let raw = archive
            .by_index_raw(index)
            .map_err(|e| format!("ZIP entry {} couldn't be read: {e}", index + 1))?;
        let name = raw
            .name()
            .map(|n| n.into_owned())
            .map_err(|_| "A ZIP entry has an invalid name.".to_string())?;
        if !selected_entry(&name, selected) {
            continue;
        }
        let is_dir = raw.is_dir();
        let encrypted = raw.encrypted();
        let symlink = raw
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000);
        let declared_size = raw.size();
        drop(raw);
        if symlink {
            stats
                .warnings
                .push(format!("Skipped symbolic link “{name}”."));
            stats.skipped += 1;
            continue;
        }
        let relative = safe_relative_path(&name)?;
        let target = staging.join(relative);
        if is_dir {
            ensure_dir(&target)?;
            stats.dirs += 1;
            continue;
        }
        let mut entry = if encrypted {
            let pw = password.unwrap_or("");
            if pw.is_empty() {
                return Err(format!(
                    "“{name}” is encrypted. Enter the archive password and try again."
                ));
            }
            archive
                .by_index_decrypt(index, pw.as_bytes())
                .map_err(|_| "The password didn't unlock this ZIP archive.".to_string())?
        } else {
            archive
                .by_index(index)
                .map_err(|e| format!("ZIP entry couldn't be read: {e}"))?
        };
        let remaining = limits.max_bytes.saturating_sub(limits.bytes);
        let bytes = write_limited(
            &mut entry,
            &target,
            remaining.saturating_add(limits.bytes),
            limits.bytes,
            limits,
            Some(declared_size),
        )?;
        stats.files += 1;
        stats.bytes = stats.bytes.saturating_add(bytes);
        completed += 1;
        if completed.is_multiple_of(PROGRESS_EVERY_FILES) || completed == total {
            emit_progress(
                app,
                job_id,
                "archive-extract",
                total,
                completed,
                Some(name),
                "running",
            );
        }
    }
    Ok(stats)
}

#[allow(clippy::too_many_arguments)]
fn extract_tar(
    app: Option<&AppHandle>,
    job_id: &str,
    path: &Path,
    format: Format,
    staging: &Path,
    selected: &[String],
    total: usize,
    limits: &mut ExtractLimits,
    token: &AtomicBool,
) -> Result<ExtractStats, String> {
    let reader = tar_reader(path, format)?;
    let mut archive = TarArchive::new(reader);
    let mut stats = ExtractStats::default();
    let mut completed = 0usize;
    let entries = archive
        .entries()
        .map_err(|e| format!("This TAR archive couldn't be read: {e}"))?;
    for item in entries {
        check_cancel(token)?;
        let mut entry = item.map_err(|e| format!("A TAR entry couldn't be read: {e}"))?;
        let name = entry_path_lossy(&entry);
        let entry_type = entry.header().entry_type();
        let is_link = matches!(entry_type, EntryType::Symlink | EntryType::Link);
        let is_dir = entry_type.is_dir();
        let selected_here = selected_entry(&name, selected);
        if is_link {
            if selected_here || selected.is_empty() {
                stats
                    .warnings
                    .push(format!("Skipped symbolic link “{name}”."));
                stats.skipped += 1;
            }
            continue;
        }
        let relative = safe_relative_path(name.trim_end_matches('/'))?;
        let target = staging.join(relative);
        if is_dir {
            if selected_here {
                ensure_dir(&target)?;
                stats.dirs += 1;
            }
            continue;
        }
        if !entry_type.is_file() {
            stats
                .warnings
                .push(format!("Skipped unsupported entry “{name}”."));
            continue;
        }
        if selected_here {
            let declared = entry.header().size().ok();
            let remaining = limits.max_bytes.saturating_sub(limits.bytes);
            let bytes = write_limited(
                &mut entry,
                &target,
                remaining.saturating_add(limits.bytes),
                limits.bytes,
                limits,
                declared,
            )?;
            stats.files += 1;
            stats.bytes = stats.bytes.saturating_add(bytes);
            completed += 1;
            if completed.is_multiple_of(PROGRESS_EVERY_FILES) || completed == total {
                emit_progress(
                    app,
                    job_id,
                    "archive-extract",
                    total,
                    completed,
                    Some(name),
                    "running",
                );
            }
        } else {
            discard_entry(&mut entry, limits.max_bytes.saturating_sub(limits.bytes))?;
        }
    }
    Ok(stats)
}

#[allow(clippy::too_many_arguments)]
fn extract_sevenz(
    app: Option<&AppHandle>,
    job_id: &str,
    path: &Path,
    password: Option<&str>,
    staging: &Path,
    selected: &[String],
    total: usize,
    limits: &mut ExtractLimits,
    token: &AtomicBool,
) -> Result<ExtractStats, String> {
    let pass = Password::from(password.unwrap_or(""));
    let mut reader = SevenZReader::open(path, pass).map_err(|e| {
        let text = e.to_string();
        if text.to_ascii_lowercase().contains("password") || text.contains("Bad password") {
            "This 7Z archive is password-protected. Enter its password and try again.".to_string()
        } else {
            format!("This 7Z archive couldn't be read. ({text})")
        }
    })?;
    let mut stats = ExtractStats::default();
    let mut completed = 0usize;
    let mut write_error: Option<String> = None;
    let cancel = token;
    let result = reader.for_each_entries(|entry, data| {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            write_error = Some("Cancelled".to_string());
            return Err(sevenz_rust::Error::other("Cancelled"));
        }
        let name = entry.name().to_string();
        let selected_here = selected_entry(&name, selected);
        if entry.is_directory() {
            if selected_here {
                let relative = safe_relative_path(name.trim_end_matches('/'))
                    .map_err(sevenz_rust::Error::other)?;
                ensure_dir(&staging.join(relative)).map_err(sevenz_rust::Error::other)?;
                stats.dirs += 1;
            }
            return Ok(true);
        }
        if selected_here {
            let relative = match safe_relative_path(&name) {
                Ok(value) => value,
                Err(error) => {
                    write_error = Some(error.clone());
                    return Err(sevenz_rust::Error::other(error));
                }
            };
            let target = staging.join(relative);
            let remaining = limits.max_bytes.saturating_sub(limits.bytes);
            match write_limited(
                data,
                &target,
                remaining.saturating_add(limits.bytes),
                limits.bytes,
                limits,
                Some(entry.size),
            ) {
                Ok(bytes) => {
                    stats.files += 1;
                    stats.bytes = stats.bytes.saturating_add(bytes);
                    completed += 1;
                    if completed.is_multiple_of(PROGRESS_EVERY_FILES) || completed == total {
                        emit_progress(
                            app,
                            job_id,
                            "archive-extract",
                            total,
                            completed,
                            Some(name),
                            "running",
                        );
                    }
                }
                Err(error) => {
                    write_error = Some(error.clone());
                    return Err(sevenz_rust::Error::other(error));
                }
            }
        } else if let Err(error) =
            discard_entry(data, limits.max_bytes.saturating_sub(limits.bytes))
        {
            write_error = Some(error.clone());
            return Err(sevenz_rust::Error::other(error));
        }
        Ok(true)
    });
    if let Some(error) = write_error {
        return Err(error);
    }
    result.map_err(|e| format!("This 7Z archive couldn't be extracted: {e}"))?;
    Ok(stats)
}

#[allow(clippy::too_many_arguments)]
fn extract_rar(
    app: Option<&AppHandle>,
    job_id: &str,
    path: &Path,
    staging: &Path,
    selected: &[String],
    total: usize,
    limits: &mut ExtractLimits,
    token: &AtomicBool,
) -> Result<ExtractStats, String> {
    let (entries, warnings) = rar_list(path)?;
    if entries.iter().any(|(_, _, _, is_link)| *is_link) {
        return Err(
            "This RAR contains symbolic links. For safety, extract it with the original RAR tool."
                .to_string(),
        );
    }
    // RAR extraction currently goes through bsdtar and extracts the whole
    // archive before applying the selection. That means every entry must pass
    // path and size validation, not just the selected ones.
    let expected_files = entries.iter().filter(|(_, is_dir, _, _)| !*is_dir).count();
    let expected_bytes: u64 = entries
        .iter()
        .filter(|(_, is_dir, _, _)| !*is_dir)
        .map(|(_, _, size, _)| *size)
        .sum();
    limits.preflight(expected_files, expected_bytes)?;
    for (name, is_dir, _, _) in &entries {
        let relative = safe_relative_path(name.trim_end_matches('/'))?;
        if *is_dir && selected_entry(name, selected) {
            ensure_dir(&staging.join(relative))?;
        }
    }
    check_cancel(token)?;
    emit_progress(
        app,
        job_id,
        "archive-extract",
        total,
        0,
        Some(display_name(&path.to_string_lossy())),
        "running",
    );
    let max_bytes = limits.max_bytes;
    let max_files = limits.max_files;
    let mut guard = || -> Result<(), String> {
        let (bytes, files) = walk_size_and_count(staging)?;
        if bytes > max_bytes {
            return Err(
                "Extraction stopped before the unpacked size safety limit was exceeded."
                    .to_string(),
            );
        }
        if files > max_files as usize {
            return Err(
                "Extraction stopped before the file-count safety limit was exceeded.".to_string(),
            );
        }
        Ok(())
    };
    let mut command = Command::new("/usr/bin/bsdtar");
    command
        .env("LC_ALL", "C")
        .args(["-xf"])
        .arg(path)
        .arg("-C")
        .arg(staging);
    let output = run_command_bounded(
        command,
        Duration::from_secs(600),
        Some(token),
        Some(&mut guard),
    )?;
    if !output.status.success() {
        return Err("This RAR archive couldn't be extracted. It may be damaged or use an unsupported method.".to_string());
    }
    let mut stats = ExtractStats {
        warnings,
        ..Default::default()
    };
    // The command above extracts every entry. If the user made a selection,
    // remove unselected files before staging is merged. Directories are pruned
    // only when empty, so a selected file inside them is never deleted.
    if !selected.is_empty() {
        for (name, is_dir, _, _) in &entries {
            if !*is_dir && !selected_entry(name, selected) {
                if let Ok(relative) = safe_relative_path(name.trim_end_matches('/')) {
                    let _ = fs::remove_file(staging.join(relative));
                }
            }
        }
        let mut directories: Vec<PathBuf> = WalkDir::new(staging)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_dir())
            .map(|entry| entry.path().to_path_buf())
            .collect();
        directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for directory in directories {
            if directory != staging {
                let _ = fs::remove_dir(&directory);
            }
        }
    }
    // Validate every extracted entry before merging it into the destination.
    for walked in WalkDir::new(staging).follow_links(false) {
        let walked = walked.map_err(|e| format!("Extracted files couldn't be verified: {e}"))?;
        let file_type = walked.file_type();
        if file_type.is_symlink() {
            return Err(
                "The archive produced a symbolic link, so the extraction was stopped.".to_string(),
            );
        }
        if file_type.is_file() {
            let size = walked.metadata().map(|m| m.len()).unwrap_or(0);
            limits.count_file(size)?;
            stats.files += 1;
            stats.bytes = stats.bytes.saturating_add(size);
        } else if file_type.is_dir() {
            stats.dirs += 1;
        }
    }
    emit_progress(
        app,
        job_id,
        "archive-extract",
        total,
        total,
        None,
        "running",
    );
    Ok(stats)
}

fn extract_single_stream(
    app: Option<&AppHandle>,
    job_id: &str,
    path: &Path,
    format: Format,
    staging: &Path,
    limits: &mut ExtractLimits,
    token: &AtomicBool,
) -> Result<ExtractStats, String> {
    check_cancel(token)?;
    let file = open_archive(path)?;
    let name = safe_relative_path(&derived_stream_name(path, format))?;
    let target = staging.join(name);
    let mut reader: Box<dyn Read> = match format {
        Format::Gzip => Box::new(GzDecoder::new(BufReader::new(file))),
        Format::Bzip2 => Box::new(BzDecoder::new(BufReader::new(file))),
        Format::Xz => Box::new(XzDecoder::new(BufReader::new(file))),
        _ => return Err("Not a single-stream format.".to_string()),
    };
    emit_progress(
        app,
        job_id,
        "archive-extract",
        1,
        0,
        Some(display_name(&path.to_string_lossy())),
        "running",
    );
    let remaining = limits.max_bytes;
    let bytes = write_limited(&mut reader, &target, remaining, 0, limits, None)?;
    let stats = ExtractStats {
        files: 1,
        dirs: 0,
        bytes,
        skipped: 0,
        warnings: vec![],
    };
    emit_progress(app, job_id, "archive-extract", 1, 1, None, "running");
    Ok(stats)
}

fn unique_target_for(path: &Path) -> PathBuf {
    if fs::symlink_metadata(path).is_err() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or(Path::new("."));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let extension = path.extension().map(|e| e.to_string_lossy().into_owned());
    for index in 2..10_000 {
        let name = if let Some(ext) = &extension {
            format!("{stem} ({index}).{ext}")
        } else {
            format!("{stem} ({index})")
        };
        let candidate = parent.join(name);
        if fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
    parent.join(format!("{stem}-copy"))
}

/// Create missing parent folders without ever passing through an existing
/// symlink. A destination folder could already contain a link planted by
/// another process; following it would let an archive write outside the chosen
/// folder, so components are checked one by one.
fn ensure_safe_parents(root: &Path, parent: &Path) -> Result<(), String> {
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| "Extraction path escaped the chosen folder.".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err("Unsafe extraction folder path.".to_string());
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Extraction would pass through an existing symbolic link. Choose a different destination.".to_string());
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err("An extracted folder collides with an existing file. Choose a different destination or conflict setting.".to_string());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|e| format!("Couldn't create {}: {e}", current.display()))?;
            }
            Err(error) => return Err(format!("Couldn't inspect the destination: {error}")),
        }
    }
    Ok(())
}

fn merge_staging(
    staging: &Path,
    root: &Path,
    conflict: &str,
    token: &AtomicBool,
) -> Result<(usize, usize), String> {
    // Cancellation is honoured before the commit begins. Once files start
    // being moved into the destination we finish the (fast, same-volume) commit
    // rather than leave a half-merged folder with no honest outcome to show.
    check_cancel(token)?;
    ensure_dir(root)?;
    let mut moved = 0usize;
    let mut skipped = 0usize;
    let mut dirs = Vec::new();
    for item in WalkDir::new(staging)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if item.path() == staging {
            continue;
        }
        let relative = item
            .path()
            .strip_prefix(staging)
            .map_err(|_| "Invalid extraction staging path.".to_string())?;
        let target = root.join(relative);
        if item.file_type().is_dir() {
            dirs.push((item.path().to_path_buf(), target));
            continue;
        }
        if !item.file_type().is_file() {
            skipped += 1;
            continue;
        }
        if let Some(parent) = target.parent() {
            ensure_safe_parents(root, parent)?;
        }
        let existing = fs::symlink_metadata(&target).ok();
        if let Some(metadata) = existing {
            let is_symlink = metadata.file_type().is_symlink();
            let is_dir = metadata.is_dir() && !is_symlink;
            match conflict {
                "skip" => {
                    skipped += 1;
                    continue;
                }
                "replace" => {
                    if is_symlink || !is_dir {
                        fs::remove_file(&target).map_err(|e| {
                            format!("Couldn't replace existing file {}: {e}", target.display())
                        })?;
                    } else {
                        // Never recursively delete a user's existing directory
                        // for a single file. Only an empty folder can be replaced.
                        if fs::remove_dir(&target).is_err() {
                            skipped += 1;
                            continue;
                        }
                    }
                }
                _ => {
                    let alternative = unique_target_for(&target);
                    fs::rename(item.path(), &alternative)
                        .map_err(|e| format!("Couldn't move extracted file: {e}"))?;
                    moved += 1;
                    continue;
                }
            }
        }
        fs::rename(item.path(), &target)
            .map_err(|e| format!("Couldn't move extracted file into place: {e}"))?;
        moved += 1;
    }
    for (source, target) in dirs.into_iter().rev() {
        if let Some(parent) = target.parent() {
            ensure_safe_parents(root, parent)?;
        }
        if let Ok(metadata) = fs::symlink_metadata(&target) {
            let is_symlink = metadata.file_type().is_symlink();
            if is_symlink || !metadata.is_dir() {
                match conflict {
                    "skip" => {
                        skipped += 1;
                        continue;
                    }
                    "replace" => {
                        if is_symlink || metadata.is_file() {
                            fs::remove_file(&target).map_err(|e| {
                                format!("Couldn't replace existing file {}: {e}", target.display())
                            })?;
                        } else {
                            let _ = fs::remove_dir(&target);
                        }
                    }
                    _ => {
                        // A directory conflicting with a file gets a unique name.
                        let alternative = unique_target_for(&target);
                        fs::rename(&source, &alternative)
                            .map_err(|e| format!("Couldn't move extracted folder: {e}"))?;
                        continue;
                    }
                }
            }
        }
        if fs::symlink_metadata(&target).is_err() {
            fs::create_dir(&target)
                .map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;
        }
    }
    Ok((moved, skipped))
}

pub fn run_extract_archive(
    app: Option<&AppHandle>,
    token: std::sync::Arc<AtomicBool>,
    request: ExtractRequest,
) -> Result<ArchiveJobOutcome, String> {
    let started = Instant::now();
    let plan_request = PlanRequest {
        input: request.input.clone(),
        destination: request.destination.clone(),
        password: request.password.clone(),
        selected: request.selected.clone(),
        folder_mode: request.folder_mode.clone(),
        folder_name: request.folder_name.clone(),
        max_total_mb: request.max_total_mb,
        max_files: request.max_files,
    };
    let (inspection, root, plan) = prepare_plan(&plan_request)?;
    if plan.file_count == 0 {
        return Err("Choose at least one file or folder to extract.".to_string());
    }
    let selected_files = inspection
        .entries
        .iter()
        .filter(|entry| !entry.is_dir && selected_entry(&entry.path, &request.selected))
        .count()
        .max(1);
    let total = selected_files;
    emit_progress(
        app,
        &request.job_id,
        "archive-extract",
        total,
        0,
        Some(inspection.name.clone()),
        "running",
    );
    if cancelled(&token) {
        return Ok(ArchiveJobOutcome {
            job_id: request.job_id,
            output: None,
            destination: None,
            files: 0,
            skipped: 0,
            warnings: vec![],
            errors: vec![],
            cancelled: true,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }
    let destination =
        extraction_destination(Path::new(&request.input), request.destination.as_deref())?;
    ensure_dir(&destination)?;
    let staging = TempBuilder::new()
        .prefix(".reformat-extract-")
        .tempdir_in(&destination)
        .map_err(|e| format!("Couldn't create a safe extraction workspace: {e}"))?;
    let format = Format::detect(Path::new(&request.input))
        .ok_or_else(|| "Unsupported archive format.".to_string())?;
    let mut limits = ExtractLimits::from_request(request.max_total_mb, request.max_files);
    limits.preflight(plan.file_count, plan.total_size)?;
    let stats = match format {
        Format::Zip => extract_zip(
            app,
            &request.job_id,
            Path::new(&request.input),
            request.password.as_deref(),
            staging.path(),
            &request.selected,
            total,
            &mut limits,
            &token,
        ),
        Format::Tar | Format::TarGz | Format::TarBz2 | Format::TarXz => extract_tar(
            app,
            &request.job_id,
            Path::new(&request.input),
            format,
            staging.path(),
            &request.selected,
            total,
            &mut limits,
            &token,
        ),
        Format::SevenZ => extract_sevenz(
            app,
            &request.job_id,
            Path::new(&request.input),
            request.password.as_deref(),
            staging.path(),
            &request.selected,
            total,
            &mut limits,
            &token,
        ),
        Format::Rar => extract_rar(
            app,
            &request.job_id,
            Path::new(&request.input),
            staging.path(),
            &request.selected,
            total,
            &mut limits,
            &token,
        ),
        Format::Gzip | Format::Bzip2 | Format::Xz => extract_single_stream(
            app,
            &request.job_id,
            Path::new(&request.input),
            format,
            staging.path(),
            &mut limits,
            &token,
        ),
    };
    let mut stats = match stats {
        Ok(stats) => stats,
        Err(error) if error == "Cancelled" => {
            emit_progress(
                app,
                &request.job_id,
                "archive-extract",
                total,
                0,
                None,
                "cancelled",
            );
            return Ok(ArchiveJobOutcome {
                job_id: request.job_id,
                output: None,
                destination: None,
                files: 0,
                skipped: 0,
                warnings: vec![],
                errors: vec![],
                cancelled: true,
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
        Err(error) => return Err(error),
    };
    if cancelled(&token) {
        emit_progress(
            app,
            &request.job_id,
            "archive-extract",
            total,
            total,
            None,
            "cancelled",
        );
        return Ok(ArchiveJobOutcome {
            job_id: request.job_id,
            output: None,
            destination: None,
            files: 0,
            skipped: 0,
            warnings: vec![],
            errors: vec![],
            cancelled: true,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }
    let (moved, skipped) = merge_staging(staging.path(), &root, &request.conflict, &token)?;
    stats.files = moved;
    stats.skipped += skipped;
    let _ = stats.bytes;
    emit_progress(
        app,
        &request.job_id,
        "archive-extract",
        total,
        total,
        None,
        "finished",
    );
    Ok(ArchiveJobOutcome {
        job_id: request.job_id,
        output: None,
        destination: Some(root.to_string_lossy().into_owned()),
        files: stats.files,
        skipped: stats.skipped,
        warnings: stats.warnings,
        errors: vec![],
        cancelled: false,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[derive(Debug, Clone)]
struct SourceEntry {
    archive_name: String,
    path: PathBuf,
    is_dir: bool,
    size: u64,
}

fn unique_root_name(name: &str, used: &mut std::collections::HashSet<String>) -> String {
    let base = if name.trim().is_empty() { "item" } else { name };
    if used.insert(base.to_string()) {
        return base.to_string();
    }
    for index in 2..10_000 {
        let candidate = format!("{base}-{index}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    base.to_string()
}

fn collect_sources(
    sources: &[String],
    output: &Path,
    token: &AtomicBool,
) -> Result<(Vec<SourceEntry>, Vec<String>), String> {
    if sources.is_empty() {
        return Err("Choose at least one file or folder to archive.".to_string());
    }
    let output_name = output.file_name().map(|n| n.to_string_lossy().into_owned());
    let mut entries: Vec<SourceEntry> = Vec::new();
    let mut warnings = Vec::new();
    let mut used_roots = std::collections::HashSet::new();
    let mut total_files = 0usize;
    let mut total_bytes = 0u64;
    for raw in sources {
        check_cancel(token)?;
        let source = PathBuf::from(raw);
        let metadata = fs::metadata(&source).map_err(|_| {
            format!(
                "{} can't be read. It may have been moved or deleted.",
                display_name(raw)
            )
        })?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(format!("{} isn't a file or folder.", display_name(raw)));
        }
        let display = display_name(raw);
        if Some(display.clone()) == output_name && source.parent() == output.parent() {
            continue;
        }
        let original_name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "item".to_string());
        let root_name = unique_root_name(&original_name, &mut used_roots);
        let parent = source
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        for walked in WalkDir::new(&source).follow_links(false) {
            let walked = walked.map_err(|e| format!("Couldn't read “{display}”: {e}"))?;
            check_cancel(token)?;
            if walked.file_type().is_symlink() {
                warnings.push(format!(
                    "Skipped symbolic link “{}”.",
                    walked.path().display()
                ));
                continue;
            }
            if walked.path() == source && walked.file_type().is_dir() {
                // Include the folder itself, including an empty folder.
            }
            if !walked.file_type().is_file() && !walked.file_type().is_dir() {
                warnings.push(format!(
                    "Skipped special file “{}”.",
                    walked.path().display()
                ));
                continue;
            }
            let relative = walked
                .path()
                .strip_prefix(&parent)
                .map_err(|_| "Couldn't work out a path inside the selected folder.".to_string())?;
            let mut archive_name = relative
                .components()
                .filter_map(|component| match component {
                    Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/");
            if archive_name.is_empty() {
                archive_name = root_name.clone();
            } else if let Some(stripped) = archive_name.strip_prefix(&format!("{original_name}/")) {
                archive_name = format!("{root_name}/{stripped}");
            } else if archive_name == original_name {
                archive_name = root_name.clone();
            }
            let is_dir = walked.file_type().is_dir();
            let size = if is_dir {
                0
            } else {
                walked.metadata().map(|m| m.len()).unwrap_or(0)
            };
            if !is_dir {
                total_files += 1;
                total_bytes = total_bytes.saturating_add(size);
                if total_files > MAX_CREATE_FILES {
                    return Err(format!(
                        "That selection contains more than {MAX_CREATE_FILES} files. Add a smaller folder or split the archive."
                    ));
                }
                if total_bytes > 64 * 1024 * 1024 * 1024 {
                    return Err(
                        "That selection is larger than 64 GB. Split it into smaller archives."
                            .to_string(),
                    );
                }
            }
            entries.push(SourceEntry {
                archive_name,
                path: walked.path().to_path_buf(),
                is_dir,
                size,
            });
        }
    }
    if entries.is_empty() {
        return Err("There are no readable files or folders in that selection.".to_string());
    }
    entries.sort_by(|a, b| a.archive_name.cmp(&b.archive_name));
    Ok((entries, warnings))
}

fn zip_level(level: &str) -> i64 {
    match level {
        "fast" => 1,
        "maximum" => 9,
        _ => 6,
    }
}

fn gz_level(level: &str) -> GzCompression {
    match level {
        "fast" => GzCompression::fast(),
        "maximum" => GzCompression::best(),
        _ => GzCompression::default(),
    }
}

fn bz_level(level: &str) -> BzCompression {
    match level {
        "fast" => BzCompression::new(1),
        "maximum" => BzCompression::new(9),
        _ => BzCompression::new(6),
    }
}

fn xz_level(level: &str) -> u32 {
    match level {
        "fast" => 1,
        "maximum" => 9,
        _ => 6,
    }
}

fn temp_output_path(dir: &Path, extension: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.join(format!(".reformat-archive-{stamp}.part.{extension}"))
}

fn publish_archive(temp: &Path, target: &Path) -> Result<u64, String> {
    if target.exists() || fs::symlink_metadata(target).is_ok() {
        let _ = fs::remove_file(temp);
        return Err("An archive with that name already exists. Choose another name.".to_string());
    }
    fs::rename(temp, target).map_err(|e| {
        let _ = fs::remove_file(temp);
        format!("Couldn't save the archive: {e}")
    })?;
    fs::metadata(target)
        .map(|m| m.len())
        .map_err(|e| format!("Couldn't inspect the new archive: {e}"))
}

fn copy_file_into_zip<W: Write + Seek>(
    writer: &mut ZipWriter<W>,
    entry: &SourceEntry,
    compression: i64,
    password: Option<&str>,
    token: &AtomicBool,
) -> Result<(), String> {
    check_cancel(token)?;
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(compression))
        .unix_permissions(0o644)
        .large_file(true);
    if let Some(password) = password.filter(|p| !p.is_empty()) {
        let options = options.with_aes_encryption(AesMode::Aes256, password);
        writer
            .start_file(entry.archive_name.clone(), options)
            .map_err(|e| format!("Couldn't add “{}” to the ZIP: {e}", entry.archive_name))?;
    } else {
        writer
            .start_file(entry.archive_name.clone(), options)
            .map_err(|e| format!("Couldn't add “{}” to the ZIP: {e}", entry.archive_name))?;
    }
    let mut source = File::open(&entry.path)
        .map_err(|e| format!("Couldn't read “{}”: {e}", entry.path.display()))?;
    io::copy(&mut source, writer)
        .map_err(|e| format!("Couldn't write “{}” into the ZIP: {e}", entry.archive_name))?;
    Ok(())
}

fn create_zip(
    app: Option<&AppHandle>,
    job_id: &str,
    entries: &[SourceEntry],
    target: &Path,
    level: &str,
    password: Option<&str>,
    token: &AtomicBool,
) -> Result<u64, String> {
    let temp = temp_output_path(target.parent().unwrap_or(Path::new(".")), "zip");
    let result = (|| -> Result<u64, String> {
        let file = File::create(&temp).map_err(|e| format!("Couldn't create the archive: {e}"))?;
        let mut writer = ZipWriter::new(BufWriter::new(file));
        let compression = zip_level(level);
        let total = entries.len();
        for (index, entry) in entries.iter().enumerate() {
            check_cancel(token)?;
            if entry.is_dir {
                let options = SimpleFileOptions::default().unix_permissions(0o755);
                writer
                    .add_directory(
                        format!("{}/", entry.archive_name.trim_end_matches('/')),
                        options,
                    )
                    .map_err(|e| format!("Couldn't add a folder to the ZIP: {e}"))?;
            } else {
                copy_file_into_zip(&mut writer, entry, compression, password, token)?;
            }
            emit_progress(
                app,
                job_id,
                "archive-create",
                total,
                index + 1,
                Some(entry.archive_name.clone()),
                "running",
            );
        }
        let buffered = writer
            .finish()
            .map_err(|e| format!("Couldn't finish the ZIP: {e}"))?;
        let file = buffered
            .into_inner()
            .map_err(|e| format!("Couldn't finish writing the ZIP: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Couldn't flush the ZIP: {e}"))?;
        let size = fs::metadata(&temp)
            .map_err(|e| format!("Couldn't inspect the ZIP: {e}"))?
            .len();
        publish_archive(&temp, target).map(|_| size)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn create_tar(
    app: Option<&AppHandle>,
    job_id: &str,
    entries: &[SourceEntry],
    target: &Path,
    format: Format,
    level: &str,
    token: &AtomicBool,
) -> Result<u64, String> {
    let temp = temp_output_path(target.parent().unwrap_or(Path::new(".")), "tar");
    let result = (|| -> Result<u64, String> {
        let file = File::create(&temp).map_err(|e| format!("Couldn't create the archive: {e}"))?;
        let total = entries.len();
        match format {
            Format::Tar => {
                let mut builder = TarBuilder::new(file);
                write_tar_entries(app, job_id, entries, &mut builder, total, token)?;
                builder
                    .finish()
                    .map_err(|e| format!("Couldn't finish the TAR: {e}"))?;
            }
            Format::TarGz => {
                let encoder = GzEncoder::new(file, gz_level(level));
                let mut builder = TarBuilder::new(encoder);
                write_tar_entries(app, job_id, entries, &mut builder, total, token)?;
                let encoder = builder
                    .into_inner()
                    .map_err(|e| format!("Couldn't finish the TAR: {e}"))?;
                let file = encoder
                    .finish()
                    .map_err(|e| format!("Couldn't finish the GZIP stream: {e}"))?;
                file.sync_all()
                    .map_err(|e| format!("Couldn't flush the archive: {e}"))?;
            }
            Format::TarBz2 => {
                let encoder = BzEncoder::new(file, bz_level(level));
                let mut builder = TarBuilder::new(encoder);
                write_tar_entries(app, job_id, entries, &mut builder, total, token)?;
                let encoder = builder
                    .into_inner()
                    .map_err(|e| format!("Couldn't finish the TAR: {e}"))?;
                let file = encoder
                    .finish()
                    .map_err(|e| format!("Couldn't finish the BZIP2 stream: {e}"))?;
                file.sync_all()
                    .map_err(|e| format!("Couldn't flush the archive: {e}"))?;
            }
            Format::TarXz => {
                let encoder = XzEncoder::new(file, xz_level(level));
                let mut builder = TarBuilder::new(encoder);
                write_tar_entries(app, job_id, entries, &mut builder, total, token)?;
                let encoder = builder
                    .into_inner()
                    .map_err(|e| format!("Couldn't finish the TAR: {e}"))?;
                let file = encoder
                    .finish()
                    .map_err(|e| format!("Couldn't finish the XZ stream: {e}"))?;
                file.sync_all()
                    .map_err(|e| format!("Couldn't flush the archive: {e}"))?;
            }
            _ => return Err("Not a TAR format.".to_string()),
        }
        let size = fs::metadata(&temp)
            .map_err(|e| format!("Couldn't inspect the archive: {e}"))?
            .len();
        publish_archive(&temp, target).map(|_| size)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn write_tar_entries<W: Write>(
    app: Option<&AppHandle>,
    job_id: &str,
    entries: &[SourceEntry],
    builder: &mut TarBuilder<W>,
    total: usize,
    token: &AtomicBool,
) -> Result<(), String> {
    for (index, entry) in entries.iter().enumerate() {
        check_cancel(token)?;
        if entry.is_dir {
            let mut header = Header::new_gnu();
            header.set_entry_type(EntryType::Directory);
            header.set_mode(0o755);
            header.set_size(0);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    format!("{}/", entry.archive_name.trim_end_matches('/')),
                    io::empty(),
                )
                .map_err(|e| format!("Couldn't add a folder to the archive: {e}"))?;
        } else {
            let metadata = fs::metadata(&entry.path)
                .map_err(|e| format!("Couldn't read “{}”: {e}", entry.path.display()))?;
            let mut source = File::open(&entry.path)
                .map_err(|e| format!("Couldn't read “{}”: {e}", entry.path.display()))?;
            let mut header = Header::new_gnu();
            header.set_entry_type(EntryType::Regular);
            header.set_mode(if metadata.permissions().readonly() {
                0o444
            } else {
                0o644
            });
            header.set_size(entry.size);
            header.set_mtime(file_modified(&entry.path).unwrap_or(0));
            header.set_cksum();
            builder
                .append_data(&mut header, &entry.archive_name, &mut source)
                .map_err(|e| {
                    format!("Couldn't add “{}” to the archive: {e}", entry.archive_name)
                })?;
        }
        emit_progress(
            app,
            job_id,
            "archive-create",
            total,
            index + 1,
            Some(entry.archive_name.clone()),
            "running",
        );
    }
    Ok(())
}

fn create_sevenz(
    app: Option<&AppHandle>,
    job_id: &str,
    entries: &[SourceEntry],
    target: &Path,
    password: Option<&str>,
    token: &AtomicBool,
) -> Result<u64, String> {
    let temp = temp_output_path(target.parent().unwrap_or(Path::new(".")), "7z");
    let result = (|| -> Result<u64, String> {
        let mut writer = SevenZWriter::create(&temp)
            .map_err(|e| format!("Couldn't create the 7Z archive: {e}"))?;
        if let Some(password) = password.filter(|p| !p.is_empty()) {
            writer.set_content_methods(vec![
                sevenz_rust::AesEncoderOptions::new(Password::from(password)).into(),
                sevenz_rust::SevenZMethod::LZMA2.into(),
            ]);
        }
        let total = entries.len();
        for (index, entry) in entries.iter().enumerate() {
            check_cancel(token)?;
            let archive_entry =
                SevenZArchiveEntry::from_path(&entry.path, entry.archive_name.clone());
            if entry.is_dir {
                writer
                    .push_archive_entry::<&[u8]>(archive_entry, None)
                    .map_err(|e| format!("Couldn't add a folder to the 7Z: {e}"))?;
            } else {
                let file = File::open(&entry.path)
                    .map_err(|e| format!("Couldn't read “{}”: {e}", entry.path.display()))?;
                writer
                    .push_archive_entry(archive_entry, Some(file))
                    .map_err(|e| format!("Couldn't add “{}” to the 7Z: {e}", entry.archive_name))?;
            }
            emit_progress(
                app,
                job_id,
                "archive-create",
                total,
                index + 1,
                Some(entry.archive_name.clone()),
                "running",
            );
        }
        let file = writer
            .finish()
            .map_err(|e| format!("Couldn't finish the 7Z archive: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Couldn't flush the 7Z archive: {e}"))?;
        let size = fs::metadata(&temp)
            .map_err(|e| format!("Couldn't inspect the 7Z archive: {e}"))?
            .len();
        publish_archive(&temp, target).map(|_| size)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn create_single_stream(
    app: Option<&AppHandle>,
    job_id: &str,
    source: &SourceEntry,
    target: &Path,
    format: Format,
    level: &str,
    token: &AtomicBool,
) -> Result<u64, String> {
    let temp = temp_output_path(
        target.parent().unwrap_or(Path::new(".")),
        format.extension(),
    );
    let result = (|| -> Result<u64, String> {
        check_cancel(token)?;
        let out =
            File::create(&temp).map_err(|e| format!("Couldn't create the compressed file: {e}"))?;
        let mut input = BufReader::new(
            File::open(&source.path)
                .map_err(|e| format!("Couldn't read “{}”: {e}", source.path.display()))?,
        );
        match format {
            Format::Gzip => {
                let mut encoder = GzEncoder::new(BufWriter::new(out), gz_level(level));
                io::copy(&mut input, &mut encoder)
                    .map_err(|e| format!("Compression failed: {e}"))?;
                let writer = encoder
                    .finish()
                    .map_err(|e| format!("Compression failed: {e}"))?;
                let file = writer
                    .into_inner()
                    .map_err(|e| format!("Couldn't finish the GZIP: {e}"))?;
                file.sync_all()
                    .map_err(|e| format!("Couldn't flush the GZIP: {e}"))?;
            }
            Format::Bzip2 => {
                let mut encoder = BzEncoder::new(BufWriter::new(out), bz_level(level));
                io::copy(&mut input, &mut encoder)
                    .map_err(|e| format!("Compression failed: {e}"))?;
                let writer = encoder
                    .finish()
                    .map_err(|e| format!("Compression failed: {e}"))?;
                let file = writer
                    .into_inner()
                    .map_err(|e| format!("Couldn't finish the BZIP2: {e}"))?;
                file.sync_all()
                    .map_err(|e| format!("Couldn't flush the BZIP2: {e}"))?;
            }
            Format::Xz => {
                let mut encoder = XzEncoder::new(BufWriter::new(out), xz_level(level));
                io::copy(&mut input, &mut encoder)
                    .map_err(|e| format!("Compression failed: {e}"))?;
                let writer = encoder
                    .finish()
                    .map_err(|e| format!("Compression failed: {e}"))?;
                let file = writer
                    .into_inner()
                    .map_err(|e| format!("Couldn't finish the XZ: {e}"))?;
                file.sync_all()
                    .map_err(|e| format!("Couldn't flush the XZ: {e}"))?;
            }
            _ => return Err("Not a single-file compression format.".to_string()),
        }
        emit_progress(
            app,
            job_id,
            "archive-create",
            1,
            1,
            Some(source.archive_name.clone()),
            "running",
        );
        let size = fs::metadata(&temp)
            .map_err(|e| format!("Couldn't inspect the compressed file: {e}"))?
            .len();
        publish_archive(&temp, target).map(|_| size)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub fn run_create_archive(
    app: Option<&AppHandle>,
    token: std::sync::Arc<AtomicBool>,
    request: CreateRequest,
) -> Result<ArchiveJobOutcome, String> {
    let started = Instant::now();
    let format = Format::from_id(&request.format)
        .ok_or_else(|| "Choose a supported archive format.".to_string())?;
    if !format.can_create() {
        return Err("Creating RAR archives isn't supported. Choose ZIP, 7Z, TAR, TAR.GZ, TAR.BZ2, TAR.XZ, GZIP, BZIP2, or XZ.".to_string());
    }
    let password = request.password.as_deref().filter(|p| !p.is_empty());
    if password.is_some() && !format.can_password() {
        return Err(format!(
            "{} doesn't support passwords in Reformat. Choose ZIP or 7Z for an encrypted archive.",
            format.label()
        ));
    }
    let source_path = PathBuf::from(
        request
            .sources
            .first()
            .ok_or_else(|| "Choose something to archive.".to_string())?,
    );
    let source_meta = fs::metadata(&source_path).map_err(|_| {
        "The first selected item can't be read. It may have been moved or deleted.".to_string()
    })?;
    if !source_meta.is_file() && !source_meta.is_dir() {
        return Err("Choose a file or folder to archive.".to_string());
    }
    let output_dir = prepare_output_dir(&source_path, request.output_dir.as_deref())?;
    let stem = sanitize_stem(
        &strip_known_extension(if request.file_name.trim().is_empty() {
            "archive"
        } else {
            &request.file_name
        }),
        "archive",
    );
    let target = unique_output_path(&output_dir, &stem, format.extension());
    emit_progress(
        app,
        &request.job_id,
        "archive-create",
        0,
        0,
        None,
        "running",
    );
    let (mut entries, warnings) = match collect_sources(&request.sources, &target, &token) {
        Ok(value) => value,
        Err(error) if error == "Cancelled" => {
            emit_progress(
                app,
                &request.job_id,
                "archive-create",
                0,
                0,
                None,
                "cancelled",
            );
            return Ok(ArchiveJobOutcome {
                job_id: request.job_id,
                output: None,
                destination: None,
                files: 0,
                skipped: 0,
                warnings: vec![],
                errors: vec![],
                cancelled: true,
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
        Err(error) => return Err(error),
    };
    if format.is_single_stream() {
        let files: Vec<&SourceEntry> = entries.iter().filter(|entry| !entry.is_dir).collect();
        if files.len() != 1 || entries.len() != files.len() {
            return Err(format!(
                "{} compression handles one file at a time. Choose a ZIP or TAR format for multiple files and folders.",
                format.label()
            ));
        }
    }
    if format.is_single_stream() {
        entries.retain(|entry| !entry.is_dir);
    }
    if entries.is_empty() {
        return Err("There are no files to archive.".to_string());
    }
    emit_progress(
        app,
        &request.job_id,
        "archive-create",
        entries.len(),
        0,
        entries.first().map(|entry| entry.archive_name.clone()),
        "running",
    );
    let size = if cancelled(&token) {
        return Ok(ArchiveJobOutcome {
            job_id: request.job_id,
            output: None,
            destination: None,
            files: 0,
            skipped: 0,
            warnings,
            errors: vec![],
            cancelled: true,
            elapsed_ms: started.elapsed().as_millis(),
        });
    } else {
        let result = match format {
            Format::Zip => create_zip(
                app,
                &request.job_id,
                &entries,
                &target,
                &request.level,
                password,
                &token,
            ),
            Format::SevenZ => {
                create_sevenz(app, &request.job_id, &entries, &target, password, &token)
            }
            Format::Tar | Format::TarGz | Format::TarBz2 | Format::TarXz => create_tar(
                app,
                &request.job_id,
                &entries,
                &target,
                format,
                &request.level,
                &token,
            ),
            Format::Gzip | Format::Bzip2 | Format::Xz => create_single_stream(
                app,
                &request.job_id,
                &entries[0],
                &target,
                format,
                &request.level,
                &token,
            ),
            Format::Rar => unreachable!(),
        };
        match result {
            Ok(size) => size,
            Err(error) if error == "Cancelled" => {
                return Ok(ArchiveJobOutcome {
                    job_id: request.job_id,
                    output: None,
                    destination: None,
                    files: 0,
                    skipped: 0,
                    warnings,
                    errors: vec![],
                    cancelled: true,
                    elapsed_ms: started.elapsed().as_millis(),
                });
            }
            Err(error) => return Err(error),
        }
    };
    emit_progress(
        app,
        &request.job_id,
        "archive-create",
        entries.len(),
        entries.len(),
        None,
        "finished",
    );
    Ok(ArchiveJobOutcome {
        job_id: request.job_id,
        output: Some(OutputFile {
            path: target.to_string_lossy().into_owned(),
            name: target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "archive".to_string()),
            source_path: request.sources[0].clone(),
            bytes: size,
            width: None,
            height: None,
            pages: None,
        }),
        destination: None,
        files: entries.iter().filter(|entry| !entry.is_dir).count(),
        skipped: 0,
        warnings,
        errors: vec![],
        cancelled: false,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveTestOutcome {
    pub path: String,
    pub ok: bool,
    pub checked: usize,
    pub message: String,
    pub cancelled: bool,
    pub elapsed_ms: u128,
}

fn test_zip_data(path: &Path, password: Option<&str>, token: &AtomicBool) -> Result<usize, String> {
    let file = open_archive(path)?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("ZIP couldn't be opened: {e}"))?;
    let mut checked = 0usize;
    for index in 0..archive.len() {
        check_cancel(token)?;
        let raw = archive
            .by_index_raw(index)
            .map_err(|e| format!("ZIP entry {} couldn't be read: {e}", index + 1))?;
        if raw.is_dir() {
            continue;
        }
        let encrypted = raw.encrypted();
        drop(raw);
        let mut entry = if encrypted {
            let password = password.filter(|p| !p.is_empty()).ok_or_else(|| {
                "This ZIP is password-protected. Enter its password to test it.".to_string()
            })?;
            archive
                .by_index_decrypt(index, password.as_bytes())
                .map_err(|_| "The ZIP password is incorrect.".to_string())?
        } else {
            archive
                .by_index(index)
                .map_err(|e| format!("ZIP entry couldn't be read: {e}"))?
        };
        io::copy(&mut entry, &mut io::sink())
            .map_err(|e| format!("ZIP data failed its checksum test: {e}"))?;
        checked += 1;
    }
    Ok(checked)
}

fn test_tar_data(path: &Path, format: Format, token: &AtomicBool) -> Result<usize, String> {
    let reader = tar_reader(path, format)?;
    let mut archive = TarArchive::new(reader);
    let mut checked = 0usize;
    let entries = archive
        .entries()
        .map_err(|e| format!("TAR couldn't be read: {e}"))?;
    for item in entries {
        check_cancel(token)?;
        let mut entry = item.map_err(|e| format!("TAR entry couldn't be read: {e}"))?;
        if entry.header().entry_type().is_file() {
            io::copy(&mut entry, &mut io::sink())
                .map_err(|e| format!("TAR data failed validation: {e}"))?;
            checked += 1;
        }
    }
    Ok(checked)
}

fn test_sevenz_data(
    path: &Path,
    password: Option<&str>,
    token: &AtomicBool,
) -> Result<usize, String> {
    let pass = Password::from(password.unwrap_or(""));
    let mut reader =
        SevenZReader::open(path, pass).map_err(|e| format!("7Z couldn't be opened: {e}"))?;
    let mut checked = 0usize;
    let mut failure: Option<String> = None;
    let cancel = token;
    let result = reader.for_each_entries(|entry, data| {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            failure = Some("Cancelled".to_string());
            return Err(sevenz_rust::Error::other("Cancelled"));
        }
        if entry.is_directory() {
            return Ok(true);
        }
        if let Err(error) = io::copy(data, &mut io::sink()) {
            failure = Some(format!("7Z data failed validation: {error}"));
            return Err(sevenz_rust::Error::other("validation failed"));
        }
        checked += 1;
        Ok(true)
    });
    if let Some(error) = failure {
        return Err(error);
    }
    result.map_err(|e| format!("7Z integrity check failed: {e}"))?;
    Ok(checked)
}

fn test_single_stream(path: &Path, format: Format, token: &AtomicBool) -> Result<usize, String> {
    check_cancel(token)?;
    let file = open_archive(path)?;
    let mut reader: Box<dyn Read> = match format {
        Format::Gzip => Box::new(GzDecoder::new(BufReader::new(file))),
        Format::Bzip2 => Box::new(BzDecoder::new(BufReader::new(file))),
        Format::Xz => Box::new(XzDecoder::new(BufReader::new(file))),
        _ => return Err("Not a single-stream format.".to_string()),
    };
    io::copy(&mut reader, &mut io::sink())
        .map_err(|e| format!("Compressed data failed validation: {e}"))?;
    Ok(1)
}

fn test_rar_data(path: &Path, token: &AtomicBool) -> Result<usize, String> {
    check_cancel(token)?;
    let (entries, _) = rar_list(path)?;
    if entries.iter().any(|(_, _, _, is_link)| *is_link) {
        return Err(
            "This RAR contains symbolic links; integrity testing was skipped for safety."
                .to_string(),
        );
    }
    let temp = tempfile::tempdir().map_err(|e| format!("Couldn't create a test workspace: {e}"))?;
    let root = temp.path().to_path_buf();
    let max_bytes = DEFAULT_MAX_EXTRACT_BYTES;
    let max_files = DEFAULT_MAX_EXTRACT_FILES;
    let mut guard = || -> Result<(), String> {
        let (bytes, files) = walk_size_and_count(&root)?;
        if bytes > max_bytes {
            return Err("This RAR expands beyond the safety limit.".to_string());
        }
        if files > max_files as usize {
            return Err("This RAR contains more files than the safety limit allows.".to_string());
        }
        Ok(())
    };
    let mut command = Command::new("/usr/bin/bsdtar");
    command
        .env("LC_ALL", "C")
        .args(["-xf"])
        .arg(path)
        .arg("-C")
        .arg(temp.path());
    let output = run_command_bounded(
        command,
        Duration::from_secs(600),
        Some(token),
        Some(&mut guard),
    )?;
    if !output.status.success() {
        return Err("RAR data failed its integrity check.".to_string());
    }
    Ok(entries.iter().filter(|(_, is_dir, _, _)| !*is_dir).count())
}

pub fn run_archive_test(
    app: Option<&AppHandle>,
    token: std::sync::Arc<AtomicBool>,
    request: ArchiveTestRequest,
) -> Result<ArchiveTestOutcome, String> {
    let started = Instant::now();
    let path = request.path;
    let password = request.password;
    let parsed = validate_input_file(&path)?;
    let format =
        Format::detect(&parsed).ok_or_else(|| "Unsupported archive format.".to_string())?;
    let inspection = match archive_inspect(InspectRequest {
        path: path.clone(),
        password: password.clone(),
    }) {
        Ok(inspection) => inspection,
        Err(error) => {
            return Ok(ArchiveTestOutcome {
                path,
                ok: false,
                checked: 0,
                message: error,
                cancelled: false,
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
    };
    let limits = ExtractLimits::from_request(None, None);
    if let Err(error) = limits.preflight(inspection.file_count, inspection.total_size) {
        return Ok(ArchiveTestOutcome {
            path,
            ok: false,
            checked: 0,
            message: error,
            cancelled: false,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }
    emit_progress(
        app,
        &request.job_id,
        "archive-test",
        inspection.file_count.max(1),
        0,
        Some(inspection.name.clone()),
        "running",
    );
    let result = match format {
        Format::Zip => test_zip_data(&parsed, password.as_deref(), &token),
        Format::Tar | Format::TarGz | Format::TarBz2 | Format::TarXz => {
            test_tar_data(&parsed, format, &token)
        }
        Format::SevenZ => test_sevenz_data(&parsed, password.as_deref(), &token),
        Format::Rar => test_rar_data(&parsed, &token),
        Format::Gzip | Format::Bzip2 | Format::Xz => test_single_stream(&parsed, format, &token),
    };
    let cancelled = token.load(std::sync::atomic::Ordering::SeqCst);
    let outcome = match result {
        Ok(checked) => ArchiveTestOutcome {
            path,
            ok: true,
            checked,
            message: format!(
                "{checked} file{} verified. The archive is readable.",
                if checked == 1 { "" } else { "s" }
            ),
            cancelled,
            elapsed_ms: started.elapsed().as_millis(),
        },
        Err(error) if error == "Cancelled" => ArchiveTestOutcome {
            path,
            ok: false,
            checked: 0,
            message: "Integrity test cancelled.".to_string(),
            cancelled: true,
            elapsed_ms: started.elapsed().as_millis(),
        },
        Err(error) => ArchiveTestOutcome {
            path,
            ok: false,
            checked: 0,
            message: error,
            cancelled,
            elapsed_ms: started.elapsed().as_millis(),
        },
    };
    emit_progress(
        app,
        &request.job_id,
        "archive-test",
        inspection.file_count.max(1),
        if outcome.ok { inspection.file_count } else { 0 },
        None,
        if outcome.cancelled {
            "cancelled"
        } else {
            "finished"
        },
    );
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn token() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    fn make_tree(root: &Path) {
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("notes.txt"), b"hello from the original").unwrap();
        fs::write(root.join("nested/info.txt"), b"nested content").unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
    }

    fn create_zip(path: &Path, files: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        for (name, data) in files {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap();
    }

    fn create_request(
        sources: Vec<String>,
        output_dir: &Path,
        format: &str,
        password: Option<&str>,
    ) -> CreateRequest {
        CreateRequest {
            job_id: "archive-create-test".into(),
            sources,
            output_dir: Some(output_dir.to_string_lossy().into_owned()),
            file_name: "bundle".into(),
            format: format.into(),
            level: "fast".into(),
            password: password.map(str::to_string),
        }
    }

    fn extract_request(input: &Path, dest: &Path, conflict: &str) -> ExtractRequest {
        ExtractRequest {
            job_id: "archive-extract-test".into(),
            input: input.to_string_lossy().into_owned(),
            destination: Some(dest.to_string_lossy().into_owned()),
            password: None,
            conflict: conflict.into(),
            selected: vec![],
            folder_mode: "never".into(),
            folder_name: None,
            max_total_mb: Some(64),
            max_files: Some(1000),
        }
    }

    #[test]
    fn zip_round_trip_preserves_structure_and_content() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("my-folder");
        make_tree(&source);
        let output_dir = dir.path().join("out");
        fs::create_dir_all(&output_dir).unwrap();
        let outcome = run_create_archive(
            None,
            token(),
            create_request(
                vec![source.to_string_lossy().into_owned()],
                &output_dir,
                "zip",
                None,
            ),
        )
        .unwrap();
        assert!(!outcome.cancelled);
        let archive = PathBuf::from(&outcome.output.as_ref().unwrap().path);
        assert!(archive.exists());
        assert!(
            source.join("notes.txt").exists(),
            "original must remain untouched"
        );

        let inspection = archive_inspect(InspectRequest {
            path: archive.to_string_lossy().into_owned(),
            password: None,
        })
        .unwrap();
        assert_eq!(inspection.format, "zip");
        assert_eq!(inspection.file_count, 2);
        assert!(inspection
            .entries
            .iter()
            .any(|e| e.path.ends_with("nested/info.txt")));

        let dest = dir.path().join("extracted");
        fs::create_dir_all(&dest).unwrap();
        let extracted =
            run_extract_archive(None, token(), extract_request(&archive, &dest, "rename")).unwrap();
        assert_eq!(extracted.files, 2);
        assert_eq!(
            fs::read(dest.join("my-folder/notes.txt")).unwrap(),
            b"hello from the original"
        );
        assert_eq!(
            fs::read(dest.join("my-folder/nested/info.txt")).unwrap(),
            b"nested content"
        );
        assert!(dest.join("my-folder/empty").is_dir());
    }

    #[test]
    fn tar_gz_and_single_stream_round_trips_work() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("payload.txt");
        fs::write(&source, b"compressed payload").unwrap();
        let output_dir = dir.path().join("out");
        fs::create_dir_all(&output_dir).unwrap();
        let created = run_create_archive(
            None,
            token(),
            create_request(
                vec![source.to_string_lossy().into_owned()],
                &output_dir,
                "tar.gz",
                None,
            ),
        )
        .unwrap();
        let archive = PathBuf::from(&created.output.unwrap().path);
        let inspection = archive_inspect(InspectRequest {
            path: archive.to_string_lossy().into_owned(),
            password: None,
        })
        .unwrap();
        assert_eq!(inspection.format, "tar.gz");
        let dest = dir.path().join("extracted");
        fs::create_dir_all(&dest).unwrap();
        run_extract_archive(None, token(), extract_request(&archive, &dest, "rename")).unwrap();
        assert_eq!(
            fs::read(dest.join("payload.txt")).unwrap(),
            b"compressed payload"
        );

        for format in ["gzip", "bzip2", "xz"] {
            let created = run_create_archive(
                None,
                token(),
                create_request(
                    vec![source.to_string_lossy().into_owned()],
                    &output_dir,
                    format,
                    None,
                ),
            )
            .unwrap();
            let archive = PathBuf::from(&created.output.unwrap().path);
            let dest = dir.path().join(format!("extracted-{format}"));
            fs::create_dir_all(&dest).unwrap();
            run_extract_archive(None, token(), extract_request(&archive, &dest, "rename")).unwrap();
            let extracted = fs::read_dir(&dest)
                .unwrap()
                .filter_map(Result::ok)
                .find(|entry| entry.path().is_file())
                .expect("a decompressed file");
            assert_eq!(fs::read(extracted.path()).unwrap(), b"compressed payload");
        }
    }

    #[test]
    fn zip_path_traversal_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("evil.zip");
        create_zip(&archive, &[("../escaped.txt", b"no")]);
        let dest = dir.path().join("safe");
        fs::create_dir_all(&dest).unwrap();
        let error = run_extract_archive(None, token(), extract_request(&archive, &dest, "rename"))
            .unwrap_err();
        assert!(error.contains("Unsafe archive path"));
        assert!(!dir.path().join("escaped.txt").exists());
    }

    #[test]
    fn collisions_are_resolved_without_silent_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("collision.zip");
        create_zip(&archive, &[("a.txt", b"new content")]);
        let dest = dir.path().join("dest");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("a.txt"), b"old content").unwrap();

        let extracted =
            run_extract_archive(None, token(), extract_request(&archive, &dest, "rename")).unwrap();
        assert_eq!(extracted.files, 1);
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"old content");
        assert_eq!(fs::read(dest.join("a (2).txt")).unwrap(), b"new content");

        let skipped =
            run_extract_archive(None, token(), extract_request(&archive, &dest, "skip")).unwrap();
        assert_eq!(skipped.files, 0);
        assert_eq!(skipped.skipped, 1);

        run_extract_archive(None, token(), extract_request(&archive, &dest, "replace")).unwrap();
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"new content");
    }

    #[test]
    fn password_zip_is_detected_and_extracts_with_the_right_password() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("secret.txt");
        fs::write(&source, b"private").unwrap();
        let out = dir.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let created = run_create_archive(
            None,
            token(),
            create_request(
                vec![source.to_string_lossy().into_owned()],
                &out,
                "zip",
                Some("correct horse battery staple"),
            ),
        )
        .unwrap();
        let archive = PathBuf::from(&created.output.unwrap().path);
        let inspection = archive_inspect(InspectRequest {
            path: archive.to_string_lossy().into_owned(),
            password: None,
        })
        .unwrap();
        assert!(inspection.encrypted);
        let dest = dir.path().join("dest");
        fs::create_dir_all(&dest).unwrap();
        let mut request = extract_request(&archive, &dest, "rename");
        let error = run_extract_archive(None, token(), request.clone()).unwrap_err();
        assert!(error.to_ascii_lowercase().contains("password"));
        request.password = Some("correct horse battery staple".into());
        let outcome = run_extract_archive(None, token(), request).unwrap();
        assert_eq!(outcome.files, 1);
        assert_eq!(fs::read(dest.join("secret.txt")).unwrap(), b"private");
    }

    #[test]
    fn extraction_limits_block_bombs() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("bomb.zip");
        let big = vec![0u8; 5 * 1024 * 1024];
        create_zip(&archive, &[("zeros.bin", &big)]);
        let dest = dir.path().join("dest");
        fs::create_dir_all(&dest).unwrap();
        let mut request = extract_request(&archive, &dest, "rename");
        request.max_total_mb = Some(1);
        let error = run_extract_archive(None, token(), request).unwrap_err();
        assert!(error.contains("safety limit"));
        assert!(!dest.join("zeros.bin").exists());
    }

    #[test]
    fn integrity_test_reports_corrupt_archives() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("good.zip");
        create_zip(&good, &[("ok.txt", b"integrity")]);
        let inspection = archive_inspect(InspectRequest {
            path: good.to_string_lossy().into_owned(),
            password: None,
        })
        .unwrap();
        assert_eq!(inspection.file_count, 1);
        let result = run_archive_test(
            None,
            token(),
            ArchiveTestRequest {
                job_id: "test".into(),
                path: good.to_string_lossy().into_owned(),
                password: None,
            },
        )
        .unwrap();
        assert!(result.ok);

        let broken = dir.path().join("broken.zip");
        let bytes = fs::read(&good).unwrap();
        fs::write(&broken, &bytes[..bytes.len() / 2]).unwrap();
        let result = run_archive_test(
            None,
            token(),
            ArchiveTestRequest {
                job_id: "test".into(),
                path: broken.to_string_lossy().into_owned(),
                password: None,
            },
        )
        .unwrap();
        assert!(!result.ok);
    }

    #[test]
    fn sevenz_round_trip_and_encryption_work() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("sevenz-source");
        make_tree(&source);
        let out = dir.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let created = run_create_archive(
            None,
            token(),
            create_request(
                vec![source.to_string_lossy().into_owned()],
                &out,
                "7z",
                None,
            ),
        )
        .unwrap();
        let archive = PathBuf::from(&created.output.unwrap().path);
        let inspection = archive_inspect(InspectRequest {
            path: archive.to_string_lossy().into_owned(),
            password: None,
        })
        .unwrap();
        assert_eq!(inspection.format, "7z");
        assert_eq!(inspection.file_count, 2);
        let dest = dir.path().join("sevenz-out");
        fs::create_dir_all(&dest).unwrap();
        let extracted =
            run_extract_archive(None, token(), extract_request(&archive, &dest, "rename")).unwrap();
        assert_eq!(extracted.files, 2);
        assert_eq!(
            fs::read(dest.join("sevenz-source/notes.txt")).unwrap(),
            b"hello from the original"
        );

        let encrypted = run_create_archive(
            None,
            token(),
            create_request(
                vec![source.to_string_lossy().into_owned()],
                &out,
                "7z",
                Some("sevenz-password"),
            ),
        )
        .unwrap();
        let encrypted_path = PathBuf::from(&encrypted.output.unwrap().path);
        let inspect_without = archive_inspect(InspectRequest {
            path: encrypted_path.to_string_lossy().into_owned(),
            password: None,
        });
        assert!(inspect_without.is_err());
        let inspect_with = archive_inspect(InspectRequest {
            path: encrypted_path.to_string_lossy().into_owned(),
            password: Some("sevenz-password".into()),
        });
        assert!(inspect_with.is_ok());
    }

    #[test]
    fn rar_inspection_and_extraction_work_on_a_fixture() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("sample.rar");
        fs::write(
            &archive,
            include_bytes!("../tests/fixtures/rar5_stored.rar"),
        )
        .unwrap();
        let inspection = archive_inspect(InspectRequest {
            path: archive.to_string_lossy().into_owned(),
            password: None,
        })
        .unwrap();
        assert_eq!(inspection.format, "rar");
        assert_eq!(inspection.file_count, 1);
        assert!(inspection
            .entries
            .iter()
            .any(|entry| entry.path == "helloworld.txt"));
        assert!(!inspection.can_create);
        let dest = dir.path().join("rar-out");
        fs::create_dir_all(&dest).unwrap();
        let extracted =
            run_extract_archive(None, token(), extract_request(&archive, &dest, "rename")).unwrap();
        assert_eq!(extracted.files, 1);
        let content = fs::read_to_string(dest.join("helloworld.txt")).unwrap();
        assert!(content.contains("hello libarchive test suite"));
    }

    #[test]
    fn rar_selection_extracts_only_the_chosen_files() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("many.rar");
        fs::write(&archive, include_bytes!("../tests/fixtures/rar5_many.rar")).unwrap();
        let dest = dir.path().join("rar-selected");
        fs::create_dir_all(&dest).unwrap();
        let mut request = extract_request(&archive, &dest, "rename");
        request.selected = vec!["cebula.txt".into()];
        let outcome = run_extract_archive(None, token(), request).unwrap();
        assert_eq!(outcome.files, 1);
        assert!(dest.join("cebula.txt").exists());
        assert!(!dest.join("test.bin").exists());
        assert!(!dest.join("make_uue.tcl").exists());
    }

    #[test]
    fn rar_integrity_test_checks_every_file() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("many.rar");
        fs::write(&archive, include_bytes!("../tests/fixtures/rar5_many.rar")).unwrap();
        let outcome = run_archive_test(
            None,
            token(),
            ArchiveTestRequest {
                job_id: "rar-test".into(),
                path: archive.to_string_lossy().into_owned(),
                password: None,
            },
        )
        .unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.checked, 3);
    }

    #[test]
    fn multiple_files_with_the_same_name_get_distinct_entries() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("a/report.txt");
        let second = dir.path().join("b/report.txt");
        fs::create_dir_all(first.parent().unwrap()).unwrap();
        fs::create_dir_all(second.parent().unwrap()).unwrap();
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let out = dir.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let created = run_create_archive(
            None,
            token(),
            create_request(
                vec![
                    first.to_string_lossy().into_owned(),
                    second.to_string_lossy().into_owned(),
                ],
                &out,
                "zip",
                None,
            ),
        )
        .unwrap();
        let archive = PathBuf::from(created.output.unwrap().path);
        let inspection = archive_inspect(InspectRequest {
            path: archive.to_string_lossy().into_owned(),
            password: None,
        })
        .unwrap();
        assert_eq!(inspection.file_count, 2);
        let names: Vec<_> = inspection
            .entries
            .iter()
            .filter(|entry| !entry.is_dir)
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(names.len(), 2);
        assert_ne!(names[0], names[1]);
        assert!(names.iter().any(|name| name.contains("report")));
    }

    #[test]
    fn single_file_formats_refuse_multiple_sources() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("one.txt");
        let second = dir.path().join("two.txt");
        fs::write(&first, b"one").unwrap();
        fs::write(&second, b"two").unwrap();
        let out = dir.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let error = run_create_archive(
            None,
            token(),
            create_request(
                vec![
                    first.to_string_lossy().into_owned(),
                    second.to_string_lossy().into_owned(),
                ],
                &out,
                "gzip",
                None,
            ),
        )
        .unwrap_err();
        assert!(error.to_ascii_lowercase().contains("one file"));
    }

    #[test]
    fn rar_creation_is_refused_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("note.txt");
        fs::write(&source, b"note").unwrap();
        let out = dir.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let error = run_create_archive(
            None,
            token(),
            create_request(
                vec![source.to_string_lossy().into_owned()],
                &out,
                "rar",
                None,
            ),
        )
        .unwrap_err();
        assert!(error.contains("RAR"));
    }

    #[test]
    fn integrity_test_accepts_the_right_zip_password() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("locked.txt");
        fs::write(&source, b"locked").unwrap();
        let out = dir.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let created = run_create_archive(
            None,
            token(),
            create_request(
                vec![source.to_string_lossy().into_owned()],
                &out,
                "zip",
                Some("right-password"),
            ),
        )
        .unwrap();
        let archive = PathBuf::from(created.output.unwrap().path);
        let bad = run_archive_test(
            None,
            token(),
            ArchiveTestRequest {
                job_id: "bad".into(),
                path: archive.to_string_lossy().into_owned(),
                password: Some("wrong".into()),
            },
        )
        .unwrap();
        assert!(!bad.ok);
        let good = run_archive_test(
            None,
            token(),
            ArchiveTestRequest {
                job_id: "good".into(),
                path: archive.to_string_lossy().into_owned(),
                password: Some("right-password".into()),
            },
        )
        .unwrap();
        assert!(good.ok);
    }

    #[cfg(unix)]
    #[test]
    fn extraction_never_follows_destination_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("link-attack.zip");
        create_zip(&archive, &[("linked/escape.txt", b"should stay inside")]);
        let dest = dir.path().join("dest");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&dest).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, dest.join("linked")).unwrap();
        let error = run_extract_archive(None, token(), extract_request(&archive, &dest, "rename"))
            .unwrap_err();
        assert!(error.to_ascii_lowercase().contains("symbolic link"));
        assert!(!outside.join("escape.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_symlink_only_removes_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("replace-link.zip");
        create_zip(&archive, &[("a.txt", b"new data")]);
        let dest = dir.path().join("dest");
        let outside = dir.path().join("outside.txt");
        fs::create_dir_all(&dest).unwrap();
        fs::write(&outside, b"do not touch").unwrap();
        std::os::unix::fs::symlink(&outside, dest.join("a.txt")).unwrap();
        run_extract_archive(None, token(), extract_request(&archive, &dest, "replace")).unwrap();
        assert_eq!(fs::read(&outside).unwrap(), b"do not touch");
        let metadata = fs::symlink_metadata(dest.join("a.txt")).unwrap();
        assert!(!metadata.file_type().is_symlink());
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"new data");
    }

    #[test]
    fn replacing_a_nonempty_directory_with_a_file_keeps_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("dir-collision.zip");
        create_zip(&archive, &[("photos", b"this is a file")]);
        let dest = dir.path().join("dest");
        fs::create_dir_all(dest.join("photos")).unwrap();
        fs::write(dest.join("photos/keep.txt"), b"precious").unwrap();
        let outcome =
            run_extract_archive(None, token(), extract_request(&archive, &dest, "replace"))
                .unwrap();
        assert!(dest.join("photos/keep.txt").exists());
        assert_eq!(fs::read(dest.join("photos/keep.txt")).unwrap(), b"precious");
        assert_eq!(outcome.files, 0);
        assert!(outcome.skipped >= 1);
    }

    #[test]
    fn cancelling_before_archive_work_returns_a_clean_outcome() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("note.txt");
        fs::write(&source, b"note").unwrap();
        let out = dir.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let cancel = Arc::new(AtomicBool::new(true));
        let outcome = run_create_archive(
            None,
            cancel,
            create_request(
                vec![source.to_string_lossy().into_owned()],
                &out,
                "zip",
                None,
            ),
        )
        .unwrap();
        assert!(outcome.cancelled);
        assert!(outcome.output.is_none());
        assert!(!out.join("bundle.zip").exists());
    }

    #[test]
    fn cancelling_before_extraction_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("cancel.zip");
        create_zip(&archive, &[("note.txt", b"note")]);
        let dest = dir.path().join("dest");
        fs::create_dir_all(&dest).unwrap();
        let cancel = Arc::new(AtomicBool::new(true));
        let outcome =
            run_extract_archive(None, cancel, extract_request(&archive, &dest, "rename")).unwrap();
        assert!(outcome.cancelled);
        assert!(outcome.destination.is_none());
        assert!(!dest.join("note.txt").exists());
    }

    #[test]
    fn cancelling_an_integrity_test_returns_a_clean_result() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("cancel-test.zip");
        create_zip(&archive, &[("note.txt", b"note")]);
        let cancel = Arc::new(AtomicBool::new(true));
        let result = run_archive_test(
            None,
            cancel,
            ArchiveTestRequest {
                job_id: "cancel".into(),
                path: archive.to_string_lossy().into_owned(),
                password: None,
            },
        )
        .unwrap();
        assert!(!result.ok);
        assert!(result.cancelled);
    }

    #[test]
    fn selective_extraction_only_moves_requested_paths() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("select.zip");
        create_zip(&archive, &[("keep.txt", b"keep"), ("drop.txt", b"drop")]);
        let dest = dir.path().join("dest");
        fs::create_dir_all(&dest).unwrap();
        let mut request = extract_request(&archive, &dest, "rename");
        request.selected = vec!["keep.txt".into()];
        run_extract_archive(None, token(), request).unwrap();
        assert!(dest.join("keep.txt").exists());
        assert!(!dest.join("drop.txt").exists());
    }
}
