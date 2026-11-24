import { AlertTriangle, Check, FolderOpen, Info, X } from "lucide-react";
import { useWorkbench } from "../store/workbench";
import type { Toast } from "../lib/types";

const ICONS = {
  success: Check,
  error: AlertTriangle,
  info: Info,
};

function ToastCard({ toast }: { toast: Toast }) {
  const { dismissToast, revealPath } = useWorkbench();
  const Icon = ICONS[toast.kind];
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <span className="toast-icon"><Icon size={16} strokeWidth={2} /></span>
      <div className="toast-copy">
        <div className="toast-title">{toast.title}</div>
        {toast.detail && <div className="toast-detail">{toast.detail}</div>}
        {toast.revealPath && (
          <button
            className="toast-action"
            onClick={() => {
              void revealPath(toast.revealPath!);
            }}
          >
            <FolderOpen size={13} />
            Show in Finder
          </button>
        )}
      </div>
      <button className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
        <X size={13} />
      </button>
    </div>
  );
}

export function Toaster() {
  const { toasts } = useWorkbench();
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((toast) => <ToastCard key={toast.id} toast={toast} />)}
    </div>
  );
}
