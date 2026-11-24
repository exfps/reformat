import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  FileText,
  RotateCcw,
} from "lucide-react";
import { useWorkbench } from "../store/workbench";
import { openPdfDocument, renderThumbnail } from "../lib/pdfPreview";
import { usePersistentState } from "../hooks/usePersistentState";
import { humanBytes } from "../lib/format";
import { DestinationPicker, DropZone } from "./ui";
import { PdfHelpCard, PdfInspectorFooter, PlainField, SinglePdfCard } from "./PdfShared";

function PageThumbnail({ pdf, pageNumber }: { pdf: any; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !pdf || !canvasRef.current) return;
    let cancelled = false;
    let handle: { cancel: () => void } | null = null;
    setState("loading");
    renderThumbnail(pdf, pageNumber, canvasRef.current, 190)
      .then(async (thumbnail) => {
        handle = thumbnail;
        if (cancelled) {
          thumbnail.cancel();
          return;
        }
        await thumbnail.promise;
        if (!cancelled) setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
      handle?.cancel();
    };
  }, [pdf, pageNumber, visible]);

  return (
    <div className="page-canvas" ref={hostRef}>
      <canvas ref={canvasRef} aria-hidden="true" />
      {state !== "ready" && (
        <div className="page-canvas-cover">
          {state === "error" ? <FileText size={22} /> : <span className="thumb-shimmer" />}
        </div>
      )}
    </div>
  );
}

