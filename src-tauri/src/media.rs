use crate::files::{
    display_name, prepare_output_dir, render_template, sanitize_stem, strip_known_extension,
    unique_output_path, validate_input_file,
};
use crate::job::{cancelled, check_cancel, emit_progress, FileError, JobOutcome, OutputFile};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::metadata::Orientation;
use image::{
    DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat, ImageReader,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use tauri::AppHandle;
use tempfile::Builder as TempBuilder;

pub const MAX_IMAGE_PIXELS: u64 = 80_000_000;
pub const MAX_IMAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_THUMB_PIXELS: u64 = 48_000_000;
const MAX_SIDE: u32 = 32_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProbe {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub thumbnail: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    pub job_id: String,
    pub inputs: Vec<String>,
    pub output_dir: Option<String>,
    pub format: String,
    pub quality: u8,
    pub mode: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub allow_upscale: bool,
    pub template: String,
}

pub fn probe_images(paths: Vec<String>) -> Vec<ImageProbe> {
    paths.into_iter().map(|path| probe_one(&path)).collect()
}

fn probe_one(path: &str) -> ImageProbe {
    let name = display_name(path);
    let bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    match inspect_dimensions(path) {
        Ok((width, height)) => {
            let mut thumb = None;
            let mut shown_w = width;
            let mut shown_h = height;
            if width as u64 * height as u64 <= MAX_THUMB_PIXELS {
                if let Ok(image) = decode_image(path) {
                    shown_w = image.width();
                    shown_h = image.height();
                    thumb = make_thumbnail(&image);
                }
            }
            ImageProbe {
                path: path.to_string(),
                name,
                bytes,
                width: Some(shown_w),
                height: Some(shown_h),
                thumbnail: thumb,
                error: None,
            }
        }
        Err(error) => ImageProbe {
            path: path.to_string(),
            name,
            bytes,
            width: None,
            height: None,
            thumbnail: None,
            error: Some(error),
        },
    }
}

fn inspect_dimensions(path: &str) -> Result<(u32, u32), String> {
    let meta = fs::metadata(path).map_err(|_| {
        format!(
            "{} can't be read. It may have been moved or deleted.",
            display_name(path)
        )
    })?;
    if !meta.is_file() {
        return Err(format!("{} isn't a regular file.", display_name(path)));
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "{} is larger than 512 MB. Split it or reduce it before converting.",
            display_name(path)
        ));
    }
    let reader = ImageReader::open(path)
        .map_err(|_| format!("Couldn't open {}.", display_name(path)))?
        .with_guessed_format()
        .map_err(|_| format!("Couldn't read the image header for {}.", display_name(path)))?;
    let format = reader.format().ok_or_else(|| {
        format!(
            "{} isn't a recognizable image. Use JPG, PNG, or WebP.",
            display_name(path)
        )
    })?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP
    ) {
        return Err(format!(
            "{} is {}. Reformat supports JPG, PNG, and WebP images.",
            display_name(path),
            format
                .extensions_str()
                .first()
                .unwrap_or(&"an unsupported format")
        ));
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| format!("The image data in {} is damaged.", display_name(path)))?;
    validate_dimensions(width, height, path)?;
    Ok((width, height))
}

fn validate_dimensions(width: u32, height: u32, path: &str) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err(format!("{} has an empty image area.", display_name(path)));
    }
    if width > MAX_SIDE || height > MAX_SIDE || width as u64 * height as u64 > MAX_IMAGE_PIXELS {
        return Err(format!(
            "{} is too large to process safely ({} × {}). The limit is {} megapixels and {} px per side.",
            display_name(path),
            width,
            height,
            MAX_IMAGE_PIXELS / 1_000_000,
            MAX_SIDE
        ));
    }
    Ok(())
}

fn decode_image(path: &str) -> Result<DynamicImage, String> {
    let reader = ImageReader::open(path)
        .map_err(|_| format!("Couldn't open {}.", display_name(path)))?
        .with_guessed_format()
        .map_err(|_| format!("Couldn't read the image header for {}.", display_name(path)))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| format!("The image data in {} is damaged.", display_name(path)))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| {
        format!(
            "The image data in {} is damaged or incomplete.",
            display_name(path)
        )
    })?;
    image.apply_orientation(orientation);
    validate_dimensions(image.width(), image.height(), path)?;
    Ok(image)
}

