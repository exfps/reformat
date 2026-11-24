import { Files, History, Image as ImageIcon, LoaderCircle, ShieldCheck } from "lucide-react";
import { useWorkbench } from "../store/workbench";
import { LogoMark } from "./LogoMark";
import { basename } from "../lib/format";

export function Sidebar() {
  const {
    view,
    setView,
    imageItems,
    mergeItems,
    splitFile,
    organizeFile,
    compressFile,
    activeJobs,
  } = useWorkbench();
  const pdfCount =
    mergeItems.length +
    (splitFile ? 1 : 0) +
    (organizeFile ? 1 : 0) +
    (compressFile ? 1 : 0);
  const job = activeJobs[0];

  return (
    <aside className="sidebar">
      <div className="sidebar-drag" data-tauri-drag-region />
      <div className="brand" data-tauri-drag-region>
        <LogoMark size={36} />
        <div className="brand-copy" data-tauri-drag-region>
          <div className="brand-name">reformat</div>
          <div className="brand-tag">PRIVATE WORKBENCH</div>
        </div>
      </div>

      <nav className="nav" aria-label="Workbench">
        <div className="nav-label">WORKBENCH</div>
        <button
          className={`nav-item ${view === "images" ? "is-active" : ""}`}
          onClick={() => setView("images")}
          aria-current={view === "images" ? "page" : undefined}
        >
          <span className="nav-icon"><ImageIcon size={17} strokeWidth={1.8} /></span>
          <span>Images</span>
          {imageItems.length > 0 && <span className="nav-count">{imageItems.length}</span>}
        </button>
        <button
          className={`nav-item ${view === "pdf" ? "is-active" : ""}`}
          onClick={() => setView("pdf")}
          aria-current={view === "pdf" ? "page" : undefined}
        >
          <span className="nav-icon"><Files size={17} strokeWidth={1.8} /></span>
          <span>PDF Studio</span>
          {pdfCount > 0 && <span className="nav-count">{pdfCount}</span>}
        </button>
        <button
          className={`nav-item ${view === "activity" ? "is-active" : ""}`}
          onClick={() => setView("activity")}
          aria-current={view === "activity" ? "page" : undefined}
        >
          <span className="nav-icon"><History size={17} strokeWidth={1.8} /></span>
          <span>Activity</span>
          {job && <span className="nav-live" aria-label="Job running" />}
        </button>
      </nav>

      <div className="sidebar-spacer" />

      {job && (
        <button
          className="sidebar-job"
          onClick={() => setView(job.view)}
          title="Go to the running job"
        >
          <div className="sidebar-job-top">
            <span className="sidebar-job-label">
              <LoaderCircle size={13} className="spin" />
              {job.status === "cancelling" ? "Cancelling" : "Working locally"}
            </span>
            <span className="sidebar-job-pct">
              {job.total ? Math.round((job.completed / job.total) * 100) : 0}%
            </span>
          </div>
          <div className="sidebar-job-file">{job.current ? basename(job.current) : job.title}</div>
          <div className="sidebar-job-track">
            <span
              style={{
                width: `${job.total ? Math.max(2, (job.completed / job.total) * 100) : 2}%`,
              }}
            />
          </div>
        </button>
      )}

      <div className="privacy-card">
        <div className="privacy-icon"><ShieldCheck size={18} strokeWidth={1.7} /></div>
        <div>
          <div className="privacy-title">On-device only</div>
          <div className="privacy-copy">No uploads. No accounts. No telemetry.</div>
        </div>
      </div>

      <div className="sidebar-foot">
        <span className="status-dot" />
        <span>macOS</span>
        <span className="dot-sep">·</span>
        <span>v1.0</span>
        <span className="sidebar-foot-right">OFFLINE</span>
      </div>
    </aside>
  );
}
