import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  cancelJob,
  compressPdf,
  convertImages,
  describeError,
  imagesToPdf,
  isDesktop,
  mergePdfs,
  onFileDrop,
  onJobProgress,
  pdfInfo,
  pickFolder,
  pickImagePaths,
  pickPdfPaths,
  probeImages,
  readPdfPreview,
  reorderPdf,
  revealInFinder,
  splitPdf,
} from "../lib/api";
import {
  formatExtension,
  humanBytes,
  isImagePath,
  isPdfPath,
  uid,
} from "../lib/format";
import { usePersistentState } from "../hooks/usePersistentState";
import type {
  ActiveJob,
  ActivityEntry,
  ImageItem,
  ImageSettings,
  JobOutcome,
  PdfItem,
  PdfMode,
  Toast,
  ToastKind,
  View,
} from "../lib/types";

const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  format: "webp",
  quality: 82,
  presetId: "web",
  mode: "fit",
  width: 1600,
  height: 1600,
  allowUpscale: false,
  template: "{name}-{width}w",
};

export const PDF_MODE_META: Record<
  PdfMode,
  { label: string; eyebrow: string; description: string }
> = {
  merge: {
    label: "Merge",
    eyebrow: "COMBINE",
    description: "Join PDFs in exactly the order you want.",
  },
  split: {
    label: "Split",
    eyebrow: "EXTRACT",
    description: "Pull pages apart into clean, separate files.",
  },
  organize: {
    label: "Organize",
    eyebrow: "REORDER",
    description: "See every page and put it in its place.",
  },
  topdf: {
    label: "Image → PDF",
    eyebrow: "ASSEMBLE",
    description: "Turn a set of images into one tidy document.",
  },
  compress: {
    label: "Compress",
    eyebrow: "CLEAN UP",
    description: "Rebuild and shrink a PDF without touching image quality.",
  },
};

interface TrackedJobOptions {
  tool: string;
  title: string;
  total: number;
  view: View;
  execute: (jobId: string) => Promise<JobOutcome>;
}

interface WorkbenchValue {
  view: View;
  setView: (view: View) => void;
  pdfMode: PdfMode;
  setPdfMode: (mode: PdfMode) => void;
  isDesktop: boolean;
  toasts: Toast[];
  pushToast: (toast: { kind: ToastKind; title: string; detail?: string; revealPath?: string }) => void;
  dismissToast: (id: string) => void;
  revealPath: (path: string) => Promise<void>;
  activeJobs: ActiveJob[];
  activeImageJob: ActiveJob | null;
  activePdfJob: ActiveJob | null;
  isImageBusy: boolean;
  isPdfBusy: boolean;
  cancelActiveJob: (jobId: string) => Promise<void>;
  dragActive: boolean;

  imageItems: ImageItem[];
  imageSettings: ImageSettings;
  imageOutputDir: string | null;
  imageLastOutcome: JobOutcome | null;
  setImageOutputDir: (path: string | null) => void;
  updateImageSettings: (patch: Partial<ImageSettings>) => void;
  chooseImages: () => Promise<void>;
  addImages: (paths: string[]) => Promise<void>;
  removeImage: (id: string) => void;
  clearImages: () => void;
  moveImage: (from: number, to: number) => void;
  convertSelectedImages: () => Promise<void>;

  mergeItems: PdfItem[];
  splitFile: PdfItem | null;
  organizeFile: PdfItem | null;
  compressFile: PdfItem | null;
  pdfImages: ImageItem[];
  pdfOutputDir: string | null;
  pdfLastOutcomes: Partial<Record<PdfMode, JobOutcome>>;
  setPdfOutputDir: (path: string | null) => void;
  choosePdfsForMode: (mode: PdfMode) => Promise<void>;
  addPdfsToMode: (paths: string[], mode: PdfMode) => Promise<void>;
  removeMergeItem: (id: string) => void;
  clearMergeItems: () => void;
  moveMergeItem: (from: number, to: number) => void;
  clearSinglePdf: (mode: Exclude<PdfMode, "merge" | "topdf">) => void;
  choosePdfImages: () => Promise<void>;
  addPdfImages: (paths: string[]) => Promise<void>;
  removePdfImage: (id: string) => void;
  clearPdfImages: () => void;
  mergeSelectedPdfs: (fileName: string) => Promise<void>;
  splitSelectedPdf: (options: { mode: "every" | "ranges"; ranges: string }) => Promise<void>;
  saveOrganizedPdf: (order: number[], fileName: string) => Promise<void>;
  compressSelectedPdf: (fileName: string, stripMetadata: boolean) => Promise<void>;
  buildPdfFromImages: (options: {
    fileName: string;
    pageSize: string;
    margin: number;
  }) => Promise<void>;
  startOrganizePreview: (path: string) => Promise<{ data: string; pageCount: number } | null>;

