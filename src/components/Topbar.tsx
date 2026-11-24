import type { CSSProperties } from "react";
import { LoaderCircle, Moon, Search, Settings, Sun, X } from "lucide-react";
import { useWorkbench, PDF_MODE_META } from "../store/workbench";
import { TOOL_BY_ID } from "../lib/tools";
import { basename } from "../lib/format";
import type { Theme } from "../lib/types";

export function Topbar({
  theme,
  onToggleTheme,
  onOpenPalette,
  onOpenSettings,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
}) {
  const { view, pdfMode, activeJobs, cancelActiveJob, setView } = useWorkbench();
  const tool = TOOL_BY_ID[view];
  const primaryJob = activeJobs[0];
  const percent = primaryJob?.total
    ? Math.round((primaryJob.completed / primaryJob.total) * 100)
    : 0;

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-heading" data-tauri-drag-region>
        <span className="topbar-title">{tool.label}</span>
        {view === "pdf" && <span className="topbar-sub">{PDF_MODE_META[pdfMode].label}</span>}
      </div>

      <button className="search-trigger" onClick={onOpenPalette}>
        <Search size={15} />
        <span>Search tools and actions</span>
        <kbd>⌘ K</kbd>
      </button>

      <div className="topbar-right">
        {primaryJob && (
          <div className="job-pill">
            <button className="job-pill-main" onClick={() => setView(primaryJob.view)} title="Go to this task">
              <LoaderCircle size={14} className="spin" />
              <span className="job-pill-copy">
                <span className="job-pill-title">
                  {primaryJob.status === "cancelling" ? "Stopping…" : primaryJob.title}
                </span>
                <span className="job-pill-file">
                  {primaryJob.current ? basename(primaryJob.current) : "Getting ready…"}
                </span>
              </span>
              <span className="job-pill-ring" style={{ "--pct": `${percent}%` } as CSSProperties}>
                <span>{percent}%</span>
              </span>
            </button>
            <button
              className="job-pill-cancel"
              aria-label="Cancel this task"
              title="Cancel"
              onClick={() => void cancelActiveJob(primaryJob.id)}
            >
              <X size={13} />
            </button>
          </div>
        )}
        <button className="icon-button topbar-icon" onClick={onToggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} aria-label="Toggle color theme">
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button className="icon-button topbar-icon" onClick={onOpenSettings} title="Settings" aria-label="Settings">
          <Settings size={17} />
        </button>
      </div>
    </header>
  );
}
