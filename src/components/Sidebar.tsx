import { Command, Settings, Star } from "lucide-react";
import { useWorkbench } from "../store/workbench";
import { APP_VERSION, TOOLS, type ToolId } from "../lib/tools";
import { LogoMark } from "./LogoMark";

export function Sidebar({
  favorites,
  onToggleFavorite,
  onOpenPalette,
  onOpenSettings,
}: {
  favorites: ToolId[];
  onToggleFavorite: (tool: ToolId) => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
}) {
  const { view, setView, imageItems, mergeItems, splitFile, organizeFile, compressFile } = useWorkbench();
  const pdfCount =
    mergeItems.length +
    (splitFile ? 1 : 0) +
    (organizeFile ? 1 : 0) +
    (compressFile ? 1 : 0);

  return (
    <aside className="sidebar">
      <div className="sidebar-drag" data-tauri-drag-region />
      <button className="brand" onClick={() => setView("images")} data-tauri-drag-region>
        <LogoMark size={36} />
        <span className="brand-copy" data-tauri-drag-region>
          <span className="brand-name">reformat</span>
          <span className="brand-tag">A calmer file workbench.</span>
        </span>
      </button>

      <button className="quick-open" onClick={onOpenPalette}>
        <span className="quick-open-icon"><Command size={14} /></span>
        <span>Find a tool</span>
        <kbd>⌘ K</kbd>
      </button>

      <nav className="nav" aria-label="Tools">
        <div className="nav-label">TOOLS</div>
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          const active = view === tool.id;
          const favorite = favorites.includes(tool.id);
          const count = tool.id === "images" ? imageItems.length : tool.id === "pdf" ? pdfCount : 0;
          return (
            <div className={`nav-row ${active ? "is-active" : ""}`} key={tool.id}>
              <button
                className="nav-item"
                onClick={() => setView(tool.id)}
                aria-current={active ? "page" : undefined}
              >
                <span className={`nav-icon accent-${tool.accent}`}><Icon size={18} strokeWidth={1.8} /></span>
                <span className="nav-copy">
                  <span>{tool.label}</span>
                  <small>{tool.description}</small>
                </span>
                {count > 0 && <span className="nav-count">{count}</span>}
              </button>
              <button
                className={`nav-star ${favorite ? "is-on" : ""}`}
                onClick={() => onToggleFavorite(tool.id)}
                aria-label={favorite ? `Unpin ${tool.label}` : `Pin ${tool.label}`}
                title={favorite ? "Remove from pinned tools" : "Pin this tool"}
              >
                <Star size={12} fill={favorite ? "currentColor" : "none"} />
              </button>
            </div>
          );
        })}
      </nav>

      <div className="sidebar-spacer" />

      <div className="sidebar-bottom">
        <button className="side-action" onClick={onOpenSettings}>
          <Settings size={16} strokeWidth={1.8} />
          <span>Settings</span>
        </button>
        <div className="sidebar-foot">
          <span>Reformat {APP_VERSION}</span>
          <span>·</span>
          <span>Made for macOS</span>
        </div>
      </div>
    </aside>
  );
}