  activity: ActivityEntry[];
  clearActivity: () => void;
  chooseImageFolder: () => Promise<void>;
  choosePdfFolder: () => Promise<void>;
}

const WorkbenchContext = createContext<WorkbenchValue | null>(null);

export function useWorkbench(): WorkbenchValue {
  const context = useContext(WorkbenchContext);
  if (!context) throw new Error("useWorkbench must be used inside WorkbenchProvider");
  return context;
}

function makeImageItem(probe: Awaited<ReturnType<typeof probeImages>>[number]): ImageItem {
  return {
    id: probe.path,
    path: probe.path,
    name: probe.name,
    bytes: probe.bytes,
    width: probe.width,
    height: probe.height,
    thumbnail: probe.thumbnail,
    status: probe.error ? "error" : "ready",
    error: probe.error ?? undefined,
  };
}

async function makePdfItem(path: string): Promise<PdfItem> {
  try {
    const info = await pdfInfo(path);
    return {
      id: path,
      path,
      name: info.name,
      bytes: info.bytes,
      pages: info.pages,
      status: "ready",
    };
  } catch (error) {
    return {
      id: path,
      path,
      name: path.split(/[\\/]/).pop() ?? path,
      bytes: 0,
      pages: 0,
      status: "error",
      error: describeError(error),
    };
  }
}

function firstOutput(outcome: JobOutcome): string | undefined {
  return outcome.outputs[0]?.path;
}

