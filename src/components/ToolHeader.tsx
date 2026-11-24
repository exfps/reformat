import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function ToolHeader({
  icon: Icon,
  title,
  description,
  accent = "neutral",
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  accent?: string;
  children?: ReactNode;
}) {
  return (
    <header className={`tool-header accent-${accent}`}>
      <span className="tool-header-icon"><Icon size={22} strokeWidth={1.7} /></span>
      <div className="tool-header-copy">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="tool-header-actions">{children}</div>}
    </header>
  );
}
