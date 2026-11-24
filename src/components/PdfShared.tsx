import type { ReactNode } from "react";
import {
  Check,
  FileText,
  FolderOpen,
  GripVertical,
  LoaderCircle,
  Replace,
  X,
} from "lucide-react";
import { useWorkbench } from "../store/workbench";
import { humanBytes } from "../lib/format";
import type { JobOutcome, PdfItem } from "../lib/types";
import { BusyFooter, FileGlyph, LastOutcomeCard, PrivacyNote, SectionLabel } from "./ui";
import { ShieldCheck } from "lucide-react";

export function InspectorHeader({
  eyebrow,
  title,
  number,
}: {
  eyebrow: string;
  title: string;
  number: string;
}) {
  return (
    <div className="inspector-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2>{title}</h2>
      </div>
      <span className="recipe-number">{number}</span>
    </div>
  );
}

export function SinglePdfCard({
  file,
  onReplace,
  onRemove,
  disabled = false,
}: {
  file: PdfItem;
  onReplace: () => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const { revealPath } = useWorkbench();
  return (
    <div className={`single-file ${file.status === "error" ? "has-error" : ""}`}>
      <FileGlyph kind="pdf" size={50} />
      <div className="single-file-main">
        <div className="single-file-title">{file.name}</div>
        <div className="single-file-meta">
          {file.status === "error" ? (
            <span className="error-text">{file.error}</span>
          ) : (
            <>
              <span>{file.pages} pages</span>
              <span className="meta-dot" />
              <span>{humanBytes(file.bytes)}</span>
              {file.status === "done" && <span className="badge badge-done"><Check size={11} /> Copy saved</span>}
            </>
          )}
        </div>
        {file.output && (
          <button
            className="queue-output"
            onClick={() => void revealPath(file.output!.path)}
          >
            <FolderOpen size={12} />
            {file.output.name}
          </button>
        )}
      </div>
      <div className="single-file-actions">
        <button className="small-button" onClick={onReplace} disabled={disabled}>
          <Replace size={13} /> Replace
        </button>
        <button className="icon-button" onClick={onRemove} disabled={disabled} aria-label="Remove file">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

export function PdfBusyFooter({ tool }: { tool: string }) {
  const { activePdfJob, cancelActiveJob } = useWorkbench();
  if (!activePdfJob || activePdfJob.tool !== tool) return null;
  return (
    <BusyFooter
      active
      completed={activePdfJob.completed}
      total={activePdfJob.total}
      current={activePdfJob.current}
      onCancel={() => void cancelActiveJob(activePdfJob.id)}
    />
  );
}

export function PdfInspectorFooter({
  tool,
  outcome,
  children,
}: {
  tool: string;
  outcome?: JobOutcome;
  children: ReactNode;
}) {
  const { activePdfJob } = useWorkbench();
  const isThisJob = activePdfJob?.tool === tool;
  return (
    <div className="inspector-foot">
      {isThisJob ? <PdfBusyFooter tool={tool} /> : children}
      {!isThisJob && outcome && <LastOutcomeCard outcome={outcome} compact />}
      <PrivacyNote>Nothing is uploaded. PDFs are rebuilt in a temp file before they land.</PrivacyNote>
    </div>
  );
}

export function MergeQueueRow({
  item,
  index,
  busy,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isOver,
}: {
  item: PdfItem;
  index: number;
  busy: boolean;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  isOver: boolean;
}) {
  return (
    <div
      className={`merge-row ${isOver ? "is-drag-over" : ""} ${item.status === "error" ? "has-error" : ""}`}
      draggable={!busy}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
    >
      <span className="grip"><GripVertical size={15} /></span>
      <span className="order-pill">{String(index + 1).padStart(2, "0")}</span>
      <FileGlyph kind="pdf" size={42} />
      <div className="merge-main">
        <div className="merge-title" title={item.path}>{item.name}</div>
        <div className="merge-meta">
          {item.status === "error" ? (
            <span className="error-text">{item.error}</span>
          ) : (
            <><span>{item.pages} pages</span><span className="meta-dot" /><span>{humanBytes(item.bytes)}</span></>
          )}
        </div>
      </div>
      {index === 0 && item.status !== "error" && <span className="first-badge">Starts here</span>}
      <button className="icon-button" onClick={onRemove} disabled={busy} aria-label={`Remove ${item.name}`}>
        <X size={15} />
      </button>
    </div>
  );
}

const HELP_STEPS: Record<string, { title: string; detail: string }[]> = {
  merge: [
    { title: "Drop your PDFs", detail: "They queue in the order you add them." },
    { title: "Set the reading order", detail: "Drag documents until the story flows." },
    { title: "Merge once", detail: "One clean file, originals untouched." },
  ],
  split: [
    { title: "Choose a PDF", detail: "Every page stays in its original quality." },
    { title: "Pick your ranges", detail: "All pages, or just the ones you name." },
    { title: "Collect the pieces", detail: "A separate file for every range." },
  ],
  organize: [
    { title: "Open a PDF", detail: "Reformat renders page thumbnails locally." },
    { title: "Move pages", detail: "Drag, nudge, or reverse the whole deck." },
    { title: "Save a copy", detail: "Your original is never modified." },
  ],
  topdf: [
    { title: "Add images", detail: "JPG, PNG, or WebP in any mix." },
    { title: "Choose a frame", detail: "A4, Letter, or pages that hug the image." },
    { title: "Build the PDF", detail: "High-quality JPEG pages, ready to share." },
  ],
  compress: [
    { title: "Drop a PDF", detail: "We inspect the structure, not your content." },
    { title: "Clean it up", detail: "Strip unused objects and stray metadata." },
    { title: "Keep the quality", detail: "No image is ever downsampled." },
  ],
};

export function PdfHelpCard({ mode }: { mode: string }) {
  const steps = HELP_STEPS[mode] ?? HELP_STEPS.merge;
  return (
    <div className="pdf-helper">
      <div className="pdf-helper-head">
        <span className="pdf-helper-kicker">A LOCAL WORKFLOW</span>
        <strong>Three steps. Nothing leaves this Mac.</strong>
        <ShieldCheck size={14} />
      </div>
      <div className="pdf-helper-steps">
        {steps.map((step, index) => (
          <div key={step.title} className="pdf-helper-step">
            <span className="pdf-helper-num">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{step.title}</strong>
              <span>{step.detail}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="pdf-helper-foot">
        <span className="pdf-helper-lock"><ShieldCheck size={11} /></span>
        PDFs are rebuilt in a temporary file before your copy is written.
      </div>
    </div>
  );
}

export function CompressVisual({ file }: { file: PdfItem }) {
  const { activePdfJob } = useWorkbench();
  const running = activePdfJob?.tool === "pdf-compress";
  return (
    <div className="compress-visual">
      <div className="compress-doc">
        <FileText size={20} />
        <span>{humanBytes(file.bytes)}</span>
      </div>
      <div className="compress-arrow">
        <span className="compress-line" />
        {running ? <LoaderCircle size={16} className="spin" /> : <span className="compress-spark">✦</span>}
      </div>
      <div className="compress-doc compress-doc-new">
        <FileText size={20} />
        <span>{running ? "Rebuilding…" : "A cleaner copy"}</span>
      </div>
    </div>
  );
}

export function SplitPattern({ everyPage, ranges }: { everyPage: boolean; ranges: string }) {
  return (
    <div className="split-pattern">
      <SectionLabel>Naming pattern</SectionLabel>
      <div className="pattern-code">
        <code>{everyPage ? "name-page-01.pdf" : "name-pages-1-3.pdf"}</code>
        <span>{everyPage ? "One file for every page" : ranges.trim() ? "One file per range" : "Waiting for a range"}</span>
      </div>
    </div>
  );
}

export function PlainField({
  label,
  value,
  onChange,
  suffix,
  hint,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suffix?: string;
  hint?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="plain-field">
      <span className="field-label">{label}</span>
      <div className="input-with-suffix">
        <input
          className="text-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
        />
        {suffix && !value.toLowerCase().endsWith(suffix.toLowerCase()) && (
          <span className="input-suffix">{suffix}</span>
        )}
      </div>
      {hint && <span className="field-note">{hint}</span>}
    </label>
  );
}

export function WindowHint() {
  return (
    <div className="window-hint">
      <span className="window-dots"><i /><i /><i /></span>
      <span>All processing stays inside this window.</span>
    </div>
  );
}
