import {
  ArrowUpRight,
  Check,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useWorkbench } from "../store/workbench";
import { humanBytes, parentPath } from "../lib/format";
import type { JobOutcome } from "../lib/types";

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="section-label">
      <span>{children}</span>
      {right}
    </div>
  );
}

export function FileGlyph({ kind, size = 44 }: { kind: "image" | "pdf"; size?: number }) {
  return (
    <span className={`file-glyph file-glyph-${kind}`} style={{ width: size, height: size }}>
      {kind === "image" ? <ImageIcon size={18} /> : <FileText size={18} />}
    </span>
  );
}

interface DropZoneProps {
  kind: "image" | "pdf";
  compact?: boolean;
  multiple?: boolean;
  disabled?: boolean;
  onBrowse: () => void;
  customTitle?: string;
  customSubtitle?: string;
  grow?: boolean;
}

export function DropZone({
  kind,
  compact = false,
  disabled = false,
  onBrowse,
  customTitle,
  customSubtitle,
  grow = false,
}: DropZoneProps) {
  const title = customTitle ?? (kind === "image" ? "Drop images here" : "Drop a PDF here");
  const subtitle =
    customSubtitle ??
    (kind === "image"
      ? "JPG, PNG, or WebP. Batch as many as you like."
      : "Merge, split, reorder, or clean up a document.");
  const Icon = kind === "image" ? ImageIcon : FileText;

  if (compact) {
    return (
      <button className="drop-compact" onClick={onBrowse} disabled={disabled}>
        <span className="drop-compact-icon"><Plus size={16} /></span>
        <span className="drop-compact-text">
          <strong>{kind === "image" ? "Add more images" : "Add another PDF"}</strong>
          <span>or drop files anywhere</span>
        </span>
        <span className="drop-compact-types">
          {kind === "image" ? "JPG · PNG · WEBP" : "PDF"}
        </span>
      </button>
    );
  }

  return (
    <div
      className={`drop-zone drop-zone-${kind} ${grow ? "is-grow" : ""} ${disabled ? "is-disabled" : ""}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onBrowse()}
      onKeyDown={(event) => {
        if (!disabled && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onBrowse();
        }
      }}
      aria-disabled={disabled}
    >
      <div className="drop-art" aria-hidden="true">
        <div className="drop-sheet drop-sheet-back" />
        <div className="drop-sheet drop-sheet-mid" />
        <div className="drop-sheet drop-sheet-front">
          <Icon size={28} strokeWidth={1.5} />
          <span className="drop-sheet-line" />
          <span className="drop-sheet-line short" />
        </div>
        <span className="drop-plus"><Plus size={17} strokeWidth={2.4} /></span>
      </div>
      <div className="drop-copy">
        <h3>{title}</h3>
        <p>{subtitle}</p>
        <span className="browse-pill">
          Choose {kind === "image" ? "images" : "PDF"} <ChevronRight size={13} />
        </span>
        <div className="drop-types">
          {kind === "image" ? (
            <><span>JPG</span><span>PNG</span><span>WEBP</span></>
          ) : (
            <><span>PDF</span><span>LOCAL</span><span>NO UPLOAD</span></>
          )}
        </div>
      </div>
      <div className="drop-corner drop-corner-tl" />
      <div className="drop-corner drop-corner-tr" />
      <div className="drop-corner drop-corner-bl" />
      <div className="drop-corner drop-corner-br" />
    </div>
  );
}

interface DestinationPickerProps {
  value: string | null;
  onChoose: () => void;
  onReset: () => void;
  label?: string;
}

export function DestinationPicker({ value, onChoose, onReset, label = "Destination" }: DestinationPickerProps) {
  return (
    <div className="destination">
      <SectionLabel
        right={
          value ? (
            <button className="text-button" onClick={onReset} title="Use the source folder">
              Reset
            </button>
          ) : null
        }
      >
        {label}
      </SectionLabel>
      <div className="destination-box">
        <span className="destination-icon"><Folder size={16} strokeWidth={1.8} /></span>
        <div className="destination-copy" title={value ?? undefined}>
          <strong>{value ? value.split("/").pop() : "Same folder as source"}</strong>
          <span>{value ? parentPath(value) : "Files are saved beside their originals"}</span>
        </div>
        <button className="small-button" onClick={onChoose}>Change</button>
      </div>
    </div>
  );
}

export function OutputPreview({ path, bytes }: { path: string; bytes?: number }) {
  const { revealPath } = useWorkbench();
  return (
    <div className="output-preview">
      <span className="output-check"><Check size={13} strokeWidth={2.4} /></span>
      <div className="output-preview-copy">
        <strong>{path.split("/").pop()}</strong>
        <span>{bytes !== undefined ? humanBytes(bytes) : "Saved"}</span>
      </div>
      <button className="icon-button" onClick={() => void revealPath(path)} title="Show in Finder">
        <FolderOpen size={15} />
      </button>
    </div>
  );
}

export function LastOutcomeCard({
  outcome,
  label = "Last export",
  compact = false,
}: {
  outcome: JobOutcome;
  label?: string;
  compact?: boolean;
}) {
  const { revealPath } = useWorkbench();
  if (outcome.cancelled && !outcome.outputs.length) return null;
  if (!outcome.outputs.length && !outcome.errors.length) return null;
  const first = outcome.outputs[0];
  return (
    <div className={`last-outcome ${compact ? "is-compact" : ""}`}>
      <div className="last-outcome-head">
        <span className="last-outcome-check"><Check size={13} strokeWidth={2.6} /></span>
        <span className="section-label" style={{ margin: 0 }}>{label}</span>
        {first && (
          <button className="icon-button" onClick={() => void revealPath(first.path)} title="Show in Finder">
            <ArrowUpRight size={15} />
          </button>
        )}
      </div>
      {first && (
        <div className="last-outcome-file">
          <strong title={first.path}>{first.name}</strong>
          <span>
            {first.pages ? `${first.pages} pages · ` : first.width ? `${first.width} × ${first.height} · ` : ""}
            {humanBytes(first.bytes)}
          </span>
        </div>
      )}
      {outcome.outputs.length > 1 && (
        <div className="last-outcome-more">
          + {outcome.outputs.length - 1} more {outcome.outputs.length === 2 ? "file" : "files"}
        </div>
      )}
      {outcome.errors.length > 0 && (
        <div className="last-outcome-warn">
          {outcome.errors.length} {outcome.errors.length === 1 ? "file was" : "files were"} skipped
        </div>
      )}
    </div>
  );
}

export function BusyFooter({
  active,
  completed,
  total,
  current,
  onCancel,
}: {
  active: boolean;
  completed: number;
  total: number;
  current: string | null;
  onCancel: () => void;
}) {
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  if (!active) return null;
  return (
    <div className="busy-footer" role="status">
      <div className="busy-top">
        <span className="busy-label"><LoaderCircle size={14} className="spin" /> Working locally</span>
        <span className="busy-count">{completed} / {total}</span>
      </div>
      <div className="progress-track" aria-label="Progress">
        <span style={{ width: `${Math.max(3, percent)}%` }} />
      </div>
      <div className="busy-bottom">
        <span title={current ?? undefined}>{current ? current.split("/").pop() : "Finishing…"}</span>
        <button className="text-button danger" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function PrivacyNote({ children }: { children?: ReactNode }) {
  return (
    <div className="privacy-note">
      <ShieldCheck size={14} strokeWidth={1.9} />
      <span>{children ?? "Processed here on your Mac. The originals are never changed."}</span>
    </div>
  );
}

export function EmptyIcon({ kind }: { kind: "activity" | "queue" }) {
  return (
    <div className={`empty-icon empty-${kind}`}>
      {kind === "activity" ? <ImageIcon size={26} /> : <FileText size={26} />}
    </div>
  );
}

export function CloseChip({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button className="close-chip" onClick={onClick} aria-label={label} title={label}>
      <X size={13} />
    </button>
  );
}
