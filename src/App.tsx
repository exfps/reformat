import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { Toaster } from "./components/Toaster";
import { DragOverlay } from "./components/DragOverlay";
import { ImageWorkspace } from "./components/ImageWorkspace";
import { PdfWorkspace } from "./components/PdfWorkspace";
import { ActivityView } from "./components/ActivityView";
import { WorkbenchProvider, useWorkbench } from "./store/workbench";

function Shell() {
  const { view, pdfMode, isDesktop, chooseImages, choosePdfImages, choosePdfsForMode } = useWorkbench();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (view === "images") void chooseImages();
        else if (view === "pdf") {
          if (pdfMode === "topdf") void choosePdfImages();
          else void choosePdfsForMode(pdfMode);
        } else {
          void chooseImages();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseImages, choosePdfImages, choosePdfsForMode, pdfMode, view]);

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main">
        <Topbar />
        {!isDesktop && (
          <div className="preview-banner">
            <span className="preview-dot" />
            UI preview · file actions are enabled in the packaged desktop app.
          </div>
        )}
        <div className="views">
          <section className="view" hidden={view !== "images"} aria-label="Image converter">
            <ImageWorkspace />
          </section>
          <section className="view" hidden={view !== "pdf"} aria-label="PDF Studio">
            <PdfWorkspace />
          </section>
          {view === "activity" && (
            <section className="view" aria-label="Activity">
              <ActivityView />
            </section>
          )}
        </div>
      </main>
      <Toaster />
      <DragOverlay />
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
