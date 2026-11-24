# Third-party notices

Reformat is MIT licensed. It is built with open-source software and Apple
system frameworks. The principal components are listed below; the full
dependency graph and license texts are available in `package-lock.json` and
`src-tauri/Cargo.lock`.

## Application and libraries

| Component | License |
| --- | --- |
| Tauri 2 | MIT / Apache-2.0 |
| React 19, React DOM | MIT |
| TypeScript, Vite | MIT |
| lucide-react icons | ISC |
| PDF.js (`pdfjs-dist`) | Apache-2.0 |
| Rust `image` crate | MIT / Apache-2.0 |
| Rust `webp` crate | MIT / Apache-2.0 |
| Rust `lopdf` crate | MIT |
| Rust `docx-rs` crate | MIT |
| Rust `zip` crate | MIT |
| Rust `tar` crate | MIT / Apache-2.0 |
| Rust `flate2` crate | MIT / Apache-2.0 |
| Rust `bzip2` crate | MIT / Apache-2.0 |
| Rust `xz2` crate | MIT / Apache-2.0 |
| Rust `sevenz-rust` crate | Apache-2.0 |
| Rust `walkdir` crate | MIT / Unlicense |
| Rust `tempfile` crate | MIT / Apache-2.0 |

## Apple frameworks

The Video → GIF helper uses AVFoundation, CoreGraphics, ImageIO and
UniformTypeIdentifiers, which are part of macOS. RAR extraction uses the
system-provided `/usr/bin/bsdtar` (libarchive). Reformat does not bundle a
separate libarchive copy.

## Test fixtures

- `src-tauri/tests/fixtures/sample.mp4` is synthetic test material generated
  by `scripts/make-test-video.swift` for this repository.
- `src-tauri/tests/fixtures/rar5_stored.rar` and `rar5_many.rar` are from the
  [libarchive test suite](https://github.com/libarchive/libarchive/tree/master/libarchive/test)
  and are used only to test RAR inspection/extraction. libarchive is
  BSD-2-Clause licensed; see
  <https://github.com/libarchive/libarchive/blob/master/COPYING>.

## Demo assets

The screenshots and demo GIF in `docs/` show the app with synthetic sample
files. Sample photos are generated demo material and are not shipped inside
the application bundle.
