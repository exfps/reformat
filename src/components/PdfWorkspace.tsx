import { useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleCheck,
  FileOutput,
  FileText,
  Image as ImageIcon,
  ImagePlus,
  Layers,
  LayoutGrid,
  Minimize2,
  Plus,
  Scissors,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useWorkbench } from "../store/workbench";
import { humanBytes, rangeInputError } from "../lib/format";
import { usePersistentState } from "../hooks/usePersistentState";
import type { PdfMode } from "../lib/types";
import {
  DestinationPicker,
  DropZone,
  SectionLabel,
} from "./ui";
import {
  CompressVisual,
  InspectorHeader,
  MergeQueueRow,
  PdfHelpCard,
  PdfInspectorFooter,
  PlainField,
  SinglePdfCard,
  SplitPattern,
} from "./PdfShared";
import { PdfOrganizePanel } from "./PdfOrganizePanel";
import { PdfExportPanel } from "./PdfExportPanel";
import { ToolHeader } from "./ToolHeader";

const MODE_TABS: { id: PdfMode; label: string; hint: string; icon: typeof Layers }[] = [
  { id: "merge", label: "Merge", hint: "Join documents", icon: Layers },
  { id: "split", label: "Split", hint: "Extract pages", icon: Scissors },
  { id: "organize", label: "Organize", hint: "Reorder pages", icon: LayoutGrid },
  { id: "topdf", label: "Images to PDF", hint: "Assemble photos", icon: ImagePlus },
  { id: "export", label: "Export", hint: "Word or text", icon: FileOutput },
  { id: "compress", label: "Compress", hint: "Clean up a file", icon: Minimize2 },
];

function PdfModeTabs() {
  const { pdfMode, setPdfMode, isPdfBusy } = useWorkbench();
  return (
    <div className="pdf-tabs" role="tablist" aria-label="PDF tools">
      {MODE_TABS.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={pdfMode === tab.id}
            className={`pdf-tab ${pdfMode === tab.id ? "is-active" : ""}`}
            onClick={() => setPdfMode(tab.id)}
            title={isPdfBusy ? "A PDF job is still running" : tab.hint}
          >
            <span className="pdf-tab-icon"><Icon size={18} strokeWidth={1.7} /></span>
            <span className="pdf-tab-copy">
              <strong>{tab.label}</strong>
              <span>{tab.hint}</span>
            </span>
            {pdfMode === tab.id && <span className="pdf-tab-dot" />}
          </button>
        );
      })}
    </div>
  );
}