export function PdfOrganizePanel() {
  const {
    organizeFile,
    choosePdfsForMode,
    clearSinglePdf,
    startOrganizePreview,
    saveOrganizedPdf,
    pdfOutputDir,
    choosePdfFolder,
    setPdfOutputDir,
    isPdfBusy,
    activePdfJob,
    pdfLastOutcomes,
  } = useWorkbench();
  const [fileName, setFileName] = usePersistentState("reformat.organize-name.v1", "reordered.pdf");
  const [pdf, setPdf] = useState<any>(null);
  const [pages, setPages] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const isThisJob = activePdfJob?.tool === "pdf-organize";
  const busy = isPdfBusy;
  const dirty = pages.some((page, index) => page !== index + 1);

  useEffect(() => {
    let disposed = false;
    let opened: any = null;
    setPdf(null);
    setPages([]);
    setError(null);
    if (!organizeFile || organizeFile.status === "error") {
      setLoading(false);
      return () => {
        disposed = true;
      };
    }
    setLoading(true);
    (async () => {
      const preview = await startOrganizePreview(organizeFile.path);
      if (disposed) return;
      if (!preview) {
        setLoading(false);
        setError("The preview couldn't be opened.");
        return;
      }
      const document = await openPdfDocument(preview.data);
      if (disposed) {
        try { await document.destroy(); } catch { /* noop */ }
        return;
      }
      opened = document;
      setPdf(document);
      setPages(Array.from({ length: preview.pageCount }, (_, index) => index + 1));
      setLoading(false);
    })().catch((reason) => {
      if (!disposed) {
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => {
      disposed = true;
      if (opened) {
        try { void opened.destroy(); } catch { /* noop */ }
      }
    };
  }, [organizeFile?.path, reloadKey, startOrganizePreview]);

  const move = (from: number, to: number) => {
    if (busy || from === to || to < 0 || to >= pages.length) return;
    setPages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const reverse = () => {
    if (!busy) setPages((prev) => [...prev].reverse());
  };

  const reset = () => {
    if (!busy) setPages((prev) => prev.map((_, index) => index + 1));
  };

  return (
    <div className="pdf-panel-grid">
      <div className="primary-stack">
        {!organizeFile ? (
          <>
            <DropZone
              grow
              kind="pdf"
              onBrowse={() => void choosePdfsForMode("organize")}
              customTitle="Drop a PDF to organize"
              customSubtitle="See every page at a glance, then drag them into a new order."
            />
            <PdfHelpCard mode="organize" />
          </>
        ) : (
          <>
            <SinglePdfCard
              file={organizeFile}
              onReplace={() => void choosePdfsForMode("organize")}
              onRemove={() => clearSinglePdf("organize")}
              disabled={busy}
            />
            <div className="card pages-card">
              <div className="card-head">
                <div>
                  <div className="card-title">
                    Pages <span className="card-count">{pages.length || organizeFile.pages}</span>
                  </div>
                  <div className="card-sub">Drag a page, or use its arrows. Nothing is changed until you save.</div>
                </div>
                <div className="card-actions">
                  {dirty && <span className="unsaved-pill">Unsaved order</span>}
                  <button className="small-button" onClick={reverse} disabled={busy || !pages.length}>
                    <RotateCcw size={13} /> Reverse
                  </button>
                  <button className="text-button" onClick={reset} disabled={busy || !dirty}>
                    Reset
                  </button>
                </div>
              </div>

              {loading && (
                <div className="page-grid skeleton-grid">
                  {Array.from({ length: Math.min(10, Math.max(4, organizeFile.pages)) }).map((_, index) => (
                    <div className="page-card is-skeleton" key={index}>
                      <div className="page-skel" />
                      <span className="skeleton-line" />
                    </div>
                  ))}
                </div>
              )}

              {!loading && error && (
                <div className="preview-error">
                  <FileText size={22} />
                  <div>
                    <strong>The preview couldn't be drawn</strong>
                    <span>{error}</span>
                  </div>
                  <button className="small-button" onClick={() => setReloadKey((key) => key + 1)}>
                    Try again
                  </button>
                </div>
              )}

              {!loading && !error && pdf && (
                <div className="page-grid">
                  {pages.map((pageNumber, index) => (
                    <div
                      key={`page-${pageNumber}`}
                      className={`page-card ${overIndex === index ? "is-drag-over" : ""}`}
                      draggable={!busy}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        setDragIndex(index);
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setOverIndex(index);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (dragIndex !== null) move(dragIndex, index);
                        setDragIndex(null);
                        setOverIndex(null);
                      }}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setOverIndex(null);
                      }}
                    >
                      <div className="page-card-top">
                        <span className="page-order">#{String(index + 1).padStart(2, "0")}</span>
                        <span className={`page-original ${pageNumber !== index + 1 ? "is-moved" : ""}`}>
                          p. {pageNumber}
                        </span>
                        <div className="page-move">
                          <button
                            onClick={() => move(index, index - 1)}
                            disabled={busy || index === 0}
                            aria-label={`Move page ${pageNumber} earlier`}
                          >
                            <ChevronLeft size={13} />
                          </button>
                          <button
                            onClick={() => move(index, index + 1)}
                            disabled={busy || index === pages.length - 1}
                            aria-label={`Move page ${pageNumber} later`}
                          >
                            <ChevronRight size={13} />
                          </button>
                        </div>
                      </div>
                      <PageThumbnail pdf={pdf} pageNumber={pageNumber} />
                    </div>
                  ))}
                </div>
              )}

              <div className="pages-foot">
                <span><ArrowLeft size={13} /> Drag to reorder</span>
                <span>{organizeFile.pages} pages · {humanBytes(organizeFile.bytes)}</span>
                <span>Original untouched <ArrowRight size={13} /></span>
              </div>
            </div>
          </>
        )}
      </div>

      <aside className="inspector">
        <div className="card inspector-card">
          <div className="inspector-head">
            <div>
              <div className="eyebrow">EXPORT COPY</div>
              <h2>Find the right <span>order.</span></h2>
            </div>
            <span className="recipe-number">03</span>
          </div>
          <div className="inspector-body">
            <DestinationPicker
              value={pdfOutputDir}
              onChoose={() => void choosePdfFolder()}
              onReset={() => setPdfOutputDir(null)}
            />
            <div className="divider" />
            <PlainField
              label="File name"
              value={fileName}
              onChange={setFileName}
              suffix=".pdf"
              hint="A new copy is always created. Your original stays put."
            />
            <div className="organize-summary">
              <div className="organize-summary-item">
                <strong>{pages.length || organizeFile?.pages || "—"}</strong>
                <span>pages</span>
              </div>
              <div className="organize-summary-item">
                <strong>{dirty ? "New" : "Same"}</strong>
                <span>order</span>
              </div>
              <div className="organize-summary-item">
                <strong>{busy ? "…" : "Ready"}</strong>
                <span>status</span>
              </div>
            </div>
            <div className="info-box">
              <span className="info-box-icon"><FileText size={15} /></span>
              <p>Reformat keeps page content intact and rebuilds the document around your new sequence. Links and form fields stay with their pages.</p>
            </div>
          </div>
          <PdfInspectorFooter tool="pdf-organize" outcome={pdfLastOutcomes.organize}>
            <button
              className="primary-button"
              onClick={() => void saveOrganizedPdf(pages, fileName)}
              disabled={!organizeFile || organizeFile.status === "error" || !pages.length || busy}
            >
              <span>{dirty ? "Save new page order" : "Save a copy"}</span>
              <span className="primary-arrow"><ArrowRight size={16} /></span>
            </button>
            {isThisJob && <div className="job-inline-note">Saving a fresh, reordered document…</div>}
          </PdfInspectorFooter>
        </div>
      </aside>
    </div>
  );
}
