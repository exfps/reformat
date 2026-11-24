import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let pdfjsPromise: Promise<any> | null = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function openPdfDocument(base64: string) {
  const pdfjs = await getPdfjs();
  const data = base64ToBytes(base64);
  return pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    useWorkerFetch: false,
  }).promise;
}

export interface ThumbnailHandle {
  promise: Promise<void>;
  cancel: () => void;
}

export async function renderThumbnail(
  pdf: any,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  maxWidth = 168,
): Promise<ThumbnailHandle> {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = maxWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas is not available");
  const task = page.render({
    canvasContext: context,
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    background: "#ffffff",
  });
  return {
    promise: task.promise.then(() => undefined),
    cancel: () => {
      try {
        task.cancel();
      } catch {
        // The render may already have finished.
      }
    },
  };
}
