import {
  Archive,
  Clapperboard,
  FileText,
  History,
  Images,
  type LucideIcon,
} from "lucide-react";

export const APP_VERSION = "1.1.0";

export type ToolId = "images" | "pdf" | "video" | "archives" | "activity";

export interface ToolMeta {
  id: ToolId;
  label: string;
  description: string;
  icon: LucideIcon;
  accent: string;
}

export const TOOLS: ToolMeta[] = [
  {
    id: "images",
    label: "Images",
    description: "Convert & resize",
    icon: Images,
    accent: "green",
  },
  {
    id: "pdf",
    label: "PDFs",
    description: "Merge & organize",
    icon: FileText,
    accent: "coral",
  },
  {
    id: "video",
    label: "Video to GIF",
    description: "Clips into GIFs",
    icon: Clapperboard,
    accent: "blue",
  },
  {
    id: "archives",
    label: "Archives",
    description: "Zip & unpack files",
    icon: Archive,
    accent: "amber",
  },
  {
    id: "activity",
    label: "Recent work",
    description: "Files you've made",
    icon: History,
    accent: "neutral",
  },
];

export const TOOL_BY_ID: Record<ToolId, ToolMeta> = Object.fromEntries(
  TOOLS.map((tool) => [tool.id, tool]),
) as Record<ToolId, ToolMeta>;
