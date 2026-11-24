# Privacy

Reformat is built so that file conversion does not require trusting a server.

## What leaves this Mac

Nothing. The app makes no network requests. It has no analytics, crash reporting, account system, cloud sync, remote fonts or auto-update checks.

The webview is configured with a Content Security Policy that denies remote scripts, styles, images, fonts and connections. The application layer performs no outbound requests, and Tauri’s networking plugins are not enabled.

## What Reformat reads

Only the files and folders you explicitly select through a native dialog or drag into the window. Reformat reads enough of a file to validate and process it:

- image headers before decoding, then the pixel data when you run a conversion;
- PDF structure, pages and selectable text when you merge, split, organize, compress, preview or export it;
- video metadata and frames through macOS AVFoundation when you make a GIF;
- archive listings and entry data when you inspect, test or unpack an archive. RAR extraction is handled by the system `bsdtar` process.

## What Reformat stores

- **Settings and activity:** themes, density, pinned tools, recent tools, output folders, conversion recipes, archive preferences and a local history of output names/paths. Stored in the webview's `localStorage` on this Mac. Clear activity with **Recent work → Clear history**.
- **Temporary files:** images, PDFs and GIFs are written as hidden `.reformat-*` files in the destination and renamed into place on success. Archive extraction stages into a hidden `.reformat-extract-*` folder in the destination before validation and merge. Temporary files are removed on failure or cancellation.
- **Passwords:** archive passwords stay in memory for the current operation. They are not written to `localStorage`, settings files or activity.
- **No file content** is copied into history or settings.

## Finder integration

**Show in Finder** invokes macOS `/usr/bin/open -R` on a path you selected. This is local; no information is sent anywhere.

## Limits of the guarantee

Reformat controls its own behavior. It cannot prevent other software on your machine from observing files or the filesystem. The distributed build is ad-hoc signed, not notarized; code signing is not a substitute for reviewing the source.

If you want to verify the local-only behavior yourself, build from source and monitor network activity with Little Snitch, LuLu or the macOS firewall. You will not see Reformat connect.
