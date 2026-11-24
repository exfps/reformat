export type View = "images" | "pdf" | "activity";
export type PdfMode = "merge" | "split" | "organize" | "topdf" | "compress";
export type OutputFormat = "jpeg" | "png" | "webp";
export type ResizeMode = "none" | "fit" | "cover" | "stretch";
export type QueueStatus = "ready" | "running" | "done" | "error" | "cancelled";

export interface ImageProbe {
  path: string;
  name: string;
  bytes: number;
  width: number | null;
  height: number | null;
  thumbnail: string | null;
  error: string | null;
}

export interface OutputFile {
  path: string;
  name: string;
  sourcePath: string;
  bytes: number;
  width?: number;
  height?: number;
  pages?: number;
}

export interface FileError {
  path: string;
  name: string;
  message: string;
}

export interface JobOutcome {
  jobId: string;
  outputs: OutputFile[];
  errors: FileError[];
  cancelled: boolean;
  elapsedMs: number;
}

export interface JobProgress {
  jobId: string;
  tool: string;
  total: number;
  completed: number;
  current: string | null;
  status: "running" | "finished" | "cancelled" | "failed";
}

export interface ImageItem {
  id: string;
  path: string;
  name: string;
  bytes: number;
  width: number | null;
  height: number | null;
  thumbnail: string | null;
  status: QueueStatus;
  error?: string;
  output?: OutputFile;
}

export interface PdfItem {
  id: string;
  path: string;
  name: string;
  bytes: number;
  pages: number;
  status: "ready" | "done" | "error";
  error?: string;
  output?: OutputFile;
}

export interface PdfInfo {
  path: string;
  name: string;
  bytes: number;
  pages: number;
}

export interface PdfPreview {
  pageCount: number;
  bytes: number;
  data: string;
}

export interface ImageSettings {
  format: OutputFormat;
  quality: number;
  presetId: string;
  mode: ResizeMode;
  width: number | null;
  height: number | null;
  allowUpscale: boolean;
  template: string;
}

export interface ImagePreset {
  id: string;
  label: string;
  detail: string;
  mode: ResizeMode;
  width: number | null;
  height: number | null;
}

export interface ActiveJob {
  id: string;
  tool: string;
  title: string;
  total: number;
  completed: number;
  current: string | null;
  status: "running" | "cancelling" | "finishing";
  view: View;
  startedAt: number;
}

export interface ActivityEntry {
  id: string;
  tool: string;
  title: string;
  detail: string;
  status: "success" | "partial" | "cancelled" | "failed";
  timestamp: number;
  outputs: OutputFile[];
  errors: FileError[];
}

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  detail?: string;
  revealPath?: string;
}

export interface TrackedJobOptions<T> {
  tool: string;
  title: string;
  total: number;
  view: View;
  execute: (jobId: string) => Promise<T>;
}