pub(crate) fn flatten_on_white(image: &DynamicImage) -> image::RgbImage {
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut rgb = image::RgbImage::new(width, height);
    for (dst, src) in rgb.pixels_mut().zip(rgba.pixels()) {
        let alpha = src[3] as u32;
        if alpha == 255 {
            *dst = image::Rgb([src[0], src[1], src[2]]);
        } else {
            let blend = |channel: u8| -> u8 {
                ((channel as u32 * alpha + 255 * (255 - alpha)) / 255) as u8
            };
            *dst = image::Rgb([blend(src[0]), blend(src[1]), blend(src[2])]);
        }
    }
    rgb
}

fn make_thumbnail(image: &DynamicImage) -> Option<String> {
    let thumb = image.thumbnail(220, 160);
    let rgb = flatten_on_white(&thumb);
    let mut bytes = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut bytes, 76);
    encoder.encode_image(&rgb).ok()?;
    Some(format!("data:image/jpeg;base64,{}", BASE64.encode(bytes)))
}

/// Decode an image for embedding in a PDF, applying EXIF orientation and the
/// same safety limits used by the batch converter.
pub(crate) fn load_for_pdf(path: &str) -> Result<DynamicImage, String> {
    inspect_dimensions(path)?;
    decode_image(path)
}

pub(crate) fn jpeg_for_pdf(image: &DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let rgb = flatten_on_white(image);
    let mut bytes = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut bytes, quality.clamp(1, 100));
    encoder
        .encode_image(&rgb)
        .map_err(|e| format!("Couldn't prepare the image for PDF: {e}"))?;
    Ok(bytes)
}

fn normalize_format(raw: &str) -> Result<(&'static str, &'static str), String> {
    match raw.to_ascii_lowercase().as_str() {
        "jpeg" | "jpg" => Ok(("jpeg", "jpg")),
        "png" => Ok(("png", "png")),
        "webp" => Ok(("webp", "webp")),
        other => Err(format!("Unsupported output format: {other}")),
    }
}

fn target_dimensions(
    image: &DynamicImage,
    mode: &str,
    width: Option<u32>,
    height: Option<u32>,
    allow_upscale: bool,
    path: &str,
) -> Result<(u32, u32), String> {
    let iw = image.width();
    let ih = image.height();
    if mode == "none" {
        return Ok((iw, ih));
    }
    let tw = width.ok_or_else(|| "Choose a target width for this preset.".to_string())?;
    let th = height.ok_or_else(|| "Choose a target height for this preset.".to_string())?;
    if tw == 0 || th == 0 {
        return Err("Target width and height must be greater than zero.".to_string());
    }
    if tw > MAX_SIDE || th > MAX_SIDE {
        return Err(format!("Target sides must be at most {MAX_SIDE} px."));
    }
    let (out_w, out_h) = match mode {
        "fit" => {
            let scale = f64::min(tw as f64 / iw as f64, th as f64 / ih as f64);
            let scale = if allow_upscale { scale } else { scale.min(1.0) };
            let nw = (iw as f64 * scale).round().max(1.0) as u32;
            let nh = (ih as f64 * scale).round().max(1.0) as u32;
            (nw.min(tw), nh.min(th))
        }
        "cover" => {
            let scale = f64::max(tw as f64 / iw as f64, th as f64 / ih as f64);
            let scale = if allow_upscale { scale } else { scale.min(1.0) };
            let nw = (iw as f64 * scale).round().max(1.0) as u32;
            let nh = (ih as f64 * scale).round().max(1.0) as u32;
            (tw.min(nw), th.min(nh))
        }
        "stretch" => {
            if allow_upscale {
                (tw, th)
            } else {
                (tw.min(iw), th.min(ih))
            }
        }
        other => return Err(format!("Unknown resize mode: {other}")),
    };
    validate_dimensions(out_w.max(1), out_h.max(1), path)?;
    Ok((out_w.max(1), out_h.max(1)))
}

fn resize_image(image: DynamicImage, mode: &str, tw: u32, th: u32) -> Result<DynamicImage, String> {
    if mode == "none" || (tw == image.width() && th == image.height()) {
        return Ok(image);
    }
    let resize = |img: DynamicImage, w: u32, h: u32| -> DynamicImage {
        if w >= img.width() && h >= img.height() {
            img.resize_exact(w, h, image::imageops::FilterType::CatmullRom)
        } else {
            img.resize_exact(w, h, image::imageops::FilterType::Lanczos3)
        }
    };
    if mode == "cover" {
        // Resize preserving aspect ratio until both target sides are covered, then center-crop.
        let iw = image.width() as f64;
        let ih = image.height() as f64;
        let scale = f64::max(tw as f64 / iw, th as f64 / ih);
        let nw = (iw * scale).round().max(1.0) as u32;
        let nh = (ih * scale).round().max(1.0) as u32;
        let resized = resize(image, nw, nh);
        let crop_w = tw.min(resized.width());
        let crop_h = th.min(resized.height());
        let x = (resized.width() - crop_w) / 2;
        let y = (resized.height() - crop_h) / 2;
        Ok(resized.crop_imm(x, y, crop_w, crop_h))
    } else {
        Ok(resize(image, tw, th))
    }
}

