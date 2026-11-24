import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { Toaster } from "./components/Toaster";
import { DragOverlay } from "./components/DragOverlay";
import { ImageWorkspace } from "./components/ImageWorkspace";
import { PdfWorkspace } from "./components/PdfWorkspace";
import { VideoWorkspace } from "./components/VideoWorkspace";
import { ArchiveWorkspace } from "./components/ArchiveWorkspace";
import { ActivityView } from "./components/ActivityView";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsDialog, type Density } from "./components/SettingsDialog";
import { WorkbenchProvider, useWorkbench } from "./store/workbench";
import { usePersistentState } from "./hooks/usePersistentState";
import type { Theme } from "./lib/types";
import type { ToolId } from "./lib/tools";

function Shell() {
  const {
    view,
    pdfMode,
    chooseImages,
    choosePdfImages,
    choosePdfsForMode,
  } = useWorkbench();
  const [theme, setTheme] = usePersistentState<Theme>("reformat.theme.v2", "light");
  const [density, setDensity] = usePersistentState<Density>("reformat.density.v2", "comfortable");
  const [favorites, setFavorites] = usePersistentState<ToolId[]>("reformat.favorites.v2", []);
  const [recent, setRecent] = usePersistentState<ToolId[]>("reformat.recent-tools.v2", ["images"]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density;
  }, [theme, density]);

  useEffect(() => {
    setRecent((current) => [view, ...current.filter((item) => item !== view)].slice(0, 5));
  }, [setRecent, view]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSettingsOpen(false);
        setPaletteOpen((open) => !open);
        return;
      }
      if (command && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (view === "images") void chooseImages();
        else if (view === "pdf") {
          if (pdfMode === "topdf") void choosePdfImages();
          else if (pdfMode === "export") window.dispatchEvent(new CustomEvent("reformat:pick", { detail: "pdf-export" }));
          else void choosePdfsForMode(pdfMode);
        } else if (view === "video" || view === "archives") {
          window.dispatchEvent(new CustomEvent("reformat:pick", { detail: view }));
        }
        return;
      }
      if (command && event.key === ",") {
        event.preventDefault();
        setPaletteOpen(false);
        setSettingsOpen(true);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseImages, choosePdfImages, choosePdfsForMode, pdfMode, view]);

  const toggleFavorite = (tool: ToolId) => {
    setFavorites((current) =>
      current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool],
    );
  };

  return (
    <div className="app-shell">
      <Sidebar
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main">
        <Topbar
          theme={theme}
          onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <div className="views">
          <section className="view" hidden={view !== "images"} aria-label="Image converter">
            <ImageWorkspace />
          </section>
          <section className="view" hidden={view !== "pdf"} aria-label="PDF tools">
            <PdfWorkspace />
          </section>
          <section className="view" hidden={view !== "video"} aria-label="Video to GIF">
            <VideoWorkspace />
          </section>
          <section className="view" hidden={view !== "archives"} aria-label="Archive tools">
            <ArchiveWorkspace />
          </section>
          {view === "activity" && (
            <section className="view" aria-label="Recent work">
              <ActivityView />
            </section>
          )}
        </div>
      </main>
      <Toaster />
      <DragOverlay />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        theme={theme}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        onOpenSettings={() => {
          setPaletteOpen(false);
          setSettingsOpen(true);
        }}
        favorites={favorites}
        recent={recent}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onTheme={setTheme}
        density={density}
        onDensity={setDensity}
      />
    </div>
  );
}

export default function App() {
  return (
    <WorkbenchProvider>
      <Shell />
    </WorkbenchProvider>
  );
}
