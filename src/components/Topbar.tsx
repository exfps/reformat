import { LoaderCircle, ShieldCheck, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useWorkbench, PDF_MODE_META } from "../store/workbench";
import { basename } from "../lib/format";

export function Topbar() {
  const { view, pdfMode, activeJobs, cancelActiveJob, setView } = useWorkbench();
  const primaryJob = activeJobs[0];
  const percent = primaryJob?.total
    ? Math.round((primaryJob.completed / primaryJob.total) * 100)
    : 0;
  const section =
    view === "images" ? "Images" : view === "pdf" ? "PDF Studio" : "Activity";

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="crumbs" data-tauri-drag-region>
        <span>WORKBENCH</span>
        <span className="crumb-slash">/</span>
        <strong>{section}</strong>
        {view === "pdf" && (
          <>
            <span className="crumb-slash">/</span>
            <span>{PDF_MODE_META[pdfMode].label}</span>
          </>
        )}
      </div>

      <div className="topbar-right">
        {primaryJob ? (
          <button
            className="job-pill"
            onClick={() => setView(primaryJob.view)}
            title="Go to the running job"
          >
            <LoaderCircle size={14} className="spin" />
            <span className="job-pill-copy">
              <span className="job-pill-title">
                {primaryJob.status === "cancelling" ? "Cancelling" : primaryJob.title}
              </span>
              <span className="job-pill-file">
                {primaryJob.current ? basename(primaryJob.current) : "Preparing…"}
              </span>
            </span>
            <span className="job-pill-ring" style={{ "--pct": `${percent}%` } as CSSProperties}>
              <span>{percent}%</span>
            </span>
            <span
              className="job-pill-cancel"
              role="button"
              tabIndex={0}
              aria-label="Cancel job"
              title="Cancel"
              onClick={(event) => {
                event.stopPropagation();
                void cancelActiveJob(primaryJob.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  void cancelActiveJob(primaryJob.id);
                }
              }}
            >
              <X size={13} />
            </span>
          </button>
        ) : (
          <div className="local-pill">
            <ShieldCheck size={14} strokeWidth={1.9} />
            <span>100% local</span>
          </div>
        )}
        <div className="ready-pill">
          <span className="status-dot" />
          <span>No network</span>
        </div>
      </div>
    </header>
  );
}