fn encode_to_temp(
    image: &DynamicImage,
    format: &str,
    quality: u8,
    target: &Path,
    token: &AtomicBool,
) -> Result<u64, String> {
    let dir = target
        .parent()
        .ok_or_else(|| "The output folder is invalid.".to_string())?;
    let mut temp = TempBuilder::new()
        .prefix(".reformat-")
        .suffix(".part")
        .tempfile_in(dir)
        .map_err(|e| format!("Couldn't create a temporary file: {e}"))?;
    {
        let writer = temp.as_file_mut();
        match format {
            "jpeg" => {
                let rgb = flatten_on_white(image);
                let mut encoder =
                    JpegEncoder::new_with_quality(&mut *writer, quality.clamp(1, 100));
                encoder
                    .encode_image(&rgb)
                    .map_err(|e| format!("Couldn't encode the JPEG: {e}"))?;
            }
            "png" => {
                let rgba = image.to_rgba8();
                let encoder = PngEncoder::new_with_quality(
                    &mut *writer,
                    CompressionType::Best,
                    FilterType::Adaptive,
                );
                encoder
                    .write_image(
                        rgba.as_raw(),
                        rgba.width(),
                        rgba.height(),
                        ExtendedColorType::Rgba8,
                    )
                    .map_err(|e| format!("Couldn't encode the PNG: {e}"))?;
            }
            "webp" => {
                let rgba = image.to_rgba8();
                let encoder = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
                let memory = encoder
                    .encode_simple(false, quality.clamp(1, 100) as f32)
                    .map_err(|e| format!("Couldn't encode the WebP: {e:?}"))?;
                writer
                    .write_all(&memory)
                    .map_err(|e| format!("Couldn't write the WebP: {e}"))?;
            }
            other => return Err(format!("Unsupported output format: {other}")),
        }
        writer
            .flush()
            .map_err(|e| format!("Couldn't finish writing the file: {e}"))?;
    }
    if cancelled(token) {
        return Err("Cancelled".to_string());
    }
    let persisted = temp
        .persist_noclobber(target)
        .map_err(|e| format!("Couldn't save {}: {}", target.display(), e.error))?;
    let bytes = persisted
        .metadata()
        .map_err(|e| format!("Couldn't inspect the saved file: {e}"))?
        .len();
    Ok(bytes)
}

