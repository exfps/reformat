import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  FileText,
  Images,
  Moon,
  Search,
  Settings,
  Star,
  Sun,
} from "lucide-react";
import { useWorkbench } from "../store/workbench";
import { APP_VERSION, TOOLS, type ToolId } from "../lib/tools";
import type { Theme } from "../lib/types";

interface Command {
  id: string;
  label: string;
  detail: string;
  group: "Tools" | "PDF tools" | "Actions" | "Recent files";
  icon: typeof Images;
  keywords: string;
  run: () => void;
  favorite?: boolean;
  recent?: boolean;
}

export function CommandPalette({
  open,
  onClose,
  theme,
  onToggleTheme,
  onOpenSettings,
  favorites,
  recent,
}: {
  open: boolean;
  onClose: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  favorites: ToolId[];
  recent: ToolId[];
}) {
  const { setView, setPdfMode, chooseImages, choosePdfsForMode, activity, revealPath } = useWorkbench();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const toolCommands: Command[] = TOOLS.map((tool) => ({
      id: `tool-${tool.id}`,
      label: tool.label,
      detail: tool.description,
      group: "Tools",
      icon: tool.icon,
      keywords: `${tool.id} ${tool.label} ${tool.description} open go`,
      run: () => setView(tool.id),
      favorite: favorites.includes(tool.id),
      recent: recent.includes(tool.id),
    }));
    const pdfCommands: Command[] = [
      { id: "pdf-merge", label: "Merge PDFs", detail: "Join several documents, in order", icon: FileText, keywords: "pdf combine join" },
      { id: "pdf-split", label: "Split a PDF", detail: "Make one file per page or range", icon: FileText, keywords: "pdf extract pages" },
      { id: "pdf-organize", label: "Organize PDF pages", detail: "Reorder pages with thumbnails", icon: FileText, keywords: "pdf reorder pages rotate" },
      { id: "pdf-topdf", label: "Images to PDF", detail: "Assemble images into one document", icon: FileText, keywords: "pdf images photos assemble" },
      { id: "pdf-export", label: "Export a PDF", detail: "Save text or a Word document", icon: FileText, keywords: "pdf word docx text export convert" },
      { id: "pdf-compress", label: "Shrink a PDF", detail: "Lossless clean-up and compression", icon: FileText, keywords: "pdf compress smaller clean" },
    ].map((command) => ({
      ...command,
      group: "PDF tools",
      icon: FileText,
      run: () => {
        setView("pdf");
        setPdfMode(command.id.replace("pdf-", "") as never);
      },
    }));
    const actionCommands: Command[] = [
      {
        id: "choose-images",
        label: "Choose images…",
        detail: "Open the image picker",
        group: "Actions",
        icon: Images,
        keywords: "open add import images photos",
        run: () => {
          setView("images");
          void chooseImages();
        },
      },
      {
        id: "choose-pdfs",
        label: "Choose PDFs…",
        detail: "Open the PDF picker",
        group: "Actions",
        icon: FileText,
        keywords: "open add import pdf documents",
        run: () => {
          setView("pdf");
          setPdfMode("merge");
          void choosePdfsForMode("merge");
        },
      },
      {
        id: "toggle-theme",
        label: theme === "dark" ? "Use light appearance" : "Use dark appearance",
        detail: "Change the app theme",
        group: "Actions",
        icon: theme === "dark" ? Sun : Moon,
        keywords: "theme dark light appearance color",
        run: onToggleTheme,
      },
      {
        id: "settings",
        label: "Open settings",
        detail: "Appearance, shortcuts and about",
        group: "Actions",
        icon: Settings,
        keywords: "settings preferences options theme density",
        run: onOpenSettings,
      },
    ];
    const seen = new Set<string>();
    const recentCommands: Command[] = [];
    for (const entry of [...activity].reverse()) {
      for (const output of entry.outputs) {
        if (recentCommands.length >= 6) break;
        if (seen.has(output.path)) continue;
        seen.add(output.path);
        recentCommands.push({
          id: `recent-${output.path}`,
          label: output.name,
          detail: "Recent file · click to show in Finder",
          group: "Recent files",
          icon: FileText,
          keywords: `${output.name} ${output.path} recent file output finder`,
          run: () => void revealPath(output.path),
        });
      }
      if (recentCommands.length >= 6) break;
    }
    return [...toolCommands, ...pdfCommands, ...actionCommands, ...recentCommands];
  }, [activity, chooseImages, choosePdfsForMode, favorites, onOpenSettings, onToggleTheme, recent, revealPath, setPdfMode, setView, theme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [...commands].sort((a, b) => {
        if (Boolean(a.favorite) !== Boolean(b.favorite)) return a.favorite ? -1 : 1;
        if (Boolean(a.recent) !== Boolean(b.recent)) return a.recent ? -1 : 1;
        return 0;
      });
    }
    return commands.filter((command) =>
      `${command.label} ${command.detail} ${command.keywords}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) return null;

  const run = (command: Command) => {
    onClose();
    command.run();
  };

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search tools and actions"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-search">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((current) => Math.min(current + 1, filtered.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((current) => Math.max(current - 1, 0));
              } else if (event.key === "Enter" && filtered[selected]) {
                event.preventDefault();
                run(filtered[selected]);
              }
            }}
            placeholder="Search a tool or an action…"
            aria-label="Search a tool or an action"
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-results">
          {filtered.length === 0 ? (
            <div className="palette-empty">No matches. Try “pdf”, “images” or “theme”.</div>
          ) : (
            filtered.map((command, index) => {
              const Icon = command.icon;
              const previous = filtered[index - 1];
              const showGroup = index === 0 || previous?.group !== command.group;
              return (
                <div key={command.id}>
                  {showGroup && <div className="palette-group">{command.group}</div>}
                  <button
                    className={`palette-item ${selected === index ? "is-selected" : ""}`}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => run(command)}
                  >
                    <span className="palette-item-icon"><Icon size={17} strokeWidth={1.8} /></span>
                    <span className="palette-item-copy">
                      <span>{command.label}</span>
                      <small>{command.detail}</small>
                    </span>
                    {command.favorite && <Star size={12} fill="currentColor" className="palette-star" />}
                    {command.recent && !command.favorite && <span className="palette-recent">recent</span>}
                    <ArrowRight size={14} className="palette-arrow" />
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="palette-footer">
          <span><kbd>↑↓</kbd> to move</span>
          <span><kbd>↵</kbd> to choose</span>
          <span className="palette-footer-spacer" />
          <span>Reformat · {APP_VERSION}</span>
        </div>
      </div>
    </div>
  );
}
