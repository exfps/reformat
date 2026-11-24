import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Clock3,
  FileText,
  Image as ImageIcon,
  Layers,
  Minimize2,
  Archive,
  Clapperboard,
  FileDown,
  History,
  Scissors,
  Trash2,
  XCircle,
} from "lucide-react";
import { useWorkbench } from "../store/workbench";
import { formatDate, humanBytes } from "../lib/format";
import type { ActivityEntry } from "../lib/types";
import { EmptyIcon } from "./ui";
import { ToolHeader } from "./ToolHeader";

const TOOL_META: Record<string, { label: string; icon: typeof ImageIcon }> = {
  images: { label: "Image converter", icon: ImageIcon },
  "pdf-merge": { label: "Merge · PDF Studio", icon: Layers },
  "pdf-split": { label: "Split · PDF Studio", icon: Scissors },
  "pdf-organize": { label: "Organize · PDF Studio", icon: Layers },
  "pdf-compress": { label: "Compress · PDF Studio", icon: Minimize2 },
  "images-to-pdf": { label: "Assemble · PDF Studio", icon: FileText },
  "pdf-export": { label: "Export · PDF Studio", icon: FileDown },
  "video-to-gif": { label: "Video to GIF", icon: Clapperboard },
  "archive-create": { label: "Archive", icon: Archive },
  "archive-extract": { label: "Archive", icon: Archive },
  "archive-test": { label: "Archive", icon: Archive },
};

function StatusMark({ status }: { status: ActivityEntry["status"] }) {
  if (status === "success") return <span className="activity-mark success"><Check size={14} /></span>;
  if (status === "partial") return <span className="activity-mark partial"><AlertTriangle size={14} /></span>;
  if (status === "cancelled") return <span className="activity-mark cancelled"><XCircle size={14} /></span>;
  return <span className="activity-mark failed"><AlertTriangle size={14} /></span>;
}

function Entry({ entry }: { entry: ActivityEntry }) {
  const { revealPath } = useWorkbench();
  const meta = TOOL_META[entry.tool] ?? { label: entry.tool, icon: FileText };
  const Icon = meta.icon;
  return (
    <div className="activity-entry">
      <div className="activity-icon"><Icon size={18} strokeWidth={1.6} /></div>
      <div className="activity-main">
        <div className="activity-top">
          <div>
            <strong>{entry.title}</strong>
            <span className="activity-tool">{meta.label}</span>
          </div>
          <span className="activity-time">{formatDate(entry.timestamp)}</span>
        </div>
        <div className="activity-detail-row">
          <StatusMark status={entry.status} />
          <span>{entry.detail}</span>
        </div>
        {entry.outputs.length > 0 && (
          <div className="activity-outputs">
            {entry.outputs.slice(0, 4).map((output) => (
              <button key={output.path} className="activity-output" onClick={() => void revealPath(output.path)} title={output.path}>
                <span className="activity-output-name">{output.name}</span>
                <span>{humanBytes(output.bytes)}</span>
                <ArrowUpRight size={12} />
              </button>
            ))}
            {entry.outputs.length > 4 && (
              <span className="activity-more">+ {entry.outputs.length - 4} more</span>
            )}
          </div>
        )}
        {entry.errors.length > 0 && (
          <div className="activity-errors">
            {entry.errors[0].name}: {entry.errors[0].message}
          </div>
        )}
      </div>
    </div>
  );
}

export function ActivityView() {
  const { activity, clearActivity } = useWorkbench();
  const outputs = activity.flatMap((entry) => entry.outputs);
  const written = outputs.reduce((sum, output) => sum + output.bytes, 0);
  const last = activity[0];

  return (
    <div className="view-scroll">
      <div className="page activity-page">
        <ToolHeader
          icon={History}
          title="Recent work"
          description="A friendly record of the files you've made."
          accent="neutral"
        >
          <div className="activity-stats">
            <div><span>Files made</span><strong>{outputs.length}</strong></div>
            <div><span>Written</span><strong>{written ? humanBytes(written) : "0 B"}</strong></div>
            <div><span>Last run</span><strong>{last ? formatDate(last.timestamp).split(",")[0] : "—"}</strong></div>
          </div>
        </ToolHeader>

        <div className="activity-toolbar">
          <div className="card-title">Recent work <span className="card-count">{activity.length}</span></div>
          <div className="activity-toolbar-right">
            <button className="text-button danger" onClick={clearActivity} disabled={!activity.length}>
              <Trash2 size={13} /> Clear history
            </button>
          </div>
        </div>

        {activity.length === 0 ? (
          <div className="card activity-empty">
            <EmptyIcon kind="activity" />
            <div>
              <h3>No history yet</h3>
              <p>Make a conversion, GIF or archive and it will be recorded here — locally, without any account.</p>
            </div>
            <div className="activity-empty-hint">
              <Clock3 size={14} />
              Your history never leaves this machine.
            </div>
          </div>
        ) : (
          <div className="card activity-list">
            {activity.map((entry) => <Entry key={entry.id} entry={entry} />)}
          </div>
        )}

        <div className="activity-footer">
          <span className="activity-footer-mark">R</span>
          <div>
            <strong>Reformat remembers the work, not your files.</strong>
            <span>History keeps file names and paths on this Mac only. It is never uploaded or synced.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
