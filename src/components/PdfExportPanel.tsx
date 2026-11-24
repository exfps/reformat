import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  FileDown,
  FileText,
  FolderOpen,
  LoaderCircle,
  Lock,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useWorkbench } from "../store/workbench";
import { describeError, exportPdfDocument, pdfInfo, pickPdfPaths } from "../lib/api";
import { humanBytes, rangeInputError, uid } from "../lib/format";
import { usePersistentState } from "../hooks/usePersistentState";
import type { JobOutcome, PdfInfo } from "../lib/types";
import { DestinationPicker, DropZone, PrivacyNote, SectionLabel } from "./ui";

type ExportFormat = "docx" | "txt";

export function PdfExportPanel() {
  const {
    pdfOutputDir,
    choosePdfFolder,
    setPdfOutputDir,
    pushToast,
    recordActivity,
    activeJobs,
    startExternalJob,
    finishExternalJob,
    revealPath,
    pendingDrop,
    clearPendingDrop,
  } = useWorkbench();
  const [source, setSource] = useState<PdfInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>("docx");
  const [rangeMode, setRangeMode] = useState<"all" | "custom">("all");
  const [ranges, setRanges] = useState("1-3");
  const [fileName, setFileName] = usePersistentState("reformat.pdf-export-name.v1", "document");
  const [jobId, setJobId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<JobOutcome | null>(null);
  const job = activeJobs.find((entry) => entry.id === jobId) ?? null;
  const busy = Boolean(job);
  const rangeError = source && rangeMode === "custom" ? rangeInputError(ranges, source.pages) : null;

  const loadSource = useCallback(async (path: string) => {
    setLoading(true);
    setLoadError(null);
    setOutcome(null);
    try {
      const info = await pdfInfo(path);
      setSource(info);
      setFileName(info.name.replace(/\.pdf$/i, ""));
    } catch (reason) {
      setSource(null);
      setLoadError(describeError(reason));
    } finally {
      setLoading(false);
    }
  }, [setFileName]);

  const chooseSource = async () => {
    try {
      const paths = await pickPdfPaths();
      if (paths[0]) {
        if (paths.length > 1) {
          pushToast({ kind: "info", title: "One document at a time", detail: "Export uses the first PDF you selected." });
        }
        void loadSource(paths[0]);
      }
    } catch (reason) {
      pushToast({ kind: "error", title: "Couldn't open the PDF picker", detail: describeError(reason) });
    }
  };

  useEffect(() => {
    if (!pendingDrop || pendingDrop.target !== "pdf-export") return;
    clearPendingDrop();
    const pdf = pendingDrop.paths.find((path) => /\.pdf$/i.test(path));
    if (pdf) void loadSource(pdf);
    else if (pendingDrop.paths.length) pushToast({ kind: "error", title: "Choose a PDF file", detail: "Export accepts PDF documents only." });
  }, [clearPendingDrop, loadSource, pendingDrop, pushToast]);

  useEffect(() => {
    const onPick = (event: Event) => {
      if ((event as CustomEvent).detail === "pdf-export") void chooseSource();
    };
    window.addEventListener("reformat:pick", onPick);
    return () => window.removeEventListener("reformat:pick", onPick);
  });

  const runExport = async () => {
    if (!source || rangeError) return;
    const id = uid();
    setJobId(id);
    setOutcome(null);
    startExternalJob({ id, tool: "pdf-export", title: "Exporting PDF", total: 1, view: "pdf" });
    try {
      const result = await exportPdfDocument({
        jobId: id,
        input: source.path,
        outputDir: pdfOutputDir,
        fileName: `${fileName || source.name.replace(/\.pdf$/i, "document")}.${format}`,
        format,
        ranges: rangeMode === "custom" ? ranges : null,
      });
      finishExternalJob(id);
      setJobId(null);
      setOutcome(result);
      if (result.cancelled) {
        recordActivity({ tool: "pdf-export", title: "Export PDF", detail: "Stopped before a document was written.", status: "cancelled", outputs: [], errors: [] });
        pushToast({ kind: "info", title: "Export cancelled", detail: "The PDF is untouched." });
        return;
      }
      const output = result.outputs[0];
      recordActivity({
        tool: "pdf-export",
        title: "Export PDF",
        detail: result.errors.length ? result.errors[0].message : `Exported as ${format === "docx" ? "Word" : "text"}`,
        status: result.errors.length ? "failed" : "success",
        outputs: result.outputs,
        errors: result.errors,
      });
      if (output) {
        pushToast({
          kind: "success",
          title: format === "docx" ? "Word document ready" : "Text file ready",
          detail: `${output.name} · ${humanBytes(output.bytes)}`,
          revealPath: output.path,
        });
      }
    } catch (reason) {
      finishExternalJob(id);
      setJobId(null);
      recordActivity({ tool: "pdf-export", title: "Export PDF", detail: describeError(reason), status: "failed", outputs: [], errors: [] });
      pushToast({ kind: "error", title: "Couldn't export this PDF", detail: describeError(reason) });
    }
  };

  return (
    <div className="pdf-panel-grid">
      <div className="primary-stack">
        {!source && !loading ? (
          <DropZone
            kind="pdf"
            grow
            onBrowse={() => void chooseSource()}
            customTitle="Drop a PDF to export"
            customSubtitle="Turn selectable text into a Word document or a plain-text file. Scans need OCR first."
          />
        ) : loading ? (
          <div className="card archive-loading"><LoaderCircle size={20} className="spin" /><span>Reading the document…</span></div>
        ) : loadError ? (
          <div className="card upload-error">
            <div className="upload-error-icon"><Lock size={22} /></div>
            <div><strong>This PDF couldn't be opened</strong><span>{loadError}</span></div>
            <button className="small-button" onClick={() => void chooseSource()}>Try another</button>
          </div>
        ) : source ? (
          <>
            <div className="card selected-archive">
              <div className="selected-archive-icon pdf"><FileText size={22} /></div>
              <div className="selected-archive-main">
                <div className="card-title">{source.name}</div>
                <div className="card-sub">{source.pages} pages · {humanBytes(source.bytes)}</div>
              </div>
              <button className="small-button" onClick={() => void chooseSource()} disabled={busy}><RefreshCw size={13} /> Replace</button>
              <button className="icon-button" onClick={() => { setSource(null); setOutcome(null); }} disabled={busy} aria-label="Remove PDF"><X size={15} /></button>
            </div>

            <div className="card format-card export-format-card">
              <div className="card-head">
                <div><div className="card-title">What should it become?</div><div className="card-sub">Text is extracted page by page. Layout and images aren't rebuilt.</div></div>
              </div>
              <div className="export-format-grid">
                <button className={`export-format ${format === "docx" ? "is-active" : ""}`} onClick={() => setFormat("docx")} disabled={busy}>
                  <span className="export-icon"><FileText size={20} /></span>
                  <span><strong>Word document</strong><small>.docx · easy to edit</small></span>
                  {format === "docx" && <span className="choice-check"><Check size={12} /></span>}
                </button>
                <button className={`export-format ${format === "txt" ? "is-active" : ""}`} onClick={() => setFormat("txt")} disabled={busy}>
                  <span className="export-icon"><FileDown size={20} /></span>
                  <span><strong>Plain text</strong><small>.txt · universal</small></span>
                  {format === "txt" && <span className="choice-check"><Check size={12} /></span>}
                </button>
              </div>
              <div className="export-options">
                <div>
                  <SectionLabel>Pages</SectionLabel>
                  <div className="segmented">
                    <button className={rangeMode === "all" ? "is-active" : ""} onClick={() => setRangeMode("all")} disabled={busy}>All pages</button>
                    <button className={rangeMode === "custom" ? "is-active" : ""} onClick={() => setRangeMode("custom")} disabled={busy}>Choose pages</button>
                  </div>
                </div>
                {rangeMode === "custom" && (
                  <label className="plain-field">
                    <span className="field-label">Page ranges</span>
                    <input className={`text-input mono ${rangeError ? "has-error" : ""}`} value={ranges} onChange={(event) => setRanges(event.target.value)} placeholder="1-3, 5" spellCheck={false} />
                    <span className={`field-note ${rangeError ? "error-text" : ""}`}>{rangeError ?? "Separate groups with commas. Use “6-” to run to the last page."}</span>
                  </label>
                )}
              </div>
              <div className="info-box"><span className="info-box-icon"><Sparkles size={15} /></span><p>This works with text PDFs. If the text is part of an image or scan, Reformat will tell you rather than make an empty file.</p></div>
            </div>
            {outcome?.outputs[0] && (
              <div className="card created-card">
                <span className="created-icon"><Check size={16} /></span>
                <div><strong>{outcome.outputs[0].name}</strong><span>{humanBytes(outcome.outputs[0].bytes)} · ready to open</span></div>
                <button className="small-button" onClick={() => void revealPath(outcome.outputs[0].path)}><FolderOpen size={13} /> Show in Finder</button>
              </div>
            )}
          </>
        ) : null}
      </div>

      <aside className="inspector">
        <div className="card inspector-card">
          <div className="inspector-head"><div><div className="eyebrow">EXPORT</div><h2>Editable again.</h2></div></div>
          <div className="inspector-body">
            <DestinationPicker value={pdfOutputDir} onChoose={() => void choosePdfFolder()} onReset={() => setPdfOutputDir(null)} />
            <div className="template-block">
              <SectionLabel>File name</SectionLabel>
              <div className="input-with-suffix"><input className="text-input" value={fileName} onChange={(event) => setFileName(event.target.value)} disabled={busy} spellCheck={false} /><span className="input-suffix">.{format}</span></div>
            </div>
            <div className="archive-stat-list">
              <div><span>Format</span><strong>{format === "docx" ? "Word" : "Text"}</strong></div>
              <div><span>Pages</span><strong>{rangeMode === "all" ? source?.pages ?? "—" : ranges || "—"}</strong></div>
              <div><span>Source</span><strong>{source ? humanBytes(source.bytes) : "—"}</strong></div>
            </div>
            <div className="info-box"><span className="info-box-icon"><Lock size={15} /></span><p>Exports are new files. The original PDF stays exactly where it is. Scanned PDFs need OCR before they can be converted.</p></div>
            <PrivacyNote />
          </div>
          <div className="inspector-foot">
            {job ? (
              <div className="busy-footer">
                <div className="busy-top"><span className="busy-label"><LoaderCircle size={14} className="spin" /> {job.title}</span><span className="busy-count">{job.completed} / {job.total}</span></div>
                <div className="progress-track"><span style={{ width: `${Math.max(3, Math.round((job.completed / Math.max(1, job.total)) * 100))}%` }} /></div>
                <div className="busy-bottom"><span>{job.status === "cancelling" ? "Stopping safely…" : "Writing the document…"}</span></div>
              </div>
            ) : (
              <button className="primary-button" disabled={!source || Boolean(rangeError) || busy} onClick={() => void runExport()}>
                <span>{source ? `Export to ${format === "docx" ? "Word" : "text"}` : "Add a PDF to begin"}</span>
                <span className="primary-arrow"><ArrowRight size={16} /></span>
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
