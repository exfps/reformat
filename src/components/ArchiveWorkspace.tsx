import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowRight,
  Check,
  ChevronDown,
  FileArchive,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  LockKeyhole,
  PackageOpen,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TestTube2,
  X,
} from "lucide-react";
import { useWorkbench } from "../store/workbench";
import {
  archiveInspect,
  createArchive,
  describeError,
  extractArchive,
  pickArchiveFile,
  pickArchiveFiles,
  pickArchiveFolders,
  pickFolder,
  planArchiveExtraction,
  testArchive,
} from "../lib/api";
import { basename, humanBytes, isArchivePath, uid } from "../lib/format";
import { usePersistentState } from "../hooks/usePersistentState";
import type {
  ArchiveEntryInfo,
  ArchiveInspection,
  ArchiveJobOutcome,
  ArchiveTestOutcome,
  ExtractPlan,
} from "../lib/types";
import { ToolHeader } from "./ToolHeader";
import { DestinationPicker, PrivacyNote, SectionLabel } from "./ui";

type ArchiveMode = "create" | "extract" | "inspect";
type ConflictPolicy = "rename" | "skip" | "replace";

interface FormatOption {
  id: string;
  label: string;
  ext: string;
  canPassword: boolean;
  singleFile: boolean;
  note: string;
}

const FORMATS: FormatOption[] = [
  { id: "zip", label: "ZIP", ext: "zip", canPassword: true, singleFile: false, note: "Most compatible" },
  { id: "7z", label: "7Z", ext: "7z", canPassword: true, singleFile: false, note: "Small and strong" },
  { id: "tar.gz", label: "TAR.GZ", ext: "tar.gz", canPassword: false, singleFile: false, note: "Great for code" },
  { id: "tar", label: "TAR", ext: "tar", canPassword: false, singleFile: false, note: "Simple bundle" },
  { id: "tar.bz2", label: "TAR.BZ2", ext: "tar.bz2", canPassword: false, singleFile: false, note: "Smaller TAR" },
  { id: "tar.xz", label: "TAR.XZ", ext: "tar.xz", canPassword: false, singleFile: false, note: "Smaller still" },
  { id: "gzip", label: "GZIP", ext: "gz", canPassword: false, singleFile: true, note: "One file" },
  { id: "bzip2", label: "BZIP2", ext: "bz2", canPassword: false, singleFile: true, note: "One file" },
  { id: "xz", label: "XZ", ext: "xz", canPassword: false, singleFile: true, note: "One file" },
];

const EXTRACT_FORMATS = ".zip, .7z, .tar, .tar.gz, .tar.bz2, .tar.xz, .gz, .bz2, .xz, .rar";

function formatOption(id: string): FormatOption {
  return FORMATS.find((format) => format.id === id) ?? FORMATS[0];
}

function sourceLabel(path: string): string {
  return basename(path.replace(/\/$/, ""));
}

