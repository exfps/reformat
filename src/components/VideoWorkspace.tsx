import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Clapperboard,
  Film,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useWorkbench } from "../store/workbench";
import { createGif, describeError, pickFolder, pickVideoPaths, probeVideo, readOutputPreview } from "../lib/api";
import { humanBytes, humanDuration, uid } from "../lib/format";
import { usePersistentState } from "../hooks/usePersistentState";
import type { JobOutcome, VideoProbe } from "../lib/types";
import { ToolHeader } from "./ToolHeader";
import { DestinationPicker, DropZone, PrivacyNote, SectionLabel, LastOutcomeCard } from "./ui";

const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v)$/i;

function videoExtension(path: string) {
  return path.match(/\.(mp4|mov|m4v)$/i)?.[1]?.toUpperCase() ?? "VIDEO";
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function GifResult({ outcome, preview, previewFailed }: { outcome: JobOutcome; preview: string | null; previewFailed: boolean }) {
  const { revealPath } = useWorkbench();
  const output = outcome.outputs[0];
  if (!output) return null;
  return (
    <div className="card gif-result">
      <div className="card-head">
        <div>
          <div className="card-title">Your GIF is ready</div>
          <div className="card-sub">{output.name} · {humanBytes(output.bytes)}</div>
        </div>
        <button className="small-button" onClick={() => void revealPath(output.path)}>
          <FolderOpen size={13} /> Show in Finder
        </button>
      </div>
      <div className="gif-result-preview">
        {preview ? <img src={preview} alt="The finished animated GIF" /> : previewFailed ? <span className="gif-no-preview">The GIF is too large to preview here. Use “Show in Finder” to open it.</span> : <LoaderCircle className="spin" size={22} />}
      </div>
    </div>
  );
}

export function VideoWorkspace() {
  const {
    pushToast,
    recordActivity,
    activeJobs,
    startExternalJob,
    finishExternalJob,
    cancelActiveJob,
    pendingDrop,
    clearPendingDrop,
  } = useWorkbench();
  const [video, setVideo] = useState<VideoProbe | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState(0);
  const [duration, setDuration] = useState(4);
  const [fps, setFps] = usePersistentState("reformat.gif-fps.v1", 12);
  const [width, setWidth] = usePersistentState("reformat.gif-width.v1", 640);
  const [loop, setLoop] = usePersistentState("reformat.gif-loop.v1", true);
  const [outputDir, setOutputDir] = usePersistentState<string | null>("reformat.gif-output.v1", null);
  const [fileName, setFileName] = usePersistentState("reformat.gif-name.v1", "my-gif.gif");
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<{ outcome: JobOutcome; preview: string | null; previewFailed: boolean } | null>(null);
  const job = activeJobs.find((item) => item.id === jobId) ?? null;
  const busy = Boolean(job);

  const loadVideo = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const probe = await probeVideo(path);
      setVideo(probe);
      setStart(0);
      setDuration(Math.min(5, Math.max(0.3, probe.duration)));
      const stem = probe.name.replace(/\.[^.]+$/, "");
      setFileName((current) => (current && current !== "my-gif.gif" ? current : `${stem}.gif`));
    } catch (reason) {
      setVideo(null);
      setError(describeError(reason));
    } finally {
      setLoading(false);
    }
  }, [setFileName]);

  const chooseVideo = useCallback(async () => {
    try {
      const paths = await pickVideoPaths();
      if (paths[0]) await loadVideo(paths[0]);
    } catch (reason) {
      pushToast({ kind: "error", title: "Couldn't open the video picker", detail: describeError(reason) });
    }
  }, [loadVideo, pushToast]);

  useEffect(() => {
    if (!pendingDrop || pendingDrop.target !== "video") return;
    const first = pendingDrop.paths.find((path) => VIDEO_EXTENSIONS.test(path));
    clearPendingDrop();
    if (first) void loadVideo(first);
    else pushToast({ kind: "error", title: "That doesn't look like a video", detail: "Try an MP4, MOV, or M4V file." });
  }, [clearPendingDrop, loadVideo, pendingDrop, pushToast]);

  useEffect(() => {
    const onPick = (event: Event) => {
      if ((event as CustomEvent).detail === "video") void chooseVideo();
    };
    window.addEventListener("reformat:pick", onPick);
    return () => window.removeEventListener("reformat:pick", onPick);
  }, [chooseVideo]);

  const estimatedFrames = Math.max(1, Math.round(duration * fps));
  const canMake = Boolean(video && !busy && duration >= 0.15 && start >= 0 && start < video.duration);
  const maxStart = video ? Math.max(0, video.duration - 0.15) : 0;
  const maxDuration = video ? Math.max(0.15, video.duration - start) : 30;

  const makeGif = async () => {
    if (!video || !canMake) return;
    const id = uid();
    const safeStart = Math.min(start, maxStart);
    const safeDuration = Math.min(Math.max(duration, 0.15), Math.max(0.15, video.duration - safeStart));
    setJobId(id);
    setResult(null);
    startExternalJob({
      id,
      tool: "video-to-gif",
      title: "Making your GIF",
      total: Math.min(300, Math.max(1, Math.round(safeDuration * fps))),
      view: "video",
    });
    try {
      const outcome = await createGif({
        jobId: id,
        input: video.path,
        outputDir,
        fileName,
        start: safeStart,
        duration: safeDuration,
        fps,
        width,
        loop,
      });
      finishExternalJob(id);
      setJobId(null);
      if (outcome.cancelled) {
        recordActivity({
          tool: "video-to-gif",
          title: "Video to GIF",
          detail: "Stopped before a GIF was written.",
          status: "cancelled",
          outputs: [],
          errors: [],
        });
        pushToast({ kind: "info", title: "GIF cancelled", detail: "The video is untouched." });
        return;
      }
      const output = outcome.outputs[0];
      recordActivity({
        tool: "video-to-gif",
        title: "Video to GIF",
        detail: `${humanDuration(outcome.elapsedMs)} · ${safeDuration.toFixed(1)}s at ${fps} fps`,
        status: "success",
        outputs: outcome.outputs,
        errors: outcome.errors,
      });
      setResult({ outcome, preview: null, previewFailed: false });
      if (output) {
        void readOutputPreview(output.path)
          .then((preview) => setResult({ outcome, preview, previewFailed: false }))
          .catch(() => setResult({ outcome, preview: null, previewFailed: true }));
      }
      pushToast({
        kind: "success",
        title: "Your GIF is ready",
        detail: output ? `${humanBytes(output.bytes)} · ${estimatedFrames} frames` : "Saved to your chosen folder.",
        revealPath: output?.path,
      });
    } catch (reason) {
      finishExternalJob(id);
      setJobId(null);
      recordActivity({
        tool: "video-to-gif",
        title: "Video to GIF",
        detail: describeError(reason),
        status: "failed",
        outputs: [],
        errors: [],
      });
      pushToast({ kind: "error", title: "Couldn't make this GIF", detail: describeError(reason) });
    }
  };

  return (
    <div className="view-scroll fixed-page">
      <div className="page tool-page video-page">
        <ToolHeader
          icon={Clapperboard}
          title="Make a GIF from a video"
          description="Pick the moment, choose a size, and turn any clip into a looping GIF."
          accent="blue"
        />

        <div className="tool-layout">
          <div className="tool-primary">
            {!video && !loading ? (
              <DropZone
                kind="video"
                grow
                onBrowse={() => void chooseVideo()}
                customTitle="Drop a video to start"
                customSubtitle="MP4, MOV, or M4V. Reformat uses Apple's built-in video engine."
              />
            ) : loading ? (
              <div className="card video-loading">
                <LoaderCircle className="spin" size={24} />
                <div><strong>Reading your video…</strong><span>Grabbing the duration and a preview.</span></div>
              </div>
            ) : error ? (
              <div className="card upload-error">
                <div className="upload-error-icon"><Film size={22} /></div>
                <div><strong>This video couldn't be opened</strong><span>{error}</span></div>
                <button className="small-button" onClick={() => void chooseVideo()}>Try another</button>
              </div>
            ) : video ? (
              <>
                <div className="card video-preview-card">
                  <div className="video-poster">
                    <img src={video.thumbnail} alt="" />
                    <span className="video-play"><Play size={16} fill="currentColor" /></span>
                    <span className="video-poster-badge">{formatTime(video.duration)}</span>
                  </div>
                  <div className="video-file-copy">
                    <div className="video-file-top">
                      <div>
                        <div className="card-title">{video.name}</div>
                        <div className="card-sub">{video.width} × {video.height} · {humanBytes(video.bytes)} · {videoExtension(video.path)}</div>
                      </div>
                      <button className="small-button" onClick={() => void chooseVideo()}>
                        <RotateCcw size={13} /> Replace
                      </button>
                    </div>
                    <div className="video-range-summary">
                      <span>{formatTime(start)} → {formatTime(Math.min(video.duration, start + duration))}</span>
                      <span>{duration.toFixed(1)} seconds · {estimatedFrames} frames</span>
                    </div>
                  </div>
                </div>

                <div className="card clip-settings">
                  <div className="card-head">
                    <div>
                      <div className="card-title">Choose the moment</div>
                      <div className="card-sub">Keep it short and sweet — a GIF is happiest under 10 seconds.</div>
                    </div>
                  </div>
                  <div className="clip-controls">
                    <label className="clip-field">
                      <span>Start at</span>
                      <div className="clip-input"><input type="number" min={0} max={maxStart} step={0.1} value={start} onChange={(event) => setStart(Number(event.target.value) || 0)} /><span>sec</span></div>
                      <small>{formatTime(start)}</small>
                    </label>
                    <label className="clip-field">
                      <span>Length</span>
                      <div className="clip-input"><input type="number" min={0.15} max={maxDuration} step={0.1} value={duration} onChange={(event) => setDuration(Number(event.target.value) || 0.15)} /><span>sec</span></div>
                      <small>{formatTime(duration)}</small>
                    </label>
                    <div className="clip-field">
                      <span>Quick pick</span>
                      <div className="quick-chips">
                        {[2, 4, 6].filter((value) => value <= video.duration + 0.01).map((value) => (
                          <button key={value} className={Math.abs(duration - value) < 0.01 ? "is-active" : ""} onClick={() => { setStart(0); setDuration(Math.min(value, video.duration)); }}>
                            {value}s
                          </button>
                        ))}
                        <button className={Math.abs(duration - Math.min(5, video.duration)) < 0.01 ? "is-active" : ""} onClick={() => { setStart(0); setDuration(Math.min(5, video.duration)); }}>
                          Whole intro
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="settings-grid">
                    <div>
                      <SectionLabel>Frame rate</SectionLabel>
                      <div className="segmented">
                        {[8, 12, 15].map((value) => <button key={value} className={fps === value ? "is-active" : ""} onClick={() => setFps(value)}>{value} fps</button>)}
                      </div>
                    </div>
                    <div>
                      <SectionLabel>Width</SectionLabel>
                      <div className="segmented">
                        {[480, 640, 720].map((value) => <button key={value} className={width === value ? "is-active" : ""} onClick={() => setWidth(value)}>{value}px</button>)}
                      </div>
                    </div>
                    <label className="toggle-row compact">
                      <span><strong>Loop forever</strong><span className="field-note">Play it on repeat like a tiny movie.</span></span>
                      <button type="button" role="switch" aria-checked={loop} className={`switch ${loop ? "is-on" : ""}`} onClick={() => setLoop(!loop)}><span /></button>
                    </label>
                  </div>
                </div>

                {result && <GifResult outcome={result.outcome} preview={result.preview} previewFailed={result.previewFailed} />}
              </>
            ) : null}
          </div>

          <aside className="tool-aside">
            <div className="card inspector-card video-inspector">
              <div className="inspector-head">
                <div>
                  <div className="eyebrow">OUTPUT</div>
                  <h2>A tiny loop.</h2>
                </div>
              </div>
              <div className="inspector-body">
                <DestinationPicker
                  value={outputDir}
                  onChoose={async () => {
                    try {
                      const folder = await pickFolder("Choose where your GIF goes");
                      if (folder) setOutputDir(folder);
                    } catch (reason) {
                      pushToast({ kind: "error", title: "Couldn't choose that folder", detail: describeError(reason) });
                    }
                  }}
                  onReset={() => setOutputDir(null)}
                />
                <div className="template-block">
                  <SectionLabel>File name</SectionLabel>
                  <input className="text-input" value={fileName} onChange={(event) => setFileName(event.target.value)} spellCheck={false} />
                </div>
                <div className="video-summary">
                  <div><span>Clip</span><strong>{video ? `${duration.toFixed(1)}s` : "—"}</strong></div>
                  <div><span>Frames</span><strong>{video ? estimatedFrames : "—"}</strong></div>
                  <div><span>Size</span><strong>{video ? `${width}px` : "—"}</strong></div>
                  <div><span>Loop</span><strong>{loop ? "Yes" : "Once"}</strong></div>
                </div>
                <div className="info-box">
                  <span className="info-box-icon"><Sparkles size={15} /></span>
                  <p>Longer clips make larger GIFs. Under 5 seconds and 640px wide is a friendly place to start.</p>
                </div>
                <PrivacyNote>The video is decoded by macOS on this Mac.</PrivacyNote>
              </div>
              <div className="inspector-foot">
                {job ? (
                  <div className="busy-footer">
                    <div className="busy-top"><span className="busy-label"><LoaderCircle size={14} className="spin" /> Making your GIF</span><span className="busy-count">{job.completed} / {job.total}</span></div>
                    <div className="progress-track"><span style={{ width: `${Math.max(3, Math.round((job.completed / Math.max(1, job.total)) * 100))}%` }} /></div>
                    <div className="busy-bottom"><span>{job.status === "cancelling" ? "Stopping after this frame…" : "Writing frames…"}</span><button className="text-button danger" onClick={() => void cancelActiveJob(job.id)}>Cancel</button></div>
                  </div>
                ) : (
                  <button className="primary-button" disabled={!canMake} onClick={() => void makeGif()}>
                    <span>{video ? "Make my GIF" : "Add a video to start"}</span>
                    <span className="primary-arrow"><ArrowRight size={16} /></span>
                  </button>
                )}
                {video && !job && (
                  <p className="foot-note"><ImageIcon size={12} /> GIF output · plays {loop ? "on repeat" : "once"}</p>
                )}
              </div>
            </div>
            {result && <LastOutcomeCard outcome={result.outcome} compact label="Last GIF" />}
          </aside>
        </div>
      </div>
    </div>
  );
}
