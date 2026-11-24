import { useState, type CSSProperties } from "react";
import {
  ArrowRight,
  Check,
  FolderOpen,
  GripVertical,
  Image as ImageIcon,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useWorkbench } from "../store/workbench";
import {
  humanBytes,
  IMAGE_PRESETS,
  renderImageName,
  resolveTargetDimensions,
} from "../lib/format";
import type { ImageItem, ImagePreset, ResizeMode } from "../lib/types";
import {
  BusyFooter,
  DestinationPicker,
  DropZone,
  FileGlyph,
  LastOutcomeCard,
  PrivacyNote,
  SectionLabel,
} from "./ui";

function StatusBadge({ item, running }: { item: ImageItem; running: boolean }) {
  if (running) {
    return <span className="badge badge-running"><LoaderCircle size={11} className="spin" /> Working</span>;
  }
  if (item.status === "done") {
    return <span className="badge badge-done"><Check size={11} /> Saved</span>;
  }
  if (item.status === "error") {
    return <span className="badge badge-error">Needs attention</span>;
  }
  return <span className="badge badge-ready">Ready</span>;
}

function QueueRow({
  item,
  index,
  running,
  busy,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isOver,
}: {
  item: ImageItem;
  index: number;
  running: boolean;
  busy: boolean;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  isOver: boolean;
}) {
  const { revealPath } = useWorkbench();
  const extension = item.name.split(".").pop()?.toUpperCase() ?? "IMG";
  return (
    <div
      className={`queue-row ${running ? "is-running" : ""} ${isOver ? "is-drag-over" : ""} ${item.status === "error" ? "has-error" : ""}`}
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
      <span className="grip" aria-hidden="true"><GripVertical size={15} /></span>
      <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
      <div className="thumb-wrap">
        {item.thumbnail ? (
          <img src={item.thumbnail} alt="" className="thumb" draggable={false} />
        ) : (
          <FileGlyph kind="image" size={50} />
        )}
        {running && <span className="thumb-scan" />}
      </div>
      <div className="queue-main">
        <div className="queue-title-row">
          <span className="queue-name" title={item.path}>{item.name}</span>
          <StatusBadge item={item} running={running} />
        </div>
        <div className="queue-meta">
          <span>{extension}</span>
          {item.width && item.height && <><span className="meta-dot" /><span>{item.width} × {item.height}</span></>}
          <span className="meta-dot" />
          <span>{humanBytes(item.bytes)}</span>
        </div>
        {item.status === "error" && item.error && (
          <div className="queue-error" title={item.error}>{item.error}</div>
        )}
        {item.output && (
          <button className="queue-output" onClick={() => void revealPath(item.output!.path)}>
            <FolderOpen size={12} />
            <span>{item.output.name}</span>
            <span className="queue-output-size">{humanBytes(item.output.bytes)}</span>
          </button>
        )}
      </div>
      <button
        className="icon-button queue-remove"
        onClick={onRemove}
        disabled={busy}
        aria-label={`Remove ${item.name}`}
        title="Remove"
      >
        <X size={15} />
      </button>
    </div>
  );
}

