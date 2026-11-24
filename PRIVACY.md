# Privacy

Reformat is built so that file conversion does not require trusting a server.

## What leaves this Mac

Nothing. The app makes no network requests. It has no analytics, crash reporting, account system, cloud sync, remote fonts or auto-update checks.

The webview is configured with a Content Security Policy that denies remote scripts, styles, images, fonts and connections. The application layer performs no outbound requests, and Tauri’s networking plugins are not enabled.

## What Reformat reads

Only the files and folders you explicitly select through a native dialog or drag into the window. Reformat reads enough of a file to validate and process it:

- image headers before decoding, then the pixel data when you run a conversion;
- PDF structure and pages when you merge, split, organize, compress or preview it.

## What Reformat stores

- **Settings and activity:** output folder, conversion recipe, local history of output filenames and paths. Stored in the webview's `localStorage` on this Mac. Clear it with **Activity → Clear history**.
- **Temporary files:** while writing, Reformat creates a hidden `.reformat-*.part` file in the destination folder. On success it is atomically renamed to the final filename. On failure or cancellation it is deleted.
- **No file content** is copied into history or settings.

## Finder integration

**Show in Finder** invokes macOS `/usr/bin/open -R` on a path you selected. This is local; no information is sent anywhere.

## Limits of the guarantee

Reformat controls its own behavior. It cannot prevent other software on your machine from observing files or the filesystem. Code signing verifies the distributed bundle but is not a substitute for reviewing the source.

If you want to verify the local-only behavior yourself, build from source and monitor network activity with Little Snitch, LuLu or the macOS firewall. You will not see Reformat connect.