pub fn run_convert(
    app: Option<&AppHandle>,
    token: std::sync::Arc<AtomicBool>,
    request: ConvertRequest,
) -> Result<JobOutcome, String> {
    let started = Instant::now();
    let total = request.inputs.len();
    let (format, ext) = normalize_format(&request.format)?;
    if total == 0 {
        return Err("Add at least one image to convert.".to_string());
    }
    if request.mode != "none" && (request.width.is_none() || request.height.is_none()) {
        return Err("Choose a target size for this preset.".to_string());
    }
    let mut outputs = Vec::new();
    let mut errors = Vec::new();
    let mut was_cancelled = false;

    emit_progress(
        app,
        &request.job_id,
        "images",
        total,
        0,
        request.inputs.first().cloned(),
        "running",
    );

    for (index, input) in request.inputs.iter().enumerate() {
        if cancelled(&token) {
            was_cancelled = true;
            break;
        }
        let source = Path::new(input);
        let result = (|| -> Result<OutputFile, String> {
            validate_input_file(input)?;
            let image = decode_image(input)?;
            let (tw, th) = target_dimensions(
                &image,
                &request.mode,
                request.width,
                request.height,
                request.allow_upscale,
                input,
            )?;
            let resized = resize_image(image, &request.mode, tw, th)?;
            check_cancel(&token)?;
            let dir = prepare_output_dir(source, request.output_dir.as_deref())?;
            let source_name = source
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "image".to_string());
            let template = render_template(
                &request.template,
                &[
                    ("name", source_name.clone()),
                    ("width", resized.width().to_string()),
                    ("height", resized.height().to_string()),
                    ("index", (index + 1).to_string()),
                    ("format", ext.to_string()),
                    ("date", chrono::Local::now().format("%Y-%m-%d").to_string()),
                ],
            );
            let stem = sanitize_stem(&strip_known_extension(template.trim()), &source_name);
            let target = unique_output_path(&dir, &stem, ext);
            let bytes = encode_to_temp(&resized, format, request.quality, &target, &token)?;
            let name = target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "image".to_string());
            Ok(OutputFile {
                path: target.to_string_lossy().into_owned(),
                name,
                source_path: input.clone(),
                bytes,
                width: Some(resized.width()),
                height: Some(resized.height()),
                pages: None,
            })
        })();

        match result {
            Ok(output) => outputs.push(output),
            Err(error) if error == "Cancelled" => {
                was_cancelled = true;
                break;
            }
            Err(error) => errors.push(FileError {
                path: input.clone(),
                name: display_name(input),
                message: error,
            }),
        }
        emit_progress(
            app,
            &request.job_id,
            "images",
            total,
            index + 1,
            request.inputs.get(index + 1).cloned(),
            "running",
        );
    }

    let completed = outputs.len() + errors.len();
    emit_progress(
        app,
        &request.job_id,
        "images",
        total,
        completed,
        None,
        if was_cancelled {
            "cancelled"
        } else {
            "finished"
        },
    );

    Ok(JobOutcome {
        job_id: request.job_id,
        outputs,
        errors,
        cancelled: was_cancelled,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};
    use std::sync::Arc;
    use tempfile::tempdir;

    fn write_sample(path: &Path) {
        let mut img = RgbImage::new(40, 30);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = Rgb([(x * 5) as u8, (y * 7) as u8, 120]);
        }
        img.save(path).unwrap();
    }

    #[test]
    fn file_names_stay_safe_and_collisions_are_avoided() {
        let dir = tempdir().unwrap();
        let first = unique_output_path(dir.path(), "my: file/one", "jpg");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_output_path(dir.path(), "my: file/one", "jpg");
        assert_ne!(first, second);
        assert!(second.to_string_lossy().contains("-2"));
        assert!(!second.file_name().unwrap().to_string_lossy().contains('/'));
    }

    #[test]
    fn corrupt_images_return_an_error() {
        let dir = tempdir().unwrap();
        let bad = dir.path().join("broken.jpg");
        std::fs::write(&bad, b"not really a jpeg").unwrap();
        let probe = probe_one(bad.to_str().unwrap());
        assert!(probe.error.is_some());
        assert!(probe.thumbnail.is_none());
    }

    #[test]
    fn oversized_files_are_rejected_before_decode() {
        let dir = tempdir().unwrap();
        let huge = dir.path().join("huge.png");
        let file = std::fs::File::create(&huge).unwrap();
        file.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        drop(file);
        let error = inspect_dimensions(huge.to_str().unwrap()).unwrap_err();
        assert!(error.contains("larger than 512 MB"));
    }

    #[test]
    fn oversized_dimensions_are_rejected() {
        let error = validate_dimensions(20_000, 20_000, "huge.png").unwrap_err();
        assert!(error.contains("too large"));
    }

    #[test]
    fn canceled_jobs_write_nothing() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("sample.png");
        write_sample(&input);
        let token = Arc::new(AtomicBool::new(true));
        let request = ConvertRequest {
            job_id: "test-cancel".into(),
            inputs: vec![input.to_string_lossy().into_owned()],
            output_dir: Some(dir.path().to_string_lossy().into_owned()),
            format: "png".into(),
            quality: 82,
            mode: "fit".into(),
            width: Some(20),
            height: Some(20),
            allow_upscale: false,
            template: "{name}-{width}w".into(),
        };
        let outcome = run_convert(None, token, request).unwrap();
        assert!(outcome.cancelled);
        assert!(outcome.outputs.is_empty());
        assert_eq!(
            std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().map(|x| x == "png").unwrap_or(false))
                .count(),
            1,
            "only the source image should exist"
        );
    }

    #[test]
    fn converts_and_resizes_a_real_image() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("sample.png");
        write_sample(&input);
        let token = Arc::new(AtomicBool::new(false));
        let request = ConvertRequest {
            job_id: "test-convert".into(),
            inputs: vec![input.to_string_lossy().into_owned()],
            output_dir: Some(dir.path().to_string_lossy().into_owned()),
            format: "webp".into(),
            quality: 80,
            mode: "fit".into(),
            width: Some(20),
            height: Some(20),
            allow_upscale: false,
            template: "{name}-{width}w".into(),
        };
        let outcome = run_convert(None, token, request).unwrap();
        assert!(!outcome.cancelled);
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(outcome.outputs.len(), 1);
        let out = &outcome.outputs[0];
        assert_eq!(out.width, Some(20));
        assert_eq!(out.height, Some(15));
        let decoded = image::open(&out.path).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (20, 15));
        assert!(out.name.ends_with(".webp"));
    }
}
