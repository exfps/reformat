import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ImageProbe,
  ImageSettings,
  JobOutcome,
  JobProgress,
  PdfInfo,
  PdfPreview,
} from "./types";

export const isDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class NotDesktopError extends Error {
  constructor() {
    super("File actions need the Reformat desktop app.");
    this.name = "NotDesktopError";
  }
}

function requireDesktop() {
  if (!isDesktop) throw new NotDesktopError();
}

export async function pickImagePaths(): Promise<string[]> {
  requireDesktop();
  const result = await open({
    multiple: true,
    directory: false,
    title: "Choose images",
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
  });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

export async function pickPdfPaths(): Promise<string[]> {
  requireDesktop();
  const result = await open({
    multiple: true,
    directory: false,
    title: "Choose PDFs",
    filters: [{ name: "PDF documents", extensions: ["pdf"] }],
  });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

export async function pickFolder(title = "Choose an output folder"): Promise<string | null> {
  requireDesktop();
  const result = await open({
    directory: true,
    multiple: false,
    title,
  });
  if (!result) return null;
  return Array.isArray(result) ? result[0] ?? null : result;
}

export async function probeImages(paths: string[]): Promise<ImageProbe[]> {
  requireDesktop();
  return invoke<ImageProbe[]>("probe_images", { paths });
}

export async function pdfInfo(path: string): Promise<PdfInfo> {
  requireDesktop();
  return invoke<PdfInfo>("pdf_info", { path });
}

export async function readPdfPreview(path: string): Promise<PdfPreview> {
  requireDesktop();
  return invoke<PdfPreview>("read_pdf_preview", { path });
}

export async function convertImages(request: {
  jobId: string;
  inputs: string[];
  outputDir: string | null;
  format: string;
  quality: number;
  mode: string;
  width: number | null;
  height: number | null;
  allowUpscale: boolean;
  template: string;
}): Promise<JobOutcome> {
  requireDesktop();
  return invoke<JobOutcome>("convert_images", { request });
}

export async function mergePdfs(request: {
  jobId: string;
  inputs: string[];
  outputDir: string | null;
  fileName: string;
}): Promise<JobOutcome> {
  requireDesktop();
  return invoke<JobOutcome>("merge_pdfs", { request });
}

export async function splitPdf(request: {
  jobId: string;
  input: string;
  outputDir: string | null;
  mode: string;
  ranges: string | null;
  template?: string | null;
}): Promise<JobOutcome> {
  requireDesktop();
  return invoke<JobOutcome>("split_pdf", { request });
}

export async function reorderPdf(request: {
  jobId: string;
  input: string;
  outputDir: string | null;
  fileName: string;
  order: number[];
}): Promise<JobOutcome> {
  requireDesktop();
  return invoke<JobOutcome>("reorder_pdf", { request });
}

export async function compressPdf(request: {
  jobId: string;
  input: string;
  outputDir: string | null;
  fileName: string;
  stripMetadata: boolean;
}): Promise<JobOutcome> {
  requireDesktop();
  return invoke<JobOutcome>("compress_pdf", { request });
}

export async function imagesToPdf(request: {
  jobId: string;
  inputs: string[];
  outputDir: string | null;
  fileName: string;
  pageSize: string;
  margin: number;
}): Promise<JobOutcome> {
  requireDesktop();
  return invoke<JobOutcome>("images_to_pdf", { request });
}

export async function cancelJob(jobId: string): Promise<boolean> {
  requireDesktop();
  return invoke<boolean>("cancel_job", { jobId });
}

export async function revealInFinder(path: string): Promise<void> {
  requireDesktop();
  return invoke<void>("reveal_in_finder", { path });
}

export async function onJobProgress(
  handler: (progress: JobProgress) => void,
): Promise<UnlistenFn> {
  if (!isDesktop) return () => {};
  return listen<JobProgress>("job-progress", (event) => handler(event.payload));
}

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

export async function onFileDrop(
  handler: (event: DragDropPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop) return () => {};
  const webview = getCurrentWebview();
  return webview.onDragDropEvent((event) => {
    const payload = event.payload as
      | { type: "enter" | "over" | "leave" }
      | { type: "drop"; paths: string[] };
    handler(payload);
  });
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Something went wrong.";
  }
}

export type { ImageSettings };