function MergePanel() {
  const {
    mergeItems,
    choosePdfsForMode,
    removeMergeItem,
    clearMergeItems,
    moveMergeItem,
    mergeSelectedPdfs,
    pdfOutputDir,
    choosePdfFolder,
    setPdfOutputDir,
    isPdfBusy,
    pdfLastOutcomes,
  } = useWorkbench();
  const [fileName, setFileName] = usePersistentState("reformat.merge-name.v1", "merged.pdf");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const totalPages = mergeItems.reduce((sum, item) => sum + item.pages, 0);
  const hasErrors = mergeItems.some((item) => item.status === "error");
  const canMerge = mergeItems.length >= 2 && !hasErrors && !isPdfBusy;

  return (
    <div className="pdf-panel-grid">
      <div className="primary-stack">
        {mergeItems.length === 0 ? (
          <>
            <DropZone
              grow
              kind="pdf"
              onBrowse={() => void choosePdfsForMode("merge")}
              customTitle="Drop PDFs to merge"
              customSubtitle="Your files stay in their original order until you rearrange them."
            />
            <PdfHelpCard mode="merge" />
          </>
        ) : (
          <>
            <DropZone kind="pdf" compact onBrowse={() => void choosePdfsForMode("merge")} disabled={isPdfBusy} />
            <div className="card merge-card">
              <div className="card-head">
                <div>
                  <div className="card-title">Reading order <span className="card-count">{mergeItems.length}</span></div>
                  <div className="card-sub">{totalPages} pages across {mergeItems.length} {mergeItems.length === 1 ? "document" : "documents"}</div>
                </div>
                <div className="card-actions">
                  <button className="small-button" onClick={() => void choosePdfsForMode("merge")} disabled={isPdfBusy}>
                    <Plus size={13} /> Add
                  </button>
                  <button className="text-button" onClick={clearMergeItems} disabled={isPdfBusy}>Clear</button>
                </div>
              </div>
              <div className="merge-list">
                {mergeItems.map((item, index) => (
                  <MergeQueueRow
                    key={item.id}
                    item={item}
                    index={index}
                    busy={isPdfBusy}
                    onRemove={() => removeMergeItem(item.id)}
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={() => setOverIndex(index)}
                    onDrop={() => {
                      if (dragIndex !== null) moveMergeItem(dragIndex, index);
                      setDragIndex(null);
                      setOverIndex(null);
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setOverIndex(null);
                    }}
                    isOver={overIndex === index && dragIndex !== null && dragIndex !== index}
                  />
                ))}
              </div>
              <div className="merge-foot">
                <span><Layers size={13} /> First document becomes the opening pages.</span>
                <span className="merge-foot-note">Drag the grip to reorder</span>
              </div>
            </div>
          </>
        )}

        {mergeItems.length < 2 && mergeItems.length > 0 && (
          <div className="inline-hint">
            <span className="inline-hint-icon"><Plus size={15} /></span>
            <div><strong>One more to go.</strong><span>Add a second PDF to unlock merging.</span></div>
            <button className="small-button" onClick={() => void choosePdfsForMode("merge")} disabled={isPdfBusy}>Add PDF</button>
          </div>
        )}
      </div>

      <aside className="inspector">
        <div className="card inspector-card">
          <InspectorHeader eyebrow="OUTPUT" title="One coherent file." />
          <div className="inspector-body">
            <DestinationPicker
              value={pdfOutputDir}
              onChoose={() => void choosePdfFolder()}
              onReset={() => setPdfOutputDir(null)}
            />
            <div className="divider" />
            <PlainField label="File name" value={fileName} onChange={setFileName} hint="Existing files are never overwritten." />
            <div className="stats-table">
              <div><span>Documents</span><strong>{mergeItems.length}</strong></div>
              <div><span>Total pages</span><strong>{totalPages || "—"}</strong></div>
              <div><span>Order</span><strong>{mergeItems.length ? "Top to bottom" : "—"}</strong></div>
            </div>
            {hasErrors && (
              <div className="warning-box">One or more PDFs couldn't be read. Remove them to continue.</div>
            )}
            <div className="info-box">
              <span className="info-box-icon"><ShieldCheck size={15} /></span>
              <p>Every page is copied into a fresh document. Links, annotations, and page labels stay attached to the page they belong to.</p>
            </div>
          </div>
          <PdfInspectorFooter tool="pdf-merge" outcome={pdfLastOutcomes.merge}>
            <button className="primary-button" onClick={() => void mergeSelectedPdfs(fileName)} disabled={!canMerge}>
              <span>{mergeItems.length >= 2 ? `Merge ${mergeItems.length} PDFs` : "Add two PDFs to merge"}</span>
              <span className="primary-arrow"><ArrowRight size={16} /></span>
            </button>
          </PdfInspectorFooter>
        </div>
      </aside>
    </div>
  );
}

function rangeLabels(ranges: string, pageCount: number): string[] {
  return ranges
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(\d+)\s*-?\s*(\d*)$/);
      if (!match) return part;
      if (match[2]) return `${match[1]}–${match[2]}`;
      if (part.includes("-")) return `${match[1]}–${pageCount}`;
      return match[1];
    });
}