function ConflictPicker({ value, onChange }: { value: ConflictPolicy; onChange: (value: ConflictPolicy) => void }) {
  return (
    <div className="segmented">
      {([
        ["rename", "Keep both"],
        ["skip", "Skip"],
        ["replace", "Replace"],
      ] as [ConflictPolicy, string][]).map(([id, label]) => (
        <button key={id} className={value === id ? "is-active" : ""} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function ModeTabs({ mode, onChange }: { mode: ArchiveMode; onChange: (mode: ArchiveMode) => void }) {
  const tabs = [
    { id: "create" as const, label: "Make an archive", icon: Archive },
    { id: "extract" as const, label: "Unpack", icon: PackageOpen },
    { id: "inspect" as const, label: "Look inside", icon: Search },
  ];
  return (
    <div className="archive-tabs" role="tablist" aria-label="Archive tools">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button key={tab.id} role="tab" aria-selected={mode === tab.id} className={mode === tab.id ? "is-active" : ""} onClick={() => onChange(tab.id)}>
            <Icon size={16} strokeWidth={1.8} />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ArchiveSummary({ inspection }: { inspection: ArchiveInspection }) {
  return (
    <div className="archive-summary">
      <div><span>Format</span><strong>{inspection.formatLabel}</strong></div>
      <div><span>Files</span><strong>{inspection.fileCount}</strong></div>
      <div><span>Unpacked</span><strong>{inspection.totalSize ? humanBytes(inspection.totalSize) : "—"}</strong></div>
      <div><span>Archive size</span><strong>{humanBytes(inspection.bytes)}</strong></div>
      <div><span>Savings</span><strong>{inspection.totalSize ? `${Math.max(0, Math.round((1 - inspection.bytes / inspection.totalSize) * 100))}%` : "—"}</strong></div>
      <div><span>Password</span><strong>{inspection.encrypted ? "Locked" : "None"}</strong></div>
    </div>
  );
}

function ArchiveSourceCard({
  inspection,
  path,
  onReplace,
  onClear,
  busy,
}: {
  inspection: ArchiveInspection | null;
  path: string | null;
  onReplace: () => void;
  onClear: () => void;
  busy?: boolean;
}) {
  return (
    <div className="card selected-archive">
      <div className="selected-archive-icon"><FileArchive size={22} /></div>
      <div className="selected-archive-main">
        <div className="card-title">{path ? basename(path) : "Choose an archive"}</div>
        <div className="card-sub">{path && inspection ? `${inspection.formatLabel} · ${humanBytes(inspection.bytes)}` : path ?? EXTRACT_FORMATS}</div>
      </div>
      <button className="small-button" onClick={onReplace} disabled={busy}>
        <RefreshCw size={13} /> {path ? "Replace" : "Choose"}
      </button>
      {path && <button className="icon-button" onClick={onClear} disabled={busy} aria-label="Remove archive"><X size={15} /></button>}
    </div>
  );
}

function EntryTable({
  entries,
  selected,
  allSelected,
  onToggle,
  selectable,
}: {
  entries: ArchiveEntryInfo[];
  selected?: Set<string>;
  allSelected?: boolean;
  onToggle?: (entry: ArchiveEntryInfo) => void;
  selectable?: boolean;
}) {
  const visible = entries.slice(0, 1000);
  return (
    <div className="entry-table" role="table" aria-label="Archive contents">
      <div className="entry-head" role="row">
        {selectable && <span className="entry-check" />}
        <span>Name</span>
        <span>Size</span>
      </div>
      {visible.map((entry) => {
        const depth = Math.max(0, entry.path.split("/").length - 1);
        const active = allSelected || selected?.has(entry.path);
        return (
          <div className={`entry-row ${entry.isDir ? "is-dir" : ""} ${!entry.safe ? "is-unsafe" : ""}`} role="row" key={entry.path}>
            {selectable && (
              <button
                className={`entry-check ${active ? "is-checked" : ""}`}
                onClick={() => onToggle?.(entry)}
                disabled={!entry.safe}
                aria-label={`${active ? "Deselect" : "Select"} ${entry.path}`}
              >
                {active && <Check size={11} />}
              </button>
            )}
            <span className="entry-name" style={{ paddingLeft: `${Math.min(depth, 8) * 14}px` }}>
              {entry.isDir ? <ChevronDown size={12} /> : <FilePlus2 size={12} />}
              <span title={entry.path}>{entry.path.replace(/\/+$/, "")}</span>
              {entry.nested && <span className="entry-badge">Nested archive</span>}
              {entry.encrypted && <LockKeyhole size={11} />}
              {!entry.safe && <span className="entry-badge danger">Unsafe path</span>}
            </span>
            <span className="entry-size">{entry.isDir ? "Folder" : humanBytes(entry.size)}</span>
          </div>
        );
      })}
      {entries.length > visible.length && <div className="entry-more">Showing the first {visible.length} entries. All files can still be extracted.</div>}
    </div>
  );
}

function BusyBar({ job, onCancel }: { job: { completed: number; total: number; status: string } | null; onCancel: () => void }) {
  if (!job) return null;
  const percent = job.total ? Math.min(100, Math.round((job.completed / job.total) * 100)) : 0;
  return (
    <div className="busy-footer">
      <div className="busy-top"><span className="busy-label"><LoaderCircle size={14} className="spin" /> Working on it</span><span className="busy-count">{job.completed} / {job.total}</span></div>
      <div className="progress-track"><span style={{ width: `${Math.max(3, percent)}%` }} /></div>
      <div className="busy-bottom"><span>{job.status === "cancelling" ? "Stopping safely…" : "Working safely."}</span><button className="text-button danger" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

export function ArchiveWorkspace() {
  const {
    pushToast,
    recordActivity,
    activeJobs,
    startExternalJob,
    finishExternalJob,
    cancelActiveJob,
    revealPath,
    pendingDrop,
    clearPendingDrop,
  } = useWorkbench();

  const [mode, setMode] = useState<ArchiveMode>("create");
  const [sources, setSources] = useState<string[]>([]);
  const [createFormat, setCreateFormat] = usePersistentState("reformat.archive-format.v2", "zip");
  const [level, setLevel] = usePersistentState("reformat.archive-level.v2", "balanced");
  const [createPassword, setCreatePassword] = useState("");
  const [archiveBase, setArchiveBase] = usePersistentState("reformat.archive-name.v2", "my-files");
  const [outputDir, setOutputDir] = usePersistentState<string | null>("reformat.archive-output.v2", null);
  const [createdOutcome, setCreatedOutcome] = useState<ArchiveJobOutcome | null>(null);

  const [archivePath, setArchivePath] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ArchiveInspection | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [extractPassword, setExtractPassword] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [destination, setDestination] = usePersistentState<string | null>("reformat.archive-extract-to.v2", null);
  const [folderMode, setFolderMode] = usePersistentState<"smart" | "always" | "never">("reformat.archive-folder-mode.v2", "smart");
  const [folderName, setFolderName] = useState("");
  const [conflict, setConflict] = usePersistentState<ConflictPolicy>("reformat.archive-conflict.v2", "rename");
  const [maxTotalMb, setMaxTotalMb] = usePersistentState("reformat.archive-max-mb.v2", 4096);
  const [maxFiles, setMaxFiles] = usePersistentState("reformat.archive-max-files.v2", 100000);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allSelected, setAllSelected] = useState(true);
  const [plan, setPlan] = useState<ExtractPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [testResult, setTestResult] = useState<ArchiveTestOutcome | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [archiveOutcome, setArchiveOutcome] = useState<ArchiveJobOutcome | null>(null);
  const planTimer = useRef<number | null>(null);
  const job = activeJobs.find((entry) => entry.id === jobId) ?? null;
  const busy = Boolean(job);
  const format = formatOption(createFormat);
  // The backend treats an empty `selected` list as "everything". A single
  // impossible empty path distinguishes an explicit "none" selection from
  // "all" without changing the IPC contract.
  const selectedPaths = allSelected ? [] : selected.size ? Array.from(selected) : [""];

  const addSources = useCallback((paths: string[]) => {
    setSources((current) => {
      const seen = new Set(current);
      return [...current, ...paths.filter((path) => !seen.has(path))];
    });
    setCreatedOutcome(null);
  }, []);

  const chooseFiles = async () => {
    try {
      const paths = await pickArchiveFiles();
      addSources(paths);
    } catch (reason) {
      pushToast({ kind: "error", title: "Couldn't open the picker", detail: describeError(reason) });
    }
  };

  const chooseFolders = async () => {
    try {
      const paths = await pickArchiveFolders();
      addSources(paths);
    } catch (reason) {
      pushToast({ kind: "error", title: "Couldn't open the folder picker", detail: describeError(reason) });
    }
  };

  const inspectPath = useCallback(async (path: string, password: string) => {
    setInspectLoading(true);
    setInspectError(null);
    setTestResult(null);
    setInspection(null);
    try {
      const result = await archiveInspect(path, password || null);
      setInspection(result);
      setAllSelected(true);
      setSelected(new Set(result.entries.map((entry) => entry.path)));
      setNeedsPassword(false);
      setExtractPassword(password);
    } catch (reason) {
      const message = describeError(reason);
      setInspectError(message);
      setNeedsPassword(/password|encrypted/i.test(message) && !/not supported|isn.t supported/i.test(message));
    } finally {
      setInspectLoading(false);
    }
  }, []);

  const loadArchive = useCallback(async (path: string) => {
    setArchivePath(path);
    setArchiveOutcome(null);
    await inspectPath(path, "");
  }, [inspectPath]);

  const chooseArchive = async () => {
    try {
      const path = await pickArchiveFile();
      if (path) void loadArchive(path);
    } catch (reason) {
      pushToast({ kind: "error", title: "Couldn't open the archive picker", detail: describeError(reason) });
    }
  };

  const clearArchive = () => {
    setArchivePath(null);
    setInspection(null);
    setInspectError(null);
    setNeedsPassword(false);
    setExtractPassword("");
    setPlan(null);
    setTestResult(null);
    setArchiveOutcome(null);
  };

  // Global drop routing from the shell.
  useEffect(() => {
    if (!pendingDrop || pendingDrop.target !== "archives") return;
    clearPendingDrop();
    if (mode === "create") {
      addSources(pendingDrop.paths);
      return;
    }
    const archive = pendingDrop.paths.find(isArchivePath);
    if (archive) void loadArchive(archive);
    else if (pendingDrop.paths.length) pushToast({ kind: "error", title: "That isn't an archive", detail: "Choose a ZIP, 7Z, TAR, GZIP, BZIP2, XZ, or RAR file." });
  }, [addSources, clearPendingDrop, loadArchive, mode, pendingDrop, pushToast]);

  useEffect(() => {
    const onPick = (event: Event) => {
      if ((event as CustomEvent).detail === "archives") {
        if (mode === "create") void chooseFiles();
        else void chooseArchive();
      }
    };
    window.addEventListener("reformat:pick", onPick);
    return () => window.removeEventListener("reformat:pick", onPick);
  }, [mode]);

  // Review extraction conflicts whenever the destination or selection changes.
  useEffect(() => {
    if (mode !== "extract" || !inspection || !archivePath) {
      setPlan(null);
      return;
    }
    if (planTimer.current) window.clearTimeout(planTimer.current);
    setPlanError(null);
    setPlanLoading(true);
    planTimer.current = window.setTimeout(() => {
      planArchiveExtraction({
        input: archivePath,
        destination,
        password: extractPassword || null,
        selected: selectedPaths,
        folderMode,
        folderName: folderName.trim() || null,
        maxTotalMb: Math.max(1, maxTotalMb),
        maxFiles: Math.max(1, maxFiles),
      })
        .then((result) => setPlan(result))
        .catch((reason) => {
          setPlan(null);
          setPlanError(describeError(reason));
        })
        .finally(() => setPlanLoading(false));
    }, 320);
    return () => {
      if (planTimer.current) window.clearTimeout(planTimer.current);
    };
  }, [allSelected, archivePath, destination, extractPassword, folderMode, folderName, maxFiles, maxTotalMb, mode, planTimer, selected, inspection]);

  const create = async () => {
    if (!sources.length) return;
    const id = uid();
    setJobId(id);
    setCreatedOutcome(null);
    startExternalJob({ id, tool: "archive-create", title: "Making an archive", total: sources.length, view: "archives" });
    try {
      const outcome = await createArchive({
        jobId: id,
        sources,
        outputDir,
        fileName: archiveBase,
        format: createFormat,
        level,
        password: format.canPassword && createPassword ? createPassword : null,
      });
      finishExternalJob(id);
      setJobId(null);
      setCreatedOutcome(outcome);
      if (outcome.cancelled) {
        recordActivity({ tool: "archive-create", title: "Make an archive", detail: "Stopped before the archive was written.", status: "cancelled", outputs: [], errors: [] });
        pushToast({ kind: "info", title: "Archive cancelled", detail: "No archive was written." });
        return;
      }
      const output = outcome.output;
      if (output) {
        recordActivity({ tool: "archive-create", title: "Make an archive", detail: `${format.label} · ${humanBytes(output.bytes)}`, status: "success", outputs: [output], errors: [] });
        pushToast({ kind: "success", title: "Archive ready", detail: `${output.name} · ${humanBytes(output.bytes)}`, revealPath: output.path });
      }
    } catch (reason) {
      finishExternalJob(id);
      setJobId(null);
      recordActivity({ tool: "archive-create", title: "Make an archive", detail: describeError(reason), status: "failed", outputs: [], errors: [] });
      pushToast({ kind: "error", title: "Couldn't make the archive", detail: describeError(reason) });
    }
  };

  const extract = async () => {
    if (!archivePath || !inspection || !plan) return;
    const id = uid();
    setJobId(id);
    setArchiveOutcome(null);
    startExternalJob({ id, tool: "archive-extract", title: "Unpacking archive", total: inspection.fileCount, view: "archives" });
    try {
      const outcome = await extractArchive({
        jobId: id,
        input: archivePath,
        destination,
        password: extractPassword || null,
        conflict,
        selected: selectedPaths,
        folderMode,
        folderName: folderName.trim() || null,
        maxTotalMb: Math.max(1, maxTotalMb),
        maxFiles: Math.max(1, maxFiles),
      });
      finishExternalJob(id);
      setJobId(null);
      setArchiveOutcome(outcome);
      if (outcome.cancelled) {
        recordActivity({ tool: "archive-extract", title: "Unpack archive", detail: "Stopped before files were written.", status: "cancelled", outputs: [], errors: [] });
        pushToast({ kind: "info", title: "Extraction cancelled", detail: "The archive is untouched." });
        return;
      }
      if (outcome.destination) {
        recordActivity({
          tool: "archive-extract",
          title: "Unpack archive",
          detail: `${outcome.files} files · ${outcome.skipped ? `${outcome.skipped} skipped` : "all done"}`,
          status: outcome.skipped ? "partial" : "success",
          outputs: [{
            path: outcome.destination,
            name: basename(outcome.destination),
            sourcePath: archivePath,
            bytes: plan.totalSize,
          }],
          errors: [],
        });
        pushToast({ kind: "success", title: "Archive unpacked", detail: `${outcome.files} files · ${basename(outcome.destination)}`, revealPath: outcome.destination });
      }
      if (outcome.warnings.length) {
        pushToast({ kind: "info", title: "Some entries were skipped", detail: outcome.warnings[0] });
      }
    } catch (reason) {
      finishExternalJob(id);
      setJobId(null);
      recordActivity({ tool: "archive-extract", title: "Unpack archive", detail: describeError(reason), status: "failed", outputs: [], errors: [] });
      pushToast({ kind: "error", title: "Couldn't unpack this archive", detail: describeError(reason) });
    }
  };

  const runTest = async () => {
    if (!archivePath) return;
    const id = uid();
    setJobId(id);
    setTestResult(null);
    startExternalJob({ id, tool: "archive-test", title: "Checking archive", total: inspection?.fileCount ?? 1, view: "archives" });
    try {
      const result = await testArchive(archivePath, extractPassword || null, id);
      finishExternalJob(id);
      setJobId(null);
      setTestResult(result);
      recordActivity({
        tool: "archive-test",
        title: "Check archive",
        detail: result.ok ? `Verified ${result.checked} files` : result.message,
        status: result.ok ? "success" : "failed",
        outputs: [],
        errors: [],
      });
      pushToast({ kind: result.ok ? "success" : "error", title: result.ok ? "Archive looks healthy" : "The archive has a problem", detail: result.message });
    } catch (reason) {
      finishExternalJob(id);
      setJobId(null);
      pushToast({ kind: "error", title: "Couldn't check the archive", detail: describeError(reason) });
    }
  };

  const toggleEntry = (entry: ArchiveEntryInfo) => {
    setAllSelected(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  };

  const chooseExtractDestination = async () => {
    try {
      const folder = await pickFolder("Choose where to unpack the archive");
      if (folder) setDestination(folder);
    } catch (reason) {
      pushToast({ kind: "error", title: "Couldn't choose that folder", detail: describeError(reason) });
    }
  };

  const chooseCreateDestination = async () => {
    try {
      const folder = await pickFolder("Choose where to save the archive");
      if (folder) setOutputDir(folder);
    } catch (reason) {
      pushToast({ kind: "error", title: "Couldn't choose that folder", detail: describeError(reason) });
    }
  };

  return (
    <div className="view-scroll fixed-page">
      <div className="page tool-page archive-page">
        <ToolHeader
          icon={Archive}
          title="Create and unpack archives"
          description="Bundle files, see what's inside, and extract them safely."
          accent="amber"
        />
        <ModeTabs mode={mode} onChange={setMode} />

        {mode === "create" ? (
          <div className="tool-layout">
            <div className="tool-primary">
              <div className="card source-card">
                <div className="card-head">
                  <div>
                    <div className="card-title">What goes in?</div>
                    <div className="card-sub">Files and folders keep their shape inside the archive.</div>
                  </div>
                  <div className="card-actions">
                    <button className="small-button" onClick={() => void chooseFiles()}><FilePlus2 size={13} /> Add files</button>
                    <button className="small-button" onClick={() => void chooseFolders()}><FolderPlus size={13} /> Add folder</button>
                  </div>
                </div>
                {sources.length === 0 ? (
                  <div className="archive-empty">
                    <div className="archive-empty-art"><Archive size={26} /></div>
                    <strong>Add something to bundle</strong>
                    <span>Choose files or a folder, or drop them anywhere in this window.</span>
                    <div className="archive-empty-actions">
                      <button className="small-button" onClick={() => void chooseFiles()}>Choose files</button>
                      <button className="small-button" onClick={() => void chooseFolders()}>Choose a folder</button>
                    </div>
                  </div>
                ) : (
                  <div className="source-list">
                    {sources.map((source) => (
                      <div className="source-row" key={source}>
                        <span className="source-icon"><FolderOpen size={15} /></span>
                        <span className="source-name" title={source}>{sourceLabel(source)}</span>
                        <span className="source-path" title={source}>{source}</span>
                        <button className="icon-button" onClick={() => setSources((current) => current.filter((item) => item !== source))} aria-label={`Remove ${sourceLabel(source)}`}><X size={14} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="source-foot"><span>{sources.length} {sources.length === 1 ? "item" : "items"} selected</span><button className="text-button" onClick={() => setSources([])} disabled={!sources.length}>Clear all</button></div>
              </div>

              <div className="card archive-format-card">
                <div className="card-head">
                  <div>
                    <div className="card-title">Archive format</div>
                    <div className="card-sub">Pick what the person on the other end will need.</div>
                  </div>
                </div>
                <div className="format-picker">
                  {FORMATS.map((option) => (
                    <button key={option.id} className={`format-option ${createFormat === option.id ? "is-active" : ""}`} onClick={() => setCreateFormat(option.id)}>
                      <strong>{option.label}</strong>
                      <span>{option.note}</span>
                      {createFormat === option.id && <Check size={12} />}
                    </button>
                  ))}
                </div>
                <div className="format-notes">
                  <span><ShieldCheck size={13} /> Password protection is available for ZIP and 7Z.</span>
                  <span>RAR creation isn't supported.</span>
                </div>
                <div className="archive-options">
                  {createFormat === "7z" ? (
                    <div className="info-box">
                      <span className="info-box-icon"><Sparkles size={15} /></span>
                      <p>7Z uses its own LZMA2 compression. Reformat picks a balanced setting automatically.</p>
                    </div>
                  ) : (
                    <div>
                      <SectionLabel>Compression</SectionLabel>
                      <div className="segmented">
                        {([["fast", "Fast"], ["balanced", "Balanced"], ["maximum", "Maximum"]] as [string, string][]).map(([id, label]) => (
                          <button key={id} className={level === id ? "is-active" : ""} onClick={() => setLevel(id)}>{label}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {format.canPassword && (
                    <label className="plain-field password-field">
                      <span className="field-label">Password <span className="field-hint">optional</span></span>
                      <input className="text-input" type="password" value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} placeholder="Leave blank for an open archive" autoComplete="new-password" />
                      <span className="field-note">Never stored. You'll need it to open the archive later.</span>
                    </label>
                  )}
                </div>
                {format.singleFile && sources.length > 1 && (
                  <div className="warning-box">GZIP, BZIP2 and XZ compress one file at a time. Choose ZIP or TAR to bundle multiple items.</div>
                )}
              </div>
              {createdOutcome?.output && (
                <div className="card created-card">
                  <span className="created-icon"><Check size={16} /></span>
                  <div><strong>{createdOutcome.output.name}</strong><span>{humanBytes(createdOutcome.output.bytes)} · ready to share</span></div>
                  <button className="small-button" onClick={() => void revealPath(createdOutcome.output!.path)}>Show in Finder</button>
                </div>
              )}
              {createdOutcome?.warnings.length ? <div className="warning-box">{createdOutcome.warnings.slice(0, 3).join(" ")}{createdOutcome.warnings.length > 3 ? ` (+${createdOutcome.warnings.length - 3} more)` : ""}</div> : null}
            </div>

            <aside className="tool-aside">
              <div className="card inspector-card">
                <div className="inspector-head"><div><div className="eyebrow">OUTPUT</div><h2>Ready to bundle.</h2></div></div>
                <div className="inspector-body">
                  <DestinationPicker value={outputDir} onChoose={() => void chooseCreateDestination()} onReset={() => setOutputDir(null)} label="Save archive to" />
                  <div className="template-block">
                    <SectionLabel>Archive name</SectionLabel>
                    <div className="input-with-suffix"><input className="text-input" value={archiveBase} onChange={(event) => setArchiveBase(event.target.value)} spellCheck={false} /><span className="input-suffix">.{format.ext}</span></div>
                  </div>
                  <div className="archive-stat-list">
                    <div><span>Items</span><strong>{sources.length}</strong></div>
                    <div><span>Format</span><strong>{format.label}</strong></div>
                    <div><span>Compression</span><strong>{createFormat === "7z" ? "Balanced" : level.charAt(0).toUpperCase() + level.slice(1)}</strong></div>
                  </div>
                  <div className="info-box"><span className="info-box-icon"><ShieldCheck size={15} /></span><p>Archives are created in a temporary file and only appear when complete. Your original files are never changed.</p></div>
                  <PrivacyNote />
                </div>
                <div className="inspector-foot">
                  <BusyBar job={job} onCancel={() => void cancelActiveJob(jobId!)} />
                  {!job && (
                    <button className="primary-button" disabled={!sources.length || (format.singleFile && sources.length > 1)} onClick={() => void create()}>
                      <span>Create {format.label} archive</span><span className="primary-arrow"><ArrowRight size={16} /></span>
                    </button>
                  )}
                </div>
              </div>
            </aside>
          </div>
        ) : (
          <div className="tool-layout">
            <div className="tool-primary">
              <ArchiveSourceCard inspection={inspection} path={archivePath} onReplace={() => void chooseArchive()} onClear={clearArchive} busy={busy} />
              {inspectLoading && <div className="card archive-loading"><LoaderCircle size={20} className="spin" /><span>Reading the archive…</span></div>}
              {inspectError && (
                <div className="card upload-error">
                  <div className="upload-error-icon"><ShieldAlert size={22} /></div>
                  <div><strong>We couldn't read this archive</strong><span>{inspectError}</span></div>
                  <button className="small-button" onClick={() => void chooseArchive()}>Choose another</button>
                </div>
              )}
              {needsPassword && (
                <div className="card password-card">
                  <div className="card-head"><div><div className="card-title">This archive is locked</div><div className="card-sub">Enter its password to look inside. Reformat doesn't store it.</div></div></div>
                  <div className="password-row">
                    <input className="text-input" type="password" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} placeholder="Archive password" autoComplete="off" />
                    <button className="small-button" onClick={() => void inspectPath(archivePath!, passwordDraft)}>Unlock</button>
                  </div>
                </div>
              )}
              {inspection && (
                <>
                  <div className="card archive-info-card">
                    <div className="card-head"><div><div className="card-title">{inspection.name}</div><div className="card-sub">{inspection.formatLabel} archive · {inspection.entries.length} listed entries</div></div><span className="archive-health"><ShieldCheck size={13} /> Readable</span></div>
                    <ArchiveSummary inspection={inspection} />
                    {inspection.warnings.length > 0 && <div className="archive-warnings">{inspection.warnings.slice(0, 3).map((warning) => <span key={warning}>{warning}</span>)}</div>}
                    {inspection.nestedCount > 0 && <div className="archive-nested-note"><Sparkles size={14} /> {inspection.nestedCount} {inspection.nestedCount === 1 ? "entry looks like" : "entries look like"} another archive. You can unpack this one, then open the nested file separately.</div>}
                    <div className="archive-test-row">
                      <button className="small-button" onClick={() => void runTest()} disabled={busy}><TestTube2 size={13} /> Test integrity</button>
                      {testResult && <span className={`test-result ${testResult.ok ? "is-good" : "is-bad"}`}>{testResult.ok ? <Check size={13} /> : <ShieldAlert size={13} />}{testResult.message}</span>}
                    </div>
                  </div>

                  <div className="card entry-card">
                    <div className="card-head">
                      <div><div className="card-title">{mode === "extract" ? "Choose what to unpack" : "Contents"}</div><div className="card-sub">{mode === "extract" ? "Leave everything checked to unpack the whole archive." : "Folders are shown as part of their path."}</div></div>
                      {mode === "extract" && <div className="card-actions"><button className="text-button" onClick={() => { setAllSelected(true); setSelected(new Set(inspection.entries.map((entry) => entry.path))); }}>Select all</button><button className="text-button" onClick={() => { setAllSelected(false); setSelected(new Set()); }}>Clear</button></div>}
                    </div>
                    <EntryTable entries={inspection.entries} selectable={mode === "extract"} selected={selected} allSelected={allSelected} onToggle={toggleEntry} />
                    {inspection.truncated && <div className="entry-more">This list is shortened for speed. “Select all” still means the whole archive.</div>}
                  </div>
                  {archiveOutcome?.destination && (
                    <div className="card created-card">
                      <span className="created-icon"><Check size={16} /></span>
                      <div><strong>{archiveOutcome.files} files unpacked</strong><span>{basename(archiveOutcome.destination)}{archiveOutcome.skipped ? ` · ${archiveOutcome.skipped} skipped` : ""}</span></div>
                      <button className="small-button" onClick={() => void revealPath(archiveOutcome.destination!)}>Show in Finder</button>
                    </div>
                  )}
                  {archiveOutcome?.warnings.length ? <div className="warning-box">{archiveOutcome.warnings.slice(0, 3).join(" ")}{archiveOutcome.warnings.length > 3 ? ` (+${archiveOutcome.warnings.length - 3} more)` : ""}</div> : null}
                </>
              )}
            </div>

            <aside className="tool-aside">
              {mode === "inspect" ? (
                <div className="card inspector-card">
                  <div className="inspector-head"><div><div className="eyebrow">LOOK INSIDE</div><h2>What's in there?</h2></div></div>
                  <div className="inspector-body">
                    {inspection ? (
                      <>
                        <div className="archive-summary archive-summary-stacked">
                          <div><span>Format</span><strong>{inspection.formatLabel}</strong></div>
                          <div><span>Files</span><strong>{inspection.fileCount}</strong></div>
                          <div><span>Unpacked</span><strong>{inspection.totalSize ? humanBytes(inspection.totalSize) : "—"}</strong></div>
                          <div><span>Password</span><strong>{inspection.encrypted ? "Locked" : "None"}</strong></div>
                        </div>
                        <div className="info-box"><span className="info-box-icon"><ShieldCheck size={15} /></span><p>This is a read-only look at the archive. Nothing is extracted yet.</p></div>
                        {testResult && <span className={`test-result ${testResult.ok ? "is-good" : "is-bad"}`}>{testResult.ok ? <Check size={13} /> : <ShieldAlert size={13} />}{testResult.message}</span>}
                      </>
                    ) : (
                      <p className="field-note">Choose an archive on the left to see its contents and test its integrity.</p>
                    )}
                    <PrivacyNote />
                  </div>
                  <div className="inspector-foot">
                    <button className="primary-button" disabled={!inspection} onClick={() => setMode("extract")}>
                      <span>Unpack this archive</span><span className="primary-arrow"><ArrowRight size={16} /></span>
                    </button>
                    <button className="secondary-button" onClick={() => void runTest()} disabled={!archivePath || busy || Boolean(inspection?.encrypted && !extractPassword)}><TestTube2 size={14} /> Test integrity</button>
                  </div>
                </div>
              ) : (
              <div className="card inspector-card">
                <div className="inspector-head"><div><div className="eyebrow">UNPACK</div><h2>Make room.</h2></div></div>
                <div className="inspector-body">
                  <DestinationPicker value={destination} onChoose={() => void chooseExtractDestination()} onReset={() => setDestination(null)} label="Unpack to" />
                  {inspection?.encrypted && (
                    <label className="plain-field">
                      <span className="field-label">Archive password</span>
                      <input className="text-input" type="password" value={extractPassword} onChange={(event) => setExtractPassword(event.target.value)} placeholder="Required to unpack" autoComplete="off" />
                      <span className="field-note">Used once in memory and never saved.</span>
                    </label>
                  )}
                  {plan && (
                    <div className={`plan-card ${plan.conflictCount ? "has-conflicts" : ""}`}>
                      <div className="plan-head"><span>Extract plan</span><strong>{plan.fileCount} files</strong></div>
                      <div className="plan-path" title={plan.root}>{plan.root}</div>
                      {plan.conflictCount > 0 ? (
                        <div className="plan-conflicts">
                          <strong>{plan.conflictCount} {plan.conflictCount === 1 ? "item already exists" : "items already exist"}</strong>
                          {plan.conflicts.slice(0, 3).map((conflictItem) => <span key={conflictItem.path}>{conflictItem.path} <em>{conflictItem.kind}</em></span>)}
                        </div>
                      ) : <span className="plan-clear"><Check size={12} /> No collisions — a clean landing.</span>}
                      {planLoading && <span className="field-note">Checking the destination…</span>}
                    </div>
                  )}
                  {planError && <div className="warning-box">{planError}</div>}
                  <div className="settings-block">
                    <SectionLabel>If something exists</SectionLabel>
                    <ConflictPicker value={conflict} onChange={setConflict} />
                    {conflict === "replace" && <span className="field-note warning-text">Replace is the only option that overwrites existing files. Reformat only does that when you choose it.</span>}
                  </div>
                  <div className="settings-block">
                    <SectionLabel>Folder</SectionLabel>
                    <div className="segmented">
                      <button className={folderMode === "smart" ? "is-active" : ""} onClick={() => setFolderMode("smart")}>Smart</button>
                      <button className={folderMode === "always" ? "is-active" : ""} onClick={() => setFolderMode("always")}>New folder</button>
                      <button className={folderMode === "never" ? "is-active" : ""} onClick={() => setFolderMode("never")}>Here</button>
                    </div>
                    <span className="field-note">Smart creates a folder only when the archive doesn't already have one tidy root.</span>
                    {folderMode !== "never" && <input className="text-input" placeholder={archivePath ? basename(archivePath).replace(/\.[^.]+$/, "") : "Archive folder name"} value={folderName} onChange={(event) => setFolderName(event.target.value)} />}
                  </div>
                  <details className="advanced-settings">
                    <summary>Safety limits</summary>
                    <div className="advanced-fields">
                      <label className="number-field">
                        <span>Max unpacked size</span>
                        <div><input type="number" min={1} max={32768} value={maxTotalMb} onChange={(event) => setMaxTotalMb(Math.max(1, Number(event.target.value) || 1))} /><span className="unit">MB</span></div>
                      </label>
                      <label className="number-field">
                        <span>Max files</span>
                        <div><input type="number" min={1} max={1000000} value={maxFiles} onChange={(event) => setMaxFiles(Math.max(1, Number(event.target.value) || 1))} /><span className="unit">files</span></div>
                      </label>
                    </div>
                    <span className="field-note">Archives above these limits are stopped before writing. Raise them only for files you trust.</span>
                  </details>
                  <div className="info-box"><span className="info-box-icon"><ShieldCheck size={15} /></span><p>Unsafe paths, links and suspiciously large archives are blocked before anything is written.</p></div>
                  <PrivacyNote />
                </div>
                <div className="inspector-foot">
                  <BusyBar job={job} onCancel={() => void cancelActiveJob(jobId!)} />
                  {!job && (
                    <>
                      <button className="primary-button" disabled={!inspection || !plan || planLoading || plan.fileCount === 0 || Boolean(inspection.encrypted && !extractPassword)} onClick={() => void extract()}>
                        <span>{inspection?.encrypted && !extractPassword ? "Enter the password above" : `Unpack ${plan?.fileCount ?? 0} files`}</span><span className="primary-arrow"><ArrowRight size={16} /></span>
                      </button>
                      <button className="secondary-button" onClick={() => void runTest()} disabled={!archivePath || busy || Boolean(inspection?.encrypted && !extractPassword)}><TestTube2 size={14} /> Test archive</button>
                    </>
                  )}
                </div>
              </div>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

