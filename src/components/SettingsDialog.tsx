import { useEffect } from "react";
import { Moon, Sun, X } from "lucide-react";
import type { Theme } from "../lib/types";
import { APP_VERSION } from "../lib/tools";

export type Density = "comfortable" | "compact";

export function SettingsDialog({
  open,
  onClose,
  theme,
  onTheme,
  density,
  onDensity,
}: {
  open: boolean;
  onClose: () => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  density: Density;
  onDensity: (density: Density) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-head">
          <div>
            <span className="eyebrow">SETTINGS</span>
            <h2>Make it yours.</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={17} /></button>
        </div>

        <section className="settings-section">
          <div className="settings-label">Appearance</div>
          <div className="theme-choices">
            <button className={`theme-choice ${theme === "light" ? "is-active" : ""}`} onClick={() => onTheme("light")}>
              <span className="theme-preview theme-preview-light"><span /><span /><span /></span>
              <span className="theme-choice-copy"><Sun size={15} /><strong>Light</strong></span>
            </button>
            <button className={`theme-choice ${theme === "dark" ? "is-active" : ""}`} onClick={() => onTheme("dark")}>
              <span className="theme-preview theme-preview-dark"><span /><span /><span /></span>
              <span className="theme-choice-copy"><Moon size={15} /><strong>Dark</strong></span>
            </button>
          </div>
          <div className="density-row">
            <div>
              <strong>Comfortable spacing</strong>
              <span>More breathing room around files and controls.</span>
            </div>
            <div className="segmented">
              <button className={density === "comfortable" ? "is-active" : ""} onClick={() => onDensity("comfortable")}>Comfortable</button>
              <button className={density === "compact" ? "is-active" : ""} onClick={() => onDensity("compact")}>Compact</button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-label">Shortcuts</div>
          <div className="shortcut-list">
            <div><span>Search tools and actions</span><kbd>⌘ K</kbd></div>
            <div><span>Open files for the current tool</span><kbd>⌘ O</kbd></div>
            <div><span>Close a dialog</span><kbd>esc</kbd></div>
          </div>
        </section>

        <section className="settings-section about-section">
          <div className="settings-label">About</div>
          <div className="about-line"><strong>Reformat {APP_VERSION}</strong><span>MIT licensed · made for macOS</span></div>
          <p>Everything you add is processed on this Mac. Reformat does not upload files, create accounts, or collect usage data.</p>
        </section>
      </div>
    </div>
  );
}
