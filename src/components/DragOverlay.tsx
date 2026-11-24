import { Clapperboard, FileArchive, FileText, Image as ImageIcon } from "lucide-react";
import { useWorkbench } from "../store/workbench";

export function DragOverlay() {
  const { dragActive } = useWorkbench();
  if (!dragActive) return null;
  return (
    <div className="drag-overlay" aria-hidden="true">
      <div className="drag-card">
        <div className="drag-orbit">
          <span className="drag-icon drag-icon-a"><ImageIcon size={22} /></span>
          <span className="drag-icon drag-icon-b"><FileText size={22} /></span>
          <span className="drag-icon drag-icon-c"><Clapperboard size={22} /></span>
          <span className="drag-pulse"><FileArchive size={13} /></span>
        </div>
        <h2>Drop your files here</h2>
        <p>Images, PDFs, videos and archives are welcome. Pick a tool and keep moving.</p>
        <div className="drag-types">
          <span>IMAGES</span><span>PDF</span><span>VIDEO</span><span>ARCHIVE</span>
        </div>
      </div>
    </div>
  );
}