function QueueCard() {
  const {
    imageItems,
    activeImageJob,
    isImageBusy,
    removeImage,
    clearImages,
    moveImage,
    imageLastOutcome,
    chooseImages,
  } = useWorkbench();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const totalBytes = imageItems.reduce((sum, item) => sum + item.bytes, 0);
  const current = activeImageJob?.current;

  return (
    <div className="card queue-card">
      <div className="card-head">
        <div>
          <div className="card-title">Queue <span className="card-count">{imageItems.length}</span></div>
          <div className="card-sub">
            {imageItems.length ? `${humanBytes(totalBytes)} in queue` : "Drop images to get started"}
          </div>
        </div>
        <div className="card-actions">
          <button className="small-button" onClick={() => void chooseImages()} disabled={isImageBusy}>
            Add files
          </button>
          <button className="text-button" onClick={clearImages} disabled={isImageBusy || !imageItems.length}>
            Clear
          </button>
        </div>
      </div>

      {imageItems.length === 0 ? (
        <div className="queue-empty">
          <span className="queue-empty-icon"><ImageIcon size={20} /></span>
          <div>
            <strong>Nothing queued yet</strong>
            <span>Add a few images and they'll line up here, in order.</span>
          </div>
        </div>
      ) : (
        <div className="queue-list">
          {imageItems.map((item, index) => (
            <QueueRow
              key={item.id}
              item={item}
              index={index}
              running={Boolean(current && item.path === current)}
              busy={Boolean(isImageBusy)}
              onRemove={() => removeImage(item.id)}
              onDragStart={() => setDragIndex(index)}
              onDragOver={() => setOverIndex(index)}
              onDrop={() => {
                if (dragIndex !== null) moveImage(dragIndex, index);
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
      )}

      {imageLastOutcome && imageLastOutcome.outputs.length > 0 && !isImageBusy && (
        <div className="queue-foot">
          <LastOutcomeCard outcome={imageLastOutcome} compact label="Last conversion" />
        </div>
      )}
    </div>
  );
}

function FormatButtons() {
  const { imageSettings, updateImageSettings, isImageBusy } = useWorkbench();
  const formats = [
    { id: "jpeg" as const, label: "JPG", note: "Universal" },
    { id: "png" as const, label: "PNG", note: "Lossless" },
    { id: "webp" as const, label: "WebP", note: "Smallest" },
  ];
  return (
    <div className="format-grid">
      {formats.map((format) => (
        <button
          key={format.id}
          className={`format-card ${imageSettings.format === format.id ? "is-active" : ""}`}
          onClick={() => updateImageSettings({ format: format.id })}
          disabled={isImageBusy}
          aria-pressed={imageSettings.format === format.id}
        >
          <span className="format-name">{format.label}</span>
          <span className="format-note">{format.note}</span>
          {imageSettings.format === format.id && <span className="format-check"><Check size={10} /></span>}
        </button>
      ))}
    </div>
  );
}

function QualitySlider() {
  const { imageSettings, updateImageSettings, isImageBusy } = useWorkbench();
  const disabled = isImageBusy || imageSettings.format === "png";
  const fill = ((imageSettings.quality - 30) / 70) * 100;
  return (
    <div className={`quality-row ${disabled ? "is-disabled" : ""}`}>
      <div className="label-row">
        <span className="field-label">Quality</span>
        <span className="quality-value">{imageSettings.format === "png" ? "Lossless" : imageSettings.quality}</span>
      </div>
      <input
        className="range"
        type="range"
        min={30}
        max={100}
        step={1}
        value={imageSettings.quality}
        disabled={disabled}
        onChange={(event) => updateImageSettings({ quality: Number(event.target.value) })}
        style={{ "--fill": `${fill}%` } as CSSProperties}
        aria-label="Output quality"
      />
      <div className="range-labels"><span>Smaller</span><span>Sharper</span></div>
      <p className="field-note">
        {imageSettings.format === "png"
          ? "PNG is always lossless. Quality is handled by its encoder."
          : imageSettings.format === "jpeg"
            ? "A good default is 80–85. Transparency turns white in JPG."
            : "WebP keeps transparency and stays small. 80–85 is a safe default."}
      </p>
    </div>
  );
}

function ResizeControls() {
  const { imageSettings, updateImageSettings, isImageBusy } = useWorkbench();
  const activeMode = imageSettings.mode;
  const noResize = activeMode === "none";

  const setMode = (mode: ResizeMode) => {
    updateImageSettings({
      mode,
      width: imageSettings.width ?? 1600,
      height: imageSettings.height ?? 1600,
    });
  };

  return (
    <div className="resize-section">
      <SectionLabel>Resize</SectionLabel>
      <div className="preset-grid">
        {IMAGE_PRESETS.map((preset: ImagePreset) => (
          <button
            key={preset.id}
            className={`preset-card ${imageSettings.presetId === preset.id ? "is-active" : ""}`}
            onClick={() => updateImageSettings({ presetId: preset.id })}
            disabled={isImageBusy}
            aria-pressed={imageSettings.presetId === preset.id}
          >
            <span className="preset-label">{preset.label}</span>
            <span className="preset-detail">{preset.detail}</span>
            {imageSettings.presetId === preset.id && <span className="preset-dot" />}
          </button>
        ))}
      </div>

      <div className={`size-row ${noResize ? "is-disabled" : ""}`}>
        <label className="number-field">
          <span>Width</span>
          <div>
            <input
              type="number"
              min={1}
              max={32000}
              value={imageSettings.width ?? ""}
              placeholder="Auto"
              disabled={isImageBusy || noResize}
              onChange={(event) => {
                const value = event.target.value === "" ? null : Number(event.target.value);
                updateImageSettings({ width: value });
              }}
            />
            <span className="unit">px</span>
          </div>
        </label>
        <span className="size-times">×</span>
        <label className="number-field">
          <span>Height</span>
          <div>
            <input
              type="number"
              min={1}
              max={32000}
              value={imageSettings.height ?? ""}
              placeholder="Auto"
              disabled={isImageBusy || noResize}
              onChange={(event) => {
                const value = event.target.value === "" ? null : Number(event.target.value);
                updateImageSettings({ height: value });
              }}
            />
            <span className="unit">px</span>
          </div>
        </label>
      </div>

      <div className="segmented mini">
        {[
          { id: "fit" as const, label: "Fit" },
          { id: "cover" as const, label: "Fill" },
          { id: "stretch" as const, label: "Stretch" },
        ].map((mode) => (
          <button
            key={mode.id}
            className={activeMode === mode.id ? "is-active" : ""}
            onClick={() => setMode(mode.id)}
            disabled={isImageBusy || noResize}
          >
            {mode.label}
          </button>
        ))}
      </div>
      <p className="field-note">
        {activeMode === "cover"
          ? "Fills the frame and crops the overflow from the centre."
          : activeMode === "stretch"
            ? "Uses the exact box, even if that changes proportions."
            : activeMode === "none"
              ? "Keeps the original pixel dimensions."
              : "Fits inside the box without cropping."}
      </p>

      <label className={`toggle-row ${noResize ? "is-disabled" : ""}`}>
        <span>
          <strong>Allow upscaling</strong>
          <span className="field-note">Enlarge small sources instead of clamping to their size.</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={imageSettings.allowUpscale}
          className={`switch ${imageSettings.allowUpscale ? "is-on" : ""}`}
          onClick={() => updateImageSettings({ allowUpscale: !imageSettings.allowUpscale })}
          disabled={isImageBusy || noResize}
        >
          <span />
        </button>
      </label>
    </div>
  );
}

function OutputRecipe() {
  const {
    imageItems,
    imageSettings,
    imageOutputDir,
    updateImageSettings,
    chooseImageFolder,
    setImageOutputDir,
    convertSelectedImages,
    isImageBusy,
    activeImageJob,
    cancelActiveJob,
  } = useWorkbench();
  const validItems = imageItems.filter((item) => item.status !== "error");
  const allDone = validItems.length > 0 && validItems.every((item) => item.status === "done");
  const first = validItems[0] ?? imageItems[0];
  const previewName = first ? renderImageName(imageSettings.template, first, imageSettings, 0) : "your-image.webp";
  const target = first ? resolveTargetDimensions(first, imageSettings) : null;
  const busy = Boolean(activeImageJob);
  const canConvert = validItems.length > 0 && !busy;

  const insertToken = (token: string) => {
    updateImageSettings({ template: `${imageSettings.template}${imageSettings.template.endsWith(" ") ? "" : " "}${token}` });
  };

  return (
    <div className="card inspector-card">
      <div className="inspector-head">
        <div>
          <div className="eyebrow">OUTPUT RECIPE</div>
          <h2>Set the rules <span>once.</span></h2>
        </div>
        <span className="recipe-number">01</span>
      </div>

      <div className="inspector-body">
        <div className="settings-block">
          <SectionLabel>Format</SectionLabel>
          <FormatButtons />
          <QualitySlider />
        </div>

        <div className="divider" />
        <ResizeControls />

        <div className="divider" />
        <div className="settings-block">
          <DestinationPicker
            value={imageOutputDir}
            onChoose={() => void chooseImageFolder()}
            onReset={() => setImageOutputDir(null)}
          />
          <div className="template-block">
            <SectionLabel
              right={<span className="field-hint">Optional</span>}
            >
              File name
            </SectionLabel>
            <input
              className="text-input mono"
              value={imageSettings.template}
              onChange={(event) => updateImageSettings({ template: event.target.value })}
              disabled={isImageBusy}
              spellCheck={false}
              aria-label="File name template"
            />
            <div className="token-row">
              {["{name}", "{width}", "{index}"].map((token) => (
                <button key={token} className="token" onClick={() => insertToken(token)} disabled={isImageBusy}>
                  {token}
                </button>
              ))}
            </div>
            <div className="preview-line">
              <span>Preview</span>
              <code title={previewName}>{previewName}</code>
            </div>
          </div>
        </div>
      </div>

      <div className="inspector-foot">
        {busy && activeImageJob ? (
          <BusyFooter
            active
            completed={activeImageJob.completed}
            total={activeImageJob.total || validItems.length}
            current={activeImageJob.current}
            onCancel={() => void cancelActiveJob(activeImageJob.id)}
          />
        ) : (
          <>
            <div className="conversion-summary">
              <div>
                <span className="summary-number">{validItems.length || "—"}</span>
                <span className="summary-label">{validItems.length === 1 ? "image" : "images"}</span>
              </div>
              <div className="summary-arrow"><ArrowRight size={15} /></div>
              <div>
                <span className="summary-number">{target ? `${target.width}×${target.height}` : "—"}</span>
                <span className="summary-label">{imageSettings.format === "jpeg" ? "JPG" : imageSettings.format.toUpperCase()}</span>
              </div>
            </div>
            <button className="primary-button" disabled={!canConvert} onClick={() => void convertSelectedImages()}>
              <span>
                {!validItems.length
                  ? "Add images to start"
                  : allDone
                    ? "Convert again"
                    : `Convert ${validItems.length} ${validItems.length === 1 ? "image" : "images"}`}
              </span>
              <span className="primary-arrow"><ArrowRight size={16} /></span>
            </button>
            {imageItems.some((item) => item.status === "error") && (
              <p className="foot-note"><span className="tiny-warning" /> Unreadable files are skipped, never raised.</p>
            )}
          </>
        )}
        <PrivacyNote>Everything happens on this Mac. Originals are never modified.</PrivacyNote>
      </div>
    </div>
  );
}

function StarterNotes() {
  return (
    <div className="starter-notes">
      <div className="starter">
        <span className="starter-icon"><ShieldCheck size={16} /></span>
        <div><strong>Private by default</strong><span>No uploads, ever. The queue runs entirely on your machine.</span></div>
      </div>
      <div className="starter">
        <span className="starter-icon"><Sparkles size={16} /></span>
        <div><strong>Originals untouched</strong><span>Every output lands in a new file. Nothing is overwritten.</span></div>
      </div>
      <div className="starter">
        <span className="starter-icon"><RotateCcw size={16} /></span>
        <div><strong>Safe to retry</strong><span>A damaged file fails on its own without stopping the batch.</span></div>
      </div>
    </div>
  );
}

export function ImageWorkspace() {
  const { imageItems, chooseImages, isImageBusy } = useWorkbench();
  const hasItems = imageItems.length > 0;
  return (
    <div className="view-scroll fixed-page">
      <div className="page image-page">
        <header className="page-hero">
          <div className="hero-copy">
            <div className="eyebrow-row">
              <span className="eyebrow">BATCH CONVERTER</span>
              <span className="hero-rule" />
              <span className="hero-index">01 / 03</span>
            </div>
            <h1>
              {isImageBusy ? (
                <>Working through <em>the batch.</em></>
              ) : (
                <>Make every image <em>fit.</em></>
              )}
            </h1>
            <p>
              Convert, resize, and compress JPG, PNG, and WebP in one quiet pass.
              Originals stay exactly as they were.
            </p>
          </div>
          <div className="hero-seal" aria-hidden="true">
            <span className="seal-ring" />
            <ShieldCheck size={24} strokeWidth={1.4} />
            <span className="seal-text">NO<br />UPLOADS</span>
            <span className="seal-star">✦</span>
          </div>
        </header>

        <div className="image-layout">
          <div className="primary-stack">
            {hasItems ? (
              <DropZone kind="image" compact onBrowse={() => void chooseImages()} disabled={isImageBusy} />
            ) : (
              <DropZone kind="image" onBrowse={() => void chooseImages()} disabled={isImageBusy} />
            )}
            <QueueCard />
            {!hasItems && <StarterNotes />}
          </div>
          <aside className="inspector">
            <OutputRecipe />
          </aside>
        </div>
      </div>
    </div>
  );
}
