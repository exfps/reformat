import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const svg = join(root, "src-tauri/icons/icon.svg");
const out = join(root, "src-tauri/icons");
mkdirSync(out, { recursive: true });

const sizes = [16, 32, 64, 128, 256, 512, 1024];
for (const size of sizes) {
  await sharp(svg, { density: 384 })
    .resize(size, size)
    .png()
    .toFile(join(out, `${size}x${size}.png`));
}
await sharp(svg, { density: 384 }).resize(1024, 1024).png().toFile(join(out, "icon.png"));
await sharp(svg, { density: 384 }).resize(32, 32).png().toFile(join(out, "32x32.png"));
await sharp(svg, { density: 384 }).resize(128, 128).png().toFile(join(out, "128x128.png"));
await sharp(svg, { density: 384 }).resize(256, 256).png().toFile(join(out, "128x128@2x.png"));
await sharp(svg, { density: 384 }).resize(512, 512).png().toFile(join(out, "icon-512.png"));

// macOS .icns
const iconset = join(out, "icon.iconset");
mkdirSync(iconset, { recursive: true });
const icnsSizes = [
  [16, "icon_16x16.png"], [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"], [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"], [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"], [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"], [1024, "icon_512x512@2x.png"],
];
for (const [size, name] of icnsSizes) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(join(iconset, name));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(out, "icon.icns")]);

// .ico using Pillow via the local venv
execFileSync(join(root, ".venv/bin/python"), ["-c", `
from PIL import Image
img = Image.open(${JSON.stringify(join(out, "icon.png"))}).convert("RGBA")
img.save(${JSON.stringify(join(out, "icon.ico"))}, sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
`]);
console.log("icons generated");
