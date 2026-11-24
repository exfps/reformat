#!/usr/bin/env bash
# Build the native AVFoundation helper that powers Video → GIF.
# The Tauri sidecar resolver expects a target-triple suffix in src-tauri/binaries.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64|aarch64) ARCH="arm64"; TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

SDK="$(xcrun --sdk macosx --show-sdk-path)"
OUT="$ROOT/src-tauri/binaries/reformat-video-${TRIPLE}"
mkdir -p "$ROOT/src-tauri/binaries"

echo "Building the video helper for ${TRIPLE}…"
xcrun swiftc \
  -O \
  -target "${ARCH}-apple-macos11.0" \
  -sdk "$SDK" \
  -framework AVFoundation \
  -framework CoreGraphics \
  -framework ImageIO \
  -framework UniformTypeIdentifiers \
  "$ROOT/scripts/video_helper.swift" \
  -o "$OUT"
chmod +x "$OUT"
echo "Wrote $OUT"
