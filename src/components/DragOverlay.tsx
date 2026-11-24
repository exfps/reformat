import { FileText, Image as ImageIcon } from "lucide-react";
import { useWorkbench } from "../store/workbench";

export function DragOverlay() {
  const { dragActive } = useWorkbench();
  if (!dragActive) return null;
  return (
    <div className="drag-overlay" aria-hidden="true">
      <div className="drag-card">
        <div className="drag-orbit">
          <span className="drag-icon drag-icon-a"><ImageIcon size={24} /></span>
          <span className="drag-icon drag-icon-b"><FileText size={24} /></span>
          <span className="drag-pulse" />
        </div>
        <h2>Drop it. It stays local.</h2>
        <p>Images go to the converter, PDFs to the studio. Nothing leaves this Mac.</p>
        <div className="drag-types">
          <span>JPG</span><span>PNG</span><span>WEBP</span><span>PDF</span>
        </div>
      </div>
    </div>
  );
}
