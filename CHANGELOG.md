# Changelog

## 1.0.0 — 2026-11-24

### Added

- Batch image conversion and resizing for JPG, PNG and WebP
- Presets for web, square, thumbnail, original and custom dimensions
- Fit, fill-and-crop and stretch resize modes with optional upscaling
- EXIF orientation handling, quality control and safe filename templates
- Drag-to-reorder image queue with per-file status and Finder reveal
- PDF merge with drag-to-reorder reading order
- PDF split: every page or custom page ranges
- PDF organizer with locally rendered page thumbnails and drag/arrow reorder
- Images-to-PDF with A4, Letter and fit-to-image page sizes and margins
- Lossless PDF clean-up with optional metadata stripping
- Global drag-and-drop routing, ⌘O picker shortcut, live progress events
- Cooperative cancellation and crash-safe atomic output writes
- Local activity history with one-click Finder reveal
- macOS `.app` and `.dmg` packaging, app icon, privacy-focused CSP
- 17 Rust tests covering corrupt and oversized files, cancellation, and PDF structural operations

### Known limitations

- The distributed build is ad-hoc signed, not notarized.
- PDF compression is lossless only; image data inside a PDF is not resampled.
- Password-protected PDFs and HEIC inputs are not supported.
- macOS minimum: 11.0; provided DMG is Apple Silicon.
