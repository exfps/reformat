import type { ImageItem, ImageSettings, OutputFormat, ResizeMode } from "./types";

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function humanBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function humanDuration(ms: number | undefined): string {
  if (!ms || ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function parentPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index > 0 ? normalized.slice(0, index) : normalized;
}

export function shortPath(path: string, max = 42): string {
  if (!path) return "";
  if (path.length <= max) return path;
  const name = basename(path);
  const head = path.slice(0, Math.max(8, max - name.length - 4));
  return `${head}…/${name}`;
}

export function formatLabel(format: OutputFormat): string {
  return format === "jpeg" ? "JPG" : format.toUpperCase();
}

export function formatExtension(format: OutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function resolveTargetDimensions(
  item: Pick<ImageItem, "width" | "height">,
  settings: Pick<ImageSettings, "mode" | "width" | "height" | "allowUpscale">,
): { width: number; height: number } | null {
  if (!item.width || !item.height) return null;
  if (settings.mode === "none") return { width: item.width, height: item.height };
  if (!settings.width || !settings.height) return null;
  const iw = item.width;
  const ih = item.height;
  const tw = settings.width;
  const th = settings.height;
  if (settings.mode === "fit") {
    let scale = Math.min(tw / iw, th / ih);
    if (!settings.allowUpscale) scale = Math.min(scale, 1);
    return { width: Math.max(1, Math.round(iw * scale)), height: Math.max(1, Math.round(ih * scale)) };
  }
  if (settings.mode === "cover") {
    let scale = Math.max(tw / iw, th / ih);
    if (!settings.allowUpscale) scale = Math.min(scale, 1);
    const sw = Math.max(1, Math.round(iw * scale));
    const sh = Math.max(1, Math.round(ih * scale));
    return { width: Math.min(tw, sw), height: Math.min(th, sh) };
  }
  if (settings.mode === "stretch") {
    return {
      width: settings.allowUpscale ? tw : Math.min(tw, iw),
      height: settings.allowUpscale ? th : Math.min(th, ih),
    };
  }
  return null;
}

export function renderImageName(
  template: string,
  item: Pick<ImageItem, "name" | "width" | "height">,
  settings: ImageSettings,
  index: number,
): string {
  const dims = resolveTargetDimensions(item, settings);
  const stem = item.name.replace(/\.[^.]+$/, "");
  const tokens: Record<string, string> = {
    name: stem,
    width: String(dims?.width ?? item.width ?? ""),
    height: String(dims?.height ?? item.height ?? ""),
    index: String(index + 1),
    format: formatExtension(settings.format),
    date: (() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    })(),
  };
  let output = (template.trim() || "{name}").replace(/\{(\w+)\}/g, (match, key: string) => {
    return key in tokens ? tokens[key] : match;
  });
  output = output.replace(/[\/\\:]/g, "-").replace(/\s+/g, " ").trim();
  output = output.replace(/\.(jpe?g|png|webp|pdf)$/i, "");
  return `${output || stem}.${formatExtension(settings.format)}`;
}

export const IMAGE_PRESETS = [
  {
    id: "web",
    label: "Web",
    detail: "1600 px",
    mode: "fit" as ResizeMode,
    width: 1600,
    height: 1600,
  },
  {
    id: "square",
    label: "Square",
    detail: "1080 × 1080",
    mode: "cover" as ResizeMode,
    width: 1080,
    height: 1080,
  },
  {
    id: "thumb",
    label: "Thumb",
    detail: "480 px",
    mode: "fit" as ResizeMode,
    width: 480,
    height: 480,
  },
  {
    id: "original",
    label: "Original",
    detail: "No resize",
    mode: "none" as ResizeMode,
    width: null,
    height: null,
  },
  {
    id: "custom",
    label: "Custom",
    detail: "Your rules",
    mode: "fit" as ResizeMode,
    width: 1200,
    height: 1200,
  },
];

export function isImagePath(path: string): boolean {
  return /\.(jpe?g|png|webp)$/i.test(path);
}

export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

export function rangeInputError(input: string, pages: number): string | null {
  const normalized = input.replace(/[–—]/g, "-").trim();
  if (!normalized) return "Enter at least one page or range.";
  const pieces = normalized.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  if (pieces.length === 0) return "Enter at least one page or range.";
  for (const piece of pieces) {
    const match = piece.match(/^(\d+)(?:\s*-\s*(\d*))?$/);
    if (!match) return `“${piece}” isn't a valid page range.`;
    const start = Number(match[1]);
    const end =
      match[2] === undefined
        ? start
        : match[2] === ""
          ? pages
          : Number(match[2]);
    if (start < 1 || end < 1) return "Pages are numbered from 1.";
    if (start > end) return `“${piece}” runs backwards.`;
    if (end > pages) return `Page ${end} doesn't exist. This PDF has ${pages} pages.`;
  }
  return null;
}

export function isVideoPath(path: string): boolean {
  return /\.(mp4|mov|m4v)$/i.test(path);
}

export function isArchivePath(path: string): boolean {
  return /\.(zip|7z|tar|tar\.gz|tar\.bz2|tar\.xz|tgz|tbz2|txz|gz|bz2|xz|rar)$/i.test(path);
}