function outcomeDetail(outcome: JobOutcome): string {
  const parts: string[] = [];
  if (outcome.outputs.length) {
    parts.push(`${outcome.outputs.length} ${outcome.outputs.length === 1 ? "file" : "files"} written`);
  }
  if (outcome.errors.length) {
    parts.push(`${outcome.errors.length} skipped`);
  }
  if (!parts.length) parts.push("Nothing was written");
  return parts.join(" · ");
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>("images");
  const [pdfMode, setPdfMode] = useState<PdfMode>("merge");
  const [dragActive, setDragActive] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [imageItems, setImageItems] = useState<ImageItem[]>([]);
  const [mergeItems, setMergeItems] = useState<PdfItem[]>([]);
  const [splitFile, setSplitFile] = useState<PdfItem | null>(null);
  const [organizeFile, setOrganizeFile] = useState<PdfItem | null>(null);
  const [compressFile, setCompressFile] = useState<PdfItem | null>(null);
  const [pdfImages, setPdfImages] = useState<ImageItem[]>([]);
  const [activeJobs, setActiveJobs] = useState<Record<string, ActiveJob>>({});
  const [imageLastOutcome, setImageLastOutcome] = useState<JobOutcome | null>(null);
  const [pdfLastOutcomes, setPdfLastOutcomes] = useState<Partial<Record<PdfMode, JobOutcome>>>({});
  const [imageSettings, setImageSettings] = usePersistentState<ImageSettings>(
    "reformat.image-settings.v1",
    DEFAULT_IMAGE_SETTINGS,
  );
  const [imageOutputDir, setImageOutputDir] = usePersistentState<string | null>(
    "reformat.image-output.v1",
    null,
  );
  const [pdfOutputDir, setPdfOutputDir] = usePersistentState<string | null>(
    "reformat.pdf-output.v1",
    null,
  );
  const [activity, setActivity] = usePersistentState<ActivityEntry[]>("reformat.activity.v1", []);

  const pushToast = useCallback(
    (toast: { kind: ToastKind; title: string; detail?: string; revealPath?: string }) => {
      const id = uid();
      setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
      window.setTimeout(
        () => setToasts((prev) => prev.filter((item) => item.id !== id)),
        toast.kind === "error" ? 9000 : 5500,
      );
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const showError = useCallback(
    (title: string, error: unknown) => {
      pushToast({ kind: "error", title, detail: describeError(error) });
    },
    [pushToast],
  );

  const revealPath = useCallback(
    async (path: string) => {
      try {
        await revealInFinder(path);
      } catch (error) {
        showError("Couldn't open Finder", error);
      }
    },
    [showError],
  );

  const addActivity = useCallback(
    (entry: Omit<ActivityEntry, "id" | "timestamp">) => {
      setActivity((prev) =>
        [{ ...entry, id: uid(), timestamp: Date.now() }, ...prev].slice(0, 80),
      );
    },
    [setActivity],
  );

  const activeList = useMemo(() => Object.values(activeJobs), [activeJobs]);
  const activeImageJob = activeList.find((job) => job.view === "images") ?? null;
  const activePdfJob = activeList.find((job) => job.view === "pdf") ?? null;
  const isImageBusy = Boolean(activeImageJob);
  const isPdfBusy = Boolean(activePdfJob);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    onJobProgress((progress) => {
      setActiveJobs((prev) => {
        const existing = prev[progress.jobId];
        if (!existing) return prev;
        return {
          ...prev,
          [progress.jobId]: {
            ...existing,
            completed: progress.completed,
            total: progress.total || existing.total,
            current: progress.current,
            status:
              existing.status === "cancelling"
                ? "cancelling"
                : progress.status === "running"
                  ? "running"
                  : "finishing",
          },
        };
      });
    })
      .then((fn) => {
        if (mounted) unlisten = fn;
        else fn();
      })
      .catch(() => {
        // Events are an enhancement; command results still drive the UI.
      });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const runTrackedJob = useCallback(
    async (options: TrackedJobOptions): Promise<JobOutcome | null> => {
      const jobId = uid();
      const job: ActiveJob = {
        id: jobId,
        tool: options.tool,
        title: options.title,
        total: options.total,
        completed: 0,
        current: null,
        status: "running",
        view: options.view,
        startedAt: Date.now(),
      };
      setActiveJobs((prev) => ({ ...prev, [jobId]: job }));
      try {
        const outcome = await options.execute(jobId);
        const status: ActivityEntry["status"] = outcome.cancelled
          ? "cancelled"
          : outcome.errors.length
            ? outcome.outputs.length
              ? "partial"
              : "failed"
            : "success";
        addActivity({
          tool: options.tool,
          title: options.title,
          detail: outcome.cancelled
            ? `Cancelled after ${outcome.outputs.length} ${outcome.outputs.length === 1 ? "file" : "files"}.`
            : outcomeDetail(outcome),
          status,
          outputs: outcome.outputs,
          errors: outcome.errors,
        });
        return outcome;
      } catch (error) {
        addActivity({
          tool: options.tool,
          title: options.title,
          detail: describeError(error),
          status: "failed",
          outputs: [],
          errors: [],
        });
        pushToast({ kind: "error", title: `Couldn't ${options.title.toLowerCase()}`, detail: describeError(error) });
        return null;
      } finally {
        setActiveJobs((prev) => {
          const next = { ...prev };
          delete next[jobId];
          return next;
        });
      }
    },
    [addActivity, pushToast],
  );

  const cancelActiveJob = useCallback(
    async (jobId: string) => {
      setActiveJobs((prev) =>
        prev[jobId] ? { ...prev, [jobId]: { ...prev[jobId], status: "cancelling" } } : prev,
      );
      try {
        let accepted = await cancelJob(jobId);
        if (!accepted) {
          await new Promise((resolve) => window.setTimeout(resolve, 160));
          accepted = await cancelJob(jobId);
        }
        if (accepted) {
          pushToast({
            kind: "info",
            title: "Cancelling",
            detail: "Reformat will stop at the next safe checkpoint.",
          });
        }
      } catch (error) {
        showError("Couldn't cancel the job", error);
      }
    },
    [pushToast, showError],
  );

  const addImages = useCallback(
    async (paths: string[]) => {
      const images = paths.filter(isImagePath);
      if (!images.length) return;
      try {
        const probes = await probeImages(images);
        setImageItems((prev) => {
          const existing = new Set(prev.map((item) => item.path));
          const additions = probes
            .filter((probe) => !existing.has(probe.path))
            .map(makeImageItem);
          return [...prev, ...additions];
        });
        const bad = probes.filter((probe) => probe.error).length;
        if (bad > 0) {
          pushToast({
            kind: "error",
            title: `${bad} ${bad === 1 ? "file wasn't" : "files weren't"} added cleanly`,
            detail: "They stay in the queue with an error so nothing is lost. Remove or replace them.",
          });
        }
      } catch (error) {
        showError("Couldn't read those images", error);
      }
    },
    [pushToast, showError],
  );

  const chooseImages = useCallback(async () => {
    try {
      const paths = await pickImagePaths();
      if (paths.length) await addImages(paths);
    } catch (error) {
      showError("Couldn't open the file picker", error);
    }
  }, [addImages, showError]);

  const removeImage = useCallback(
    (id: string) => {
      if (isImageBusy) return;
      setImageItems((prev) => prev.filter((item) => item.id !== id));
    },
    [isImageBusy],
  );

  const clearImages = useCallback(() => {
    if (isImageBusy) return;
    setImageItems([]);
    setImageLastOutcome(null);
  }, [isImageBusy]);

  const moveImage = useCallback(
    (from: number, to: number) => {
      if (isImageBusy) return;
      setImageItems((prev) => {
        if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    },
    [isImageBusy],
  );

  const updateImageSettings = useCallback(
    (patch: Partial<ImageSettings>) => {
      setImageSettings((prev) => {
        const next = { ...prev, ...patch };
        if (patch.presetId) {
          const presets: Record<string, Partial<ImageSettings>> = {
            web: { mode: "fit", width: 1600, height: 1600 },
            square: { mode: "cover", width: 1080, height: 1080 },
            thumb: { mode: "fit", width: 480, height: 480 },
            original: { mode: "none", width: null, height: null },
          };
          const preset = presets[patch.presetId];
          if (preset) Object.assign(next, preset);
        } else if (
          patch.mode !== undefined ||
          patch.width !== undefined ||
          patch.height !== undefined
        ) {
          next.presetId = "custom";
        }
        return next;
      });
    },
    [setImageSettings],
  );

  const convertSelectedImages = useCallback(async () => {
    if (isImageBusy) return;
    const inputs = imageItems.filter((item) => item.status !== "error");
    if (!inputs.length) {
      pushToast({
        kind: "error",
        title: "No convertible images",
        detail: "Add a JPG, PNG, or WebP — or remove the files that couldn't be read.",
      });
      return;
    }
    const outcome = await runTrackedJob({
      tool: "images",
      title: "Convert images",
      total: inputs.length,
      view: "images",
      execute: (jobId) =>
        convertImages({
          jobId,
          inputs: inputs.map((item) => item.path),
          outputDir: imageOutputDir,
          format: imageSettings.format,
          quality: imageSettings.quality,
          mode: imageSettings.mode,
          width: imageSettings.width,
          height: imageSettings.height,
          allowUpscale: imageSettings.allowUpscale,
          template: imageSettings.template,
        }),
    });
    if (!outcome) return;
    setImageLastOutcome(outcome);
    setImageItems((prev) =>
      prev.map((item) => {
        const output = outcome.outputs.find((entry) => entry.sourcePath === item.path);
        const error = outcome.errors.find((entry) => entry.path === item.path);
        if (output) return { ...item, status: "done", output, error: undefined };
        if (error) return { ...item, status: "error", output: undefined, error: error.message };
        return item;
      }),
    );
    if (outcome.cancelled) {
      pushToast({
        kind: "info",
        title: "Conversion cancelled",
        detail: `${outcome.outputs.length} ${outcome.outputs.length === 1 ? "file" : "files"} finished before stopping.`,
        revealPath: firstOutput(outcome),
      });
    } else if (outcome.errors.length) {
      pushToast({
        kind: outcome.outputs.length ? "info" : "error",
        title: outcome.outputs.length
          ? `${outcome.outputs.length} converted · ${outcome.errors.length} skipped`
          : "Nothing could be converted",
        detail: outcome.errors[0]?.message,
        revealPath: firstOutput(outcome),
      });
    } else {
      pushToast({
        kind: "success",
        title: `${outcome.outputs.length} ${outcome.outputs.length === 1 ? "image" : "images"} converted`,
        detail: `${formatExtension(imageSettings.format).toUpperCase()} · saved ${imageOutputDir ? "to your chosen folder" : "next to the originals"}`,
        revealPath: firstOutput(outcome),
      });
    }
  }, [imageItems, imageSettings, imageOutputDir, isImageBusy, pushToast, runTrackedJob]);

  const addPdfImages = useCallback(
    async (paths: string[]) => {
      const images = paths.filter(isImagePath);
      if (!images.length) return;
      try {
        const probes = await probeImages(images);
        setPdfImages((prev) => {
          const existing = new Set(prev.map((item) => item.path));
          return [
            ...prev,
            ...probes.filter((probe) => !existing.has(probe.path)).map(makeImageItem),
          ];
        });
        const bad = probes.filter((probe) => probe.error).length;
        if (bad) {
          pushToast({
            kind: "error",
            title: `${bad} ${bad === 1 ? "image wasn't" : "images weren't"} added cleanly`,
            detail: "They'll be skipped when the PDF is built.",
          });
        }
      } catch (error) {
        showError("Couldn't read those images", error);
      }
    },
    [pushToast, showError],
  );

  const choosePdfImages = useCallback(async () => {
    try {
      const paths = await pickImagePaths();
      if (paths.length) await addPdfImages(paths);
    } catch (error) {
      showError("Couldn't open the file picker", error);
    }
  }, [addPdfImages, showError]);

  const removePdfImage = useCallback(
    (id: string) => {
      if (isPdfBusy) return;
      setPdfImages((prev) => prev.filter((item) => item.id !== id));
    },
    [isPdfBusy],
  );

  const clearPdfImages = useCallback(() => {
    if (isPdfBusy) return;
    setPdfImages([]);
  }, [isPdfBusy]);

  const addPdfsToMode = useCallback(
    async (paths: string[], mode: PdfMode) => {
      const pdfs = paths.filter(isPdfPath);
      if (!pdfs.length) return;
      if (mode === "topdf") {
        pushToast({
          kind: "info",
          title: "Image → PDF takes images",
          detail: "Drop JPG, PNG, or WebP files here, or switch to another PDF tool.",
        });
        return;
      }
      if (mode === "merge") {
        const items = await Promise.all(pdfs.map(makePdfItem));
        setMergeItems((prev) => {
          const existing = new Set(prev.map((item) => item.path));
          return [...prev, ...items.filter((item) => !existing.has(item.path))];
        });
        const bad = items.filter((item) => item.status === "error").length;
        if (bad) {
          pushToast({
            kind: "error",
            title: `${bad} ${bad === 1 ? "PDF couldn't" : "PDFs couldn't"} be opened`,
            detail: "They're marked in the queue so you can remove them.",
          });
        }
        return;
      }
      if (pdfs.length > 1) {
        pushToast({
          kind: "info",
          title: "One document at a time",
          detail: "This tool opened the first PDF. Use Merge for several files.",
        });
      }
      const item = await makePdfItem(pdfs[0]);
      if (mode === "split") setSplitFile(item);
      if (mode === "organize") setOrganizeFile(item);
      if (mode === "compress") setCompressFile(item);
      if (item.status === "error") {
        pushToast({ kind: "error", title: "Couldn't open that PDF", detail: item.error });
      }
    },
    [pushToast],
  );

  const choosePdfsForMode = useCallback(
    async (mode: PdfMode) => {
      try {
        const paths = await pickPdfPaths();
        if (paths.length) await addPdfsToMode(paths, mode);
      } catch (error) {
        showError("Couldn't open the file picker", error);
      }
    },
    [addPdfsToMode, showError],
  );

  const removeMergeItem = useCallback(
    (id: string) => {
      if (isPdfBusy) return;
      setMergeItems((prev) => prev.filter((item) => item.id !== id));
    },
    [isPdfBusy],
  );

  const clearMergeItems = useCallback(() => {
    if (isPdfBusy) return;
    setMergeItems([]);
  }, [isPdfBusy]);

  const moveMergeItem = useCallback(
    (from: number, to: number) => {
      if (isPdfBusy) return;
      setMergeItems((prev) => {
        if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    },
    [isPdfBusy],
  );

  const clearSinglePdf = useCallback(
    (mode: Exclude<PdfMode, "merge" | "topdf">) => {
      if (isPdfBusy) return;
      if (mode === "split") setSplitFile(null);
      if (mode === "organize") setOrganizeFile(null);
      if (mode === "compress") setCompressFile(null);
    },
    [isPdfBusy],
  );

  const notePdfOutcome = useCallback((mode: PdfMode, outcome: JobOutcome) => {
    setPdfLastOutcomes((prev) => ({ ...prev, [mode]: outcome }));
  }, []);

  const mergeSelectedPdfs = useCallback(
    async (fileName: string) => {
      if (isPdfBusy) return;
      if (mergeItems.length < 2) {
        pushToast({ kind: "error", title: "Add at least two PDFs", detail: "Then arrange them in reading order." });
        return;
      }
      if (mergeItems.some((item) => item.status === "error")) {
        pushToast({ kind: "error", title: "Remove the unreadable PDF first", detail: "One file in the queue couldn't be opened." });
        return;
      }
      const outcome = await runTrackedJob({
        tool: "pdf-merge",
        title: "Merge PDFs",
        total: mergeItems.length,
        view: "pdf",
        execute: (jobId) =>
          mergePdfs({
            jobId,
            inputs: mergeItems.map((item) => item.path),
            outputDir: pdfOutputDir,
            fileName,
          }),
      });
      if (!outcome) return;
      notePdfOutcome("merge", outcome);
      if (outcome.cancelled) {
        pushToast({ kind: "info", title: "Merge cancelled", detail: "No new PDF was written." });
      } else if (outcome.outputs[0]) {
        pushToast({
          kind: "success",
          title: "PDFs merged",
          detail: `${outcome.outputs[0].pages} pages · ${humanBytes(outcome.outputs[0].bytes)}`,
          revealPath: outcome.outputs[0].path,
        });
      }
    },
    [isPdfBusy, mergeItems, notePdfOutcome, pdfOutputDir, pushToast, runTrackedJob],
  );

  const splitSelectedPdf = useCallback(
    async (options: { mode: "every" | "ranges"; ranges: string }) => {
      if (isPdfBusy || !splitFile || splitFile.status === "error") return;
      const outcome = await runTrackedJob({
        tool: "pdf-split",
        title: "Split PDF",
        total: options.mode === "every" ? splitFile.pages : 1,
        view: "pdf",
        execute: (jobId) =>
          splitPdf({
            jobId,
            input: splitFile.path,
            outputDir: pdfOutputDir,
            mode: options.mode,
            ranges: options.mode === "ranges" ? options.ranges : null,
          }),
      });
      if (!outcome) return;
      notePdfOutcome("split", outcome);
      if (outcome.cancelled) {
        pushToast({ kind: "info", title: "Split cancelled", detail: `${outcome.outputs.length} files finished before stopping.`, revealPath: firstOutput(outcome) });
      } else if (outcome.outputs.length) {
        pushToast({
          kind: "success",
          title: `Split into ${outcome.outputs.length} ${outcome.outputs.length === 1 ? "file" : "files"}`,
          detail: outcome.errors.length ? `${outcome.errors.length} failed. Check Activity for details.` : "Saved beside the original or in your chosen folder.",
          revealPath: firstOutput(outcome),
        });
      } else if (outcome.errors.length) {
        pushToast({ kind: "error", title: "The split failed", detail: outcome.errors[0].message });
      }
    },
    [isPdfBusy, notePdfOutcome, pdfOutputDir, pushToast, runTrackedJob, splitFile],
  );

  const startOrganizePreview = useCallback(
    async (path: string) => {
      try {
        const preview = await readPdfPreview(path);
        return { data: preview.data, pageCount: preview.pageCount };
      } catch (error) {
        showError("Couldn't preview that PDF", error);
        return null;
      }
    },
    [showError],
  );

  const saveOrganizedPdf = useCallback(
    async (order: number[], fileName: string) => {
      if (isPdfBusy || !organizeFile || organizeFile.status === "error") return;
      const outcome = await runTrackedJob({
        tool: "pdf-organize",
        title: "Reorder PDF",
        total: 1,
        view: "pdf",
        execute: (jobId) =>
          reorderPdf({
            jobId,
            input: organizeFile.path,
            outputDir: pdfOutputDir,
            fileName,
            order,
          }),
      });
      if (!outcome) return;
      notePdfOutcome("organize", outcome);
      if (outcome.cancelled) {
        pushToast({ kind: "info", title: "Save cancelled", detail: "The original PDF is untouched." });
      } else if (outcome.outputs[0]) {
        setOrganizeFile((prev) =>
          prev ? { ...prev, status: "done", output: outcome.outputs[0] } : prev,
        );
        pushToast({
          kind: "success",
          title: "Page order saved",
          detail: `${outcome.outputs[0].pages} pages · ${humanBytes(outcome.outputs[0].bytes)}`,
          revealPath: outcome.outputs[0].path,
        });
      }
    },
    [isPdfBusy, notePdfOutcome, organizeFile, pdfOutputDir, pushToast, runTrackedJob],
  );

  const compressSelectedPdf = useCallback(
    async (fileName: string, stripMetadata: boolean) => {
      if (isPdfBusy || !compressFile || compressFile.status === "error") return;
      const before = compressFile.bytes;
      const outcome = await runTrackedJob({
        tool: "pdf-compress",
        title: "Compress PDF",
        total: 1,
        view: "pdf",
        execute: (jobId) =>
          compressPdf({
            jobId,
            input: compressFile.path,
            outputDir: pdfOutputDir,
            fileName,
            stripMetadata,
          }),
      });
      if (!outcome) return;
      notePdfOutcome("compress", outcome);
      if (outcome.cancelled) {
        pushToast({ kind: "info", title: "Compression cancelled", detail: "The original PDF is untouched." });
      } else if (outcome.outputs[0]) {
        setCompressFile((prev) =>
          prev ? { ...prev, status: "done", output: outcome.outputs[0] } : prev,
        );
        const saved = before - outcome.outputs[0].bytes;
        pushToast({
          kind: "success",
          title: outcome.outputs[0].bytes < before ? "PDF slimmed down" : "PDF cleaned up",
          detail:
            outcome.outputs[0].bytes < before
              ? `${humanBytes(saved)} smaller · ${humanBytes(before)} → ${humanBytes(outcome.outputs[0].bytes)}`
              : `Rebuilt safely at ${humanBytes(outcome.outputs[0].bytes)}; the original was already lean.`,
          revealPath: outcome.outputs[0].path,
        });
      }
    },
    [compressFile, isPdfBusy, notePdfOutcome, pdfOutputDir, pushToast, runTrackedJob],
  );

  const buildPdfFromImages = useCallback(
    async (options: { fileName: string; pageSize: string; margin: number }) => {
      if (isPdfBusy) return;
      const inputs = pdfImages.filter((item) => item.status !== "error");
      if (!inputs.length) {
        pushToast({ kind: "error", title: "Add some images first", detail: "JPG, PNG, and WebP stay local." });
        return;
      }
      const outcome = await runTrackedJob({
        tool: "images-to-pdf",
        title: "Build PDF from images",
        total: inputs.length,
        view: "pdf",
        execute: (jobId) =>
          imagesToPdf({
            jobId,
            inputs: inputs.map((item) => item.path),
            outputDir: pdfOutputDir,
            fileName: options.fileName,
            pageSize: options.pageSize,
            margin: options.margin,
          }),
      });
      if (!outcome) return;
      notePdfOutcome("topdf", outcome);
      if (outcome.cancelled) {
        pushToast({ kind: "info", title: "PDF build cancelled", detail: "No file was written." });
      } else if (outcome.outputs[0]) {
        pushToast({
          kind: outcome.errors.length ? "info" : "success",
          title: "PDF assembled",
          detail: `${outcome.outputs[0].pages} pages · ${humanBytes(outcome.outputs[0].bytes)}${outcome.errors.length ? ` · ${outcome.errors.length} skipped` : ""}`,
          revealPath: outcome.outputs[0].path,
        });
      }
    },
    [isPdfBusy, notePdfOutcome, pdfImages, pdfOutputDir, pushToast, runTrackedJob],
  );

  const chooseImageFolder = useCallback(async () => {
    try {
      const folder = await pickFolder("Choose where converted images go");
      if (folder) setImageOutputDir(folder);
    } catch (error) {
      showError("Couldn't choose that folder", error);
    }
  }, [setImageOutputDir, showError]);

  const choosePdfFolder = useCallback(async () => {
    try {
      const folder = await pickFolder("Choose where PDFs go");
      if (folder) setPdfOutputDir(folder);
    } catch (error) {
      showError("Couldn't choose that folder", error);
    }
  }, [setPdfOutputDir, showError]);

  const handleDropPaths = useCallback(
    async (paths: string[]) => {
      const images = paths.filter(isImagePath);
      const pdfs = paths.filter(isPdfPath);
      const extras = paths.filter((path) => !isImagePath(path) && !isPdfPath(path));
      if (extras.length) {
        pushToast({
          kind: "info",
          title: `${extras.length} unsupported ${extras.length === 1 ? "file" : "files"} ignored`,
          detail: "Reformat works with JPG, PNG, WebP, and PDF.",
        });
      }
      if (images.length) {
        if (view === "pdf" && pdfMode === "topdf") {
          await addPdfImages(images);
        } else {
          await addImages(images);
          if (view !== "images" && !pdfs.length) setView("images");
        }
      }
      if (pdfs.length) {
        if (view === "pdf" && pdfMode !== "topdf") {
          await addPdfsToMode(pdfs, pdfMode);
        } else {
          setView("pdf");
          setPdfMode("merge");
          await addPdfsToMode(pdfs, "merge");
        }
      }
    },
    [addImages, addPdfImages, addPdfsToMode, pdfMode, pushToast, view],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    onFileDrop((event) => {
      if (event.type === "enter" || event.type === "over") {
        setDragActive(true);
        return;
      }
      if (event.type === "leave") {
        setDragActive(false);
        return;
      }
      if (event.type === "drop") {
        setDragActive(false);
        if (event.paths?.length) void handleDropPaths(event.paths);
      }
    })
      .then((fn) => {
        if (mounted) unlisten = fn;
        else fn();
      })
      .catch(() => {
        // Browser preview has no native drop paths.
      });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [handleDropPaths]);

  useEffect(() => {
    if (isDesktop) return;
    const prevent = (event: DragEvent) => {
      event.preventDefault();
    };
    const enter = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer?.types.includes("Files")) setDragActive(true);
    };
    const leave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragActive(false);
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      pushToast({
        kind: "info",
        title: "File drop lives in the desktop app",
        detail: "Open the packaged Reformat app to drag files in from Finder.",
      });
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [pushToast]);

  const clearActivity = useCallback(() => setActivity([]), [setActivity]);

  const value: WorkbenchValue = {
    view,
    setView,
    pdfMode,
    setPdfMode,
    isDesktop,
    toasts,
    pushToast,
    dismissToast,
    revealPath,
    activeJobs: activeList,
    activeImageJob,
    activePdfJob,
    isImageBusy,
    isPdfBusy,
    cancelActiveJob,
    dragActive,
    imageItems,
    imageSettings,
    imageOutputDir,
    imageLastOutcome,
    setImageOutputDir,
    updateImageSettings,
    chooseImages,
    addImages,
    removeImage,
    clearImages,
    moveImage,
    convertSelectedImages,
    mergeItems,
    splitFile,
    organizeFile,
    compressFile,
    pdfImages,
    pdfOutputDir,
    pdfLastOutcomes,
    setPdfOutputDir,
    choosePdfsForMode,
    addPdfsToMode,
    removeMergeItem,
    clearMergeItems,
    moveMergeItem,
    clearSinglePdf,
    choosePdfImages,
    addPdfImages,
    removePdfImage,
    clearPdfImages,
    mergeSelectedPdfs,
    splitSelectedPdf,
    saveOrganizedPdf,
    compressSelectedPdf,
    buildPdfFromImages,
    startOrganizePreview,
    activity,
    clearActivity,
    chooseImageFolder,
    choosePdfFolder,
  };

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