function SplitPanel() {
  const {
    splitFile,
    choosePdfsForMode,
    clearSinglePdf,
    splitSelectedPdf,
    pdfOutputDir,
    choosePdfFolder,
    setPdfOutputDir,
    isPdfBusy,
    pdfLastOutcomes,
  } = useWorkbench();
  const [mode, setMode] = useState<"every" | "ranges">("every");
  const [ranges, setRanges] = useState("1-3, 5");
  const error = mode === "ranges" && splitFile ? rangeInputError(ranges, splitFile.pages) : null;
  const labels = mode === "every"
    ? Array.from({ length: Math.min(splitFile?.pages ?? 0, 6) }, (_, index) => String(index + 1).padStart(2, "0"))
    : rangeLabels(ranges, splitFile?.pages ?? 0);
  const outputCount = mode === "every" ? splitFile?.pages ?? 0 : error ? 0 : labels.length;
  const canSplit = Boolean(splitFile && splitFile.status !== "error" && !error && outputCount > 0 && !isPdfBusy);
  const filename = splitFile?.name.replace(/\.pdf$/i, "") ?? "document";

  return (
    <div className="pdf-panel-grid">
      <div className="primary-stack">
        {!splitFile ? (
          <>
            <DropZone
              grow
              kind="pdf"
              onBrowse={() => void choosePdfsForMode("split")}
              customTitle="Drop a PDF to split"
              customSubtitle="Separate every page, or pull out just the pages you need."
            />
            <PdfHelpCard mode="split" />
          </>
        ) : (
          <>
            <SinglePdfCard
              file={splitFile}
              onReplace={() => void choosePdfsForMode("split")}
              onRemove={() => clearSinglePdf("split")}
              disabled={isPdfBusy}
            />
            <div className="card split-card">
              <div className="card-head">
                <div>
                  <div className="card-title">Split style</div>
                  <div className="card-sub">Choose one file per page, or extract only certain ranges.</div>
                </div>
              </div>
              <div className="choice-grid">
                <button
                  className={`choice-card ${mode === "every" ? "is-active" : ""}`}
                  onClick={() => setMode("every")}
                  disabled={isPdfBusy}
                >
                  <span className="choice-icon"><FileText size={19} /></span>
                  <span className="choice-copy">
                    <strong>Every page</strong>
                    <span>One clean PDF for each of the {splitFile.pages} pages.</span>
                  </span>
                  {mode === "every" && <span className="choice-check"><Check size={12} /></span>}
                </button>
                <button
                  className={`choice-card ${mode === "ranges" ? "is-active" : ""}`}
                  onClick={() => setMode("ranges")}
                  disabled={isPdfBusy}
                >
                  <span className="choice-icon"><Scissors size={19} /></span>
                  <span className="choice-copy">
                    <strong>Custom ranges</strong>
                    <span>Extract the pages you name into separate files.</span>
                  </span>
                  {mode === "ranges" && <span className="choice-check"><Check size={12} /></span>}
                </button>
              </div>

              {mode === "ranges" && (
                <div className="range-block">
                  <label className="plain-field">
                    <span className="field-label">Page ranges</span>
                    <input
                      className={`text-input mono ${error ? "has-error" : ""}`}
                      value={ranges}
                      onChange={(event) => setRanges(event.target.value)}
                      placeholder="1-3, 5, 8-10"
                      disabled={isPdfBusy}
                      spellCheck={false}
                    />
                  </label>
                  <p className={`field-note ${error ? "error-text" : ""}`}>
                    {error ?? "Separate groups with commas. A single number makes its own file. “6-” runs to the end."}
                  </p>
                </div>
              )}

              <div className="split-preview">
                <SectionLabel right={<span className="field-hint">{outputCount} {outputCount === 1 ? "file" : "files"}</span>}>
                  What you'll get
                </SectionLabel>
                <div className="file-chips">
                  {labels.slice(0, 6).map((label, index) => (
                    <span className="file-chip" key={`${label}-${index}`}>
                      <FileText size={12} />
                      {mode === "every" ? `${filename}-page-${label}.pdf` : `${filename}-pages-${label}.pdf`}
                    </span>
                  ))}
                  {(mode === "every" ? splitFile.pages : labels.length) > 6 && (
                    <span className="file-chip file-chip-more">
                      + {(mode === "every" ? splitFile.pages : labels.length) - 6} more
                    </span>
                  )}
                  {outputCount === 0 && <span className="field-note">No valid ranges yet.</span>}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <aside className="inspector">
        <div className="card inspector-card">
          <InspectorHeader eyebrow="OUTPUT" title="Just the pages you need." />
          <div className="inspector-body">
            <DestinationPicker
              value={pdfOutputDir}
              onChoose={() => void choosePdfFolder()}
              onReset={() => setPdfOutputDir(null)}
            />
            <SplitPattern everyPage={mode === "every"} ranges={ranges} />
            <div className="stats-table">
              <div><span>Source</span><strong>{splitFile ? `${splitFile.pages} pages` : "—"}</strong></div>
              <div><span>Outputs</span><strong>{outputCount || "—"}</strong></div>
              <div><span>Original</span><strong>Untouched</strong></div>
            </div>
            <div className="info-box">
              <span className="info-box-icon"><Scissors size={15} /></span>
              <p>Each output is rebuilt from the source, not screenshotted. Text stays selectable and links keep working.</p>
            </div>
            {error && <div className="warning-box">{error}</div>}
          </div>
          <PdfInspectorFooter tool="pdf-split" outcome={pdfLastOutcomes.split}>
            <button
              className="primary-button"
              onClick={() => void splitSelectedPdf({ mode, ranges })}
              disabled={!canSplit}
            >
              <span>{outputCount ? `Split into ${outputCount} ${outputCount === 1 ? "file" : "files"}` : "Add a PDF to split"}</span>
              <span className="primary-arrow"><ArrowRight size={16} /></span>
            </button>
          </PdfInspectorFooter>
        </div>
      </aside>
    </div>
  );
}

function ImageToPdfPanel() {
  const {
    pdfImages,
    choosePdfImages,
    removePdfImage,
    clearPdfImages,
    buildPdfFromImages,
    pdfOutputDir,
    choosePdfFolder,
    setPdfOutputDir,
    isPdfBusy,
    pdfLastOutcomes,
  } = useWorkbench();
  const [fileName, setFileName] = usePersistentState("reformat.images-pdf-name.v1", "images.pdf");
  const [pageSize, setPageSize] = useState("a4");
  const [margin, setMargin] = useState(18);
  const validImages = pdfImages.filter((item) => item.status !== "error");
  const canBuild = validImages.length > 0 && !isPdfBusy;

  return (
    <div className="pdf-panel-grid">
      <div className="primary-stack">
        {pdfImages.length === 0 ? (
          <>
            <DropZone
              grow
              kind="image"
              onBrowse={() => void choosePdfImages()}
              customTitle="Drop images to assemble"
              customSubtitle="JPG, PNG, and WebP become one polished PDF, in queue order."
            />
            <PdfHelpCard mode="topdf" />
          </>
        ) : (
          <>
            <DropZone kind="image" compact onBrowse={() => void choosePdfImages()} disabled={isPdfBusy} />
            <div className="card imagepdf-card">
              <div className="card-head">
                <div>
                  <div className="card-title">Pages <span className="card-count">{pdfImages.length}</span></div>
                  <div className="card-sub">One image per page. Drag order is preserved.</div>
                </div>
                <div className="card-actions">
                  <button className="small-button" onClick={() => void choosePdfImages()} disabled={isPdfBusy}>
                    <Plus size={13} /> Add
                  </button>
                  <button className="text-button" onClick={clearPdfImages} disabled={isPdfBusy}>Clear</button>
                </div>
              </div>
              <div className="imagepdf-list">
                {pdfImages.map((item, index) => (
                  <div className={`imagepdf-row ${item.status === "error" ? "has-error" : ""}`} key={item.id}>
                    <span className="order-pill">{String(index + 1).padStart(2, "0")}</span>
                    {item.thumbnail ? (
                      <img src={item.thumbnail} alt="" className="thumb small" />
                    ) : (
                      <span className="imagepdf-placeholder"><ImageIcon size={16} /></span>
                    )}
                    <div className="imagepdf-main">
                      <span className="queue-name" title={item.path}>{item.name}</span>
                      {item.status === "error" ? (
                        <span className="error-text">{item.error}</span>
                      ) : (
                        <span className="queue-meta">{item.width} × {item.height} · {humanBytes(item.bytes)}</span>
                      )}
                    </div>
                    <button className="icon-button" onClick={() => removePdfImage(item.id)} disabled={isPdfBusy} aria-label={`Remove ${item.name}`}>
                      <X size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="merge-foot">
                <span><ImagePlus size={13} /> Images are re-encoded at high quality for print-ready pages.</span>
                <span>{validImages.length} usable</span>
              </div>
            </div>

            <div className="card setup-card">
              <div className="card-head">
                <div>
                  <div className="card-title">Page setup</div>
                  <div className="card-sub">A quiet, consistent frame for every image.</div>
                </div>
              </div>
              <div className="setup-grid">
                <div>
                  <SectionLabel>Page size</SectionLabel>
                  <div className="choice-grid compact">
                    {[
                      { id: "a4", label: "A4", detail: "Portrait, 210 × 297 mm" },
                      { id: "letter", label: "Letter", detail: "Portrait, 8.5 × 11 in" },
                      { id: "fit", label: "Fit image", detail: "Page hugs each image" },
                    ].map((option) => (
                      <button
                        key={option.id}
                        className={`choice-card small ${pageSize === option.id ? "is-active" : ""}`}
                        onClick={() => setPageSize(option.id)}
                        disabled={isPdfBusy}
                      >
                        <span className="choice-copy"><strong>{option.label}</strong><span>{option.detail}</span></span>
                        {pageSize === option.id && <span className="choice-check"><Check size={12} /></span>}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <SectionLabel>Margin</SectionLabel>
                  <div className="segmented">
                    {[
                      { value: 0, label: "None" },
                      { value: 18, label: "Small" },
                      { value: 36, label: "Medium" },
                    ].map((option) => (
                      <button
                        key={option.value}
                        className={margin === option.value ? "is-active" : ""}
                        onClick={() => setMargin(option.value)}
                        disabled={isPdfBusy}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <p className="field-note">Centered with room to breathe. Fit image uses the image's proportions.</p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <aside className="inspector">
        <div className="card inspector-card">
          <InspectorHeader eyebrow="OUTPUT" title="A PDF from your images." />
          <div className="inspector-body">
            <DestinationPicker
              value={pdfOutputDir}
              onChoose={() => void choosePdfFolder()}
              onReset={() => setPdfOutputDir(null)}
            />
            <div className="divider" />
            <PlainField label="File name" value={fileName} onChange={setFileName} hint="A new PDF, with every page in order." />
            <div className="stats-table">
              <div><span>Pages</span><strong>{validImages.length || "—"}</strong></div>
              <div><span>Page size</span><strong>{pageSize === "a4" ? "A4 portrait" : pageSize === "letter" ? "Letter" : "Fit image"}</strong></div>
              <div><span>Margins</span><strong>{margin === 0 ? "None" : margin === 18 ? "Small" : "Medium"}</strong></div>
            </div>
            <div className="info-box">
              <span className="info-box-icon"><Sparkles size={15} /></span>
              <p>Images are embedded as high-quality JPEGs. Transparent areas are flattened to white so the result prints cleanly.</p>
            </div>
          </div>
          <PdfInspectorFooter tool="images-to-pdf" outcome={pdfLastOutcomes.topdf}>
            <button
              className="primary-button"
              onClick={() => void buildPdfFromImages({ fileName, pageSize, margin })}
              disabled={!canBuild}
            >
              <span>{validImages.length ? `Build ${validImages.length}-page PDF` : "Add images to begin"}</span>
              <span className="primary-arrow"><ArrowRight size={16} /></span>
            </button>
          </PdfInspectorFooter>
        </div>
      </aside>
    </div>
  );
}

function CompressPanel() {
  const {
    compressFile,
    choosePdfsForMode,
    clearSinglePdf,
    compressSelectedPdf,
    pdfOutputDir,
    choosePdfFolder,
    setPdfOutputDir,
    isPdfBusy,
    pdfLastOutcomes,
  } = useWorkbench();
  const [fileName, setFileName] = usePersistentState("reformat.compress-name.v1", "compressed.pdf");
  const [stripMetadata, setStripMetadata] = usePersistentState("reformat.strip-metadata.v1", true);
  const canCompress = Boolean(compressFile && compressFile.status !== "error" && !isPdfBusy);

  return (
    <div className="pdf-panel-grid">
      <div className="primary-stack">
        {!compressFile ? (
          <>
            <DropZone
              grow
              kind="pdf"
              onBrowse={() => void choosePdfsForMode("compress")}
              customTitle="Drop a PDF to clean up"
              customSubtitle="Rebuild the document, strip stray metadata, and compress its streams."
            />
            <PdfHelpCard mode="compress" />
          </>
        ) : (
          <>
            <SinglePdfCard
              file={compressFile}
              onReplace={() => void choosePdfsForMode("compress")}
              onRemove={() => clearSinglePdf("compress")}
              disabled={isPdfBusy}
            />
            <div className="card compress-card">
              <div className="card-head">
                <div>
                  <div className="card-title">Lossless clean-up</div>
                  <div className="card-sub">No pixels are touched. Image quality stays exactly where it was.</div>
                </div>
                <span className="safe-pill"><ShieldCheck size={13} /> Safe</span>
              </div>
              <CompressVisual file={compressFile} />
              <div className="compress-points">
                <div><span className="point-check"><Check size={12} /></span><div><strong>Recompress streams</strong><span>Shrinks the structural overhead in the file.</span></div></div>
                <div><span className="point-check"><Check size={12} /></span><div><strong>Drop unused objects</strong><span>Removes leftovers that serve no page.</span></div></div>
                <div><span className="point-check"><Check size={12} /></span><div><strong>Strip hidden metadata</strong><span>Optional. Removes document info and XMP data.</span></div></div>
              </div>
              <div className="compress-note">
                <Sparkles size={15} />
                <span>Scanned PDFs are mostly image data, so savings may be small. Reformat will never fake a result by lowering image quality.</span>
              </div>
            </div>
          </>
        )}
      </div>

      <aside className="inspector">
        <div className="card inspector-card">
          <InspectorHeader eyebrow="OUTPUT" title="Lighter, not lossy." />
          <div className="inspector-body">
            <DestinationPicker
              value={pdfOutputDir}
              onChoose={() => void choosePdfFolder()}
              onReset={() => setPdfOutputDir(null)}
            />
            <div className="divider" />
            <PlainField label="File name" value={fileName} onChange={setFileName} hint="The original file is never replaced." />
            <label className="toggle-row">
              <span>
                <strong>Strip metadata</strong>
                <span className="field-note">Removes title, author, producer, and XMP fields.</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={stripMetadata}
                className={`switch ${stripMetadata ? "is-on" : ""}`}
                onClick={() => setStripMetadata(!stripMetadata)}
                disabled={isPdfBusy}
              >
                <span />
              </button>
            </label>
            <div className="stats-table">
              <div><span>Source</span><strong>{compressFile ? humanBytes(compressFile.bytes) : "—"}</strong></div>
              <div><span>Pages</span><strong>{compressFile?.pages ?? "—"}</strong></div>
              <div><span>Method</span><strong>Lossless</strong></div>
            </div>
            <div className="info-box">
              <span className="info-box-icon"><CircleCheck size={15} /></span>
              <p>If the rebuilt file ends up larger, it's still saved as a clean copy. Your source remains untouched either way.</p>
            </div>
          </div>
          <PdfInspectorFooter tool="pdf-compress" outcome={pdfLastOutcomes.compress}>
            <button className="primary-button" onClick={() => void compressSelectedPdf(fileName, stripMetadata)} disabled={!canCompress}>
              <span>{compressFile ? "Clean & compress" : "Add a PDF to clean"}</span>
              <span className="primary-arrow"><ArrowRight size={16} /></span>
            </button>
          </PdfInspectorFooter>
        </div>
      </aside>
    </div>
  );
}

export function PdfWorkspace() {
  const { pdfMode } = useWorkbench();
  const panel = useMemo(() => {
    if (pdfMode === "merge") return <MergePanel />;
    if (pdfMode === "split") return <SplitPanel />;
    if (pdfMode === "organize") return <PdfOrganizePanel />;
    if (pdfMode === "topdf") return <ImageToPdfPanel />;
    if (pdfMode === "export") return null;
    return <CompressPanel />;
  }, [pdfMode]);

  return (
    <div className="view-scroll fixed-page">
      <div className="page tool-page pdf-page">
        <ToolHeader
          icon={FileText}
          title="Work with PDFs"
          description="Merge, split, rearrange, and export pages with a few friendly tools."
          accent="coral"
        />

        <PdfModeTabs />
        <div className="pdf-panel-slot" hidden={pdfMode !== "export"}>
          <PdfExportPanel />
        </div>
        {pdfMode !== "export" && panel}
      </div>
    </div>
  );
}
