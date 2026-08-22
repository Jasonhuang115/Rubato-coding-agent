import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import type {
  CoverageManifest,
  SubagentFailureKind,
  SubagentTaskStatus,
  TaskArtifactPaths,
  TaskDetail,
  TaskResult,
} from "../../shared/core-types.js";
import { redactText, redactValue } from "./redaction.js";
import { coverageSummary, emptyCoverageManifest } from "./coverage.js";
import { WorktreeManager } from "../worktrees/worktree-manager.js";
import { projectMemoryId } from "../../shared/project-id.js";
import { getRubatoHome } from "../../shared/rubato-home.js";

export const PLAN_START_MARKER = "<!-- rubato-plan:start -->";
export const PLAN_END_MARKER = "<!-- rubato-plan:end -->";
export const PLAN_PLACEHOLDER_ITEM =
  "- [ ] _(fill this checklist before writing the report)_";

export interface TaskControlFields {
  timeoutMs?: number;
  accumulatedRuntimeMs?: number;
  attempt?: number;
  status?: SubagentTaskStatus;
  startedAt?: number;
  endedAt?: number;
  currentActivity?: string;
  currentTool?: string;
  failureKind?: SubagentFailureKind;
  model?: string;
  mode?: string;
  coverage?: string;
  isolation?: string;
}

export interface PersistedTaskSpec extends TaskControlFields {
  taskId: string;
  agentId: string;
  rootSessionId?: string;
  description: string;
  prompt: string;
  subagentType: string;
  scope?: string[];
  workspace?: TaskDetail["workspace"];
  createdAt: number;
}

export interface ConversationTaskRecord {
  spec: PersistedTaskSpec;
  paths: TaskArtifactPaths;
  result?: TaskResult;
  notified: boolean;
  pinned: boolean;
}

export class ArtifactStore {
  readonly projectDir: string;
  readonly runDir: string;
  readonly tracePath: string;
  private readonly reportLocks = new Set<string>();
  private readonly planReminded = new Set<string>();
  private readonly pendingPlanReminders = new Map<string, string>();

  constructor(
    projectDir: string,
    rootSessionId: string,
    rubatoHome = getRubatoHome(),
    projectHash = projectMemoryId(projectDir),
  ) {
    this.projectDir = path.join(
      rubatoHome,
      "projects",
      projectHash,
    );
    this.runDir = path.join(this.projectDir, "runs", safeSegment(rootSessionId));
    this.tracePath = path.join(this.runDir, "trace.jsonl");
    fs.mkdirSync(this.runDir, { recursive: true });
  }

  paths(taskId: string): TaskArtifactPaths {
    const taskDir = path.join(this.runDir, "tasks", safeSegment(taskId));
    return pathsForTaskDir(taskDir);
  }

  initializeTask(task: TaskDetail, recovery?: TaskControlFields): void {
    fs.mkdirSync(task.artifacts.taskDir, { recursive: true });
    if (!fs.existsSync(task.artifacts.report)) {
      fs.writeFileSync(
        task.artifacts.report,
        redactText(buildReportTemplate(task)),
        "utf8",
      );
    }
    writeJsonAtomic(task.artifacts.task, redactValue({
      taskId: task.taskId,
      agentId: task.agentId,
      rootSessionId: task.rootSessionId,
      description: task.description,
      prompt: task.prompt,
      subagentType: task.subagentType,
      scope: task.scope,
      workspace: task.workspace,
      createdAt: task.createdAt,
      timeoutMs: recovery?.timeoutMs,
      accumulatedRuntimeMs: recovery?.accumulatedRuntimeMs ?? 0,
      attempt: recovery?.attempt ?? 0,
      status: recovery?.status ?? task.status,
      model: recovery?.model,
      mode: recovery?.mode,
      coverage: recovery?.coverage,
      isolation: recovery?.isolation,
    }));
  }

  updateTask(task: TaskDetail, control?: TaskControlFields): void {
    let existing: Record<string, unknown> = {};
    try {
      if (fs.existsSync(task.artifacts.task)) {
        existing = JSON.parse(fs.readFileSync(task.artifacts.task, "utf8")) as Record<string, unknown>;
      }
    } catch {
      // Rebuild the recoverable task specification from the known fields below.
    }
    writeJsonAtomic(task.artifacts.task, redactValue({
      ...existing,
      taskId: task.taskId,
      agentId: task.agentId,
      rootSessionId: task.rootSessionId,
      description: task.description,
      prompt: task.prompt,
      subagentType: task.subagentType,
      scope: task.scope,
      workspace: task.workspace,
      createdAt: task.createdAt,
      timeoutMs: control?.timeoutMs ?? existing.timeoutMs,
      accumulatedRuntimeMs: control?.accumulatedRuntimeMs ?? existing.accumulatedRuntimeMs,
      attempt: control?.attempt ?? existing.attempt,
      status: control?.status ?? task.status ?? existing.status,
      startedAt: control?.startedAt ?? task.startedAt ?? existing.startedAt,
      endedAt: control?.endedAt ?? task.endedAt ?? existing.endedAt,
      currentActivity: control?.currentActivity ?? task.currentActivity ?? existing.currentActivity,
      currentTool: control && "currentTool" in control
        ? control.currentTool
        : (task.currentTool ?? existing.currentTool),
      failureKind: control && "failureKind" in control
        ? control.failureKind
        : (task.failureKind ?? existing.failureKind),
      model: control?.model ?? existing.model,
      mode: control?.mode ?? existing.mode,
      coverage: control?.coverage ?? existing.coverage,
      isolation: control?.isolation ?? existing.isolation,
    }));
  }

  finalizeTask(
    task: TaskDetail,
    result: TaskResult,
    coverage: CoverageManifest = emptyCoverageManifest(false),
  ): void {
    fs.mkdirSync(task.artifacts.taskDir, { recursive: true });
    if (!fs.existsSync(task.artifacts.report)) fs.writeFileSync(task.artifacts.report, "", "utf8");
    writeJsonAtomic(task.artifacts.coverage, redactValue(coverage));
    writeJsonAtomic(task.artifacts.result, redactValue({
      ...result,
      coveragePath: task.artifacts.coverage,
      coverage: result.coverage ?? coverageSummary(coverage),
    }));
    this.deriveTranscript(task.taskId, task.artifacts.transcript);
  }

  appendReport(taskId: string, content: string): void {
    if (!content) return;
    this.appendReportAt(this.paths(taskId).report, content);
  }

  appendReportAt(reportPath: string, content: string): void {
    if (!content) return;
    this.withReportLock(reportPath, () => {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      const existing = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "";
      fs.appendFileSync(reportPath, redactText(content), "utf8");
      this.maybeQueuePlanReminder(reportPath, existing, content);
    });
  }

  editReport(
    reportPath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): { before: string; after: string } {
    return this.withReportLock(reportPath, () => {
      if (!fs.existsSync(reportPath)) {
        throw new Error(`Report not found: ${reportPath}`);
      }
      const before = fs.readFileSync(reportPath, "utf8");
      const occurrences = countOccurrences(before, oldString);
      if (occurrences === 0) {
        throw new Error(
          `old_string not found in ${reportPath}. Re-read the file and try again.`,
        );
      }
      if (!replaceAll && occurrences > 1) {
        throw new Error(
          `old_string found ${occurrences} times in ${reportPath}. ` +
          "Use replace_all: true or make old_string more specific.",
        );
      }
      const after = redactText(
        replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString),
      );
      writeTextAtomic(reportPath, after);
      return { before, after };
    });
  }

  takePlanReminder(reportPath: string): string | undefined {
    const key = path.resolve(reportPath);
    const reminder = this.pendingPlanReminders.get(key);
    if (reminder) this.pendingPlanReminders.delete(key);
    return reminder;
  }

  listConversationTasks(conversationId: string): ConversationTaskRecord[] {
    const records: ConversationTaskRecord[] = [];
    for (const entry of this.taskEntries()) {
      const spec = readTaskSpec(entry.taskDir);
      if (!spec) continue;
      if ((spec.rootSessionId || path.basename(path.dirname(path.dirname(entry.taskDir)))) !== conversationId) {
        continue;
      }
      records.push({
        spec,
        paths: pathsForTaskDir(entry.taskDir),
        result: readTaskResult(entry.taskDir),
        notified: isNotified(entry.taskDir),
        pinned: entry.pinned,
      });
    }
    return records.sort((left, right) => left.spec.createdAt - right.spec.createdAt);
  }

  listUnnotifiedResults(conversationId: string): TaskResult[] {
    return this.listConversationTasks(conversationId)
      .filter((record) => record.result && !record.notified)
      .map((record) => record.result!);
  }

  markNotified(taskId: string): void {
    const taskDir = this.findTaskDir(taskId);
    if (!taskDir) return;
    fs.writeFileSync(path.join(taskDir, "notified"), `${Date.now()}\n`, "utf8");
  }

  listTraceFiles(): string[] {
    const runsDir = path.join(this.projectDir, "runs");
    if (!fs.existsSync(runsDir)) return [];
    const traces: string[] = [];
    for (const run of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const tracePath = path.join(runsDir, run.name, "trace.jsonl");
      if (fs.existsSync(tracePath)) traces.push(tracePath);
    }
    return traces;
  }

  writeBlob(taskId: string, content: string): {
    path: string;
    hash: string;
    length: number;
    preview: string;
  } {
    const paths = this.paths(taskId);
    const blobDir = path.join(paths.taskDir, "blobs");
    fs.mkdirSync(blobDir, { recursive: true });
    const redacted = redactText(content);
    const hash = createHash("sha256").update(redacted).digest("hex");
    const blobPath = path.join(blobDir, `${hash.slice(0, 16)}-${randomUUID().slice(0, 8)}.txt`);
    fs.writeFileSync(blobPath, redacted, "utf8");
    return { path: blobPath, hash, length: redacted.length, preview: redacted.slice(0, 800) };
  }

  removeTask(taskId: string): boolean {
    const taskDir = this.findTaskDir(taskId);
    if (!taskDir || !fs.existsSync(taskDir)) return false;
    fs.rmSync(taskDir, { recursive: true, force: true });
    return true;
  }

  setPinned(taskId: string, pinned: boolean): void {
    const taskDir = this.findTaskDir(taskId) ?? this.paths(taskId).taskDir;
    const marker = path.join(taskDir, ".pinned");
    if (pinned) {
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(marker, `${Date.now()}\n`, "utf8");
    } else {
      fs.rmSync(marker, { force: true });
    }
  }

  isPinned(taskId: string): boolean {
    const taskDir = this.findTaskDir(taskId);
    return taskDir ? fs.existsSync(path.join(taskDir, ".pinned")) : false;
  }

  hasTask(taskId: string): boolean {
    return this.findTaskDir(taskId) !== undefined;
  }

  stats(): { taskCount: number; pinnedCount: number; totalBytes: number } {
    const entries = this.taskEntries();
    return {
      taskCount: entries.length,
      pinnedCount: entries.filter((entry) => entry.pinned).length,
      totalBytes: this.projectOverheadBytes() +
        entries.reduce((total, entry) => total + entry.bytes, 0),
    };
  }

  prune(options: {
    ttlMs: number;
    softLimitBytes: number;
    protectedTaskIds?: Set<string>;
  }): { removed: string[]; freedBytes: number; remainingBytes: number } {
    const protectedIds = options.protectedTaskIds ?? new Set<string>();
    const entries = this.taskEntries();
    let remainingBytes = this.projectOverheadBytes() +
      entries.reduce((total, entry) => total + entry.bytes, 0);
    let freedBytes = 0;
    const removed: string[] = [];
    const now = Date.now();
    const candidates = entries
      .filter((entry) =>
        entry.terminal &&
        !entry.pinned &&
        !entry.hasLiveWorkspace &&
        !protectedIds.has(entry.taskId))
      .sort((left, right) => left.mtimeMs - right.mtimeMs);

    for (const entry of candidates) {
      const expired = now - entry.mtimeMs >= options.ttlMs;
      const aboveLimit = remainingBytes > options.softLimitBytes;
      if (!expired && !aboveLimit) continue;
      if (fs.existsSync(entry.taskDir)) {
        fs.rmSync(entry.taskDir, { recursive: true, force: true });
        removed.push(entry.taskId);
        freedBytes += entry.bytes;
        remainingBytes -= entry.bytes;
      }
    }
    return { removed, freedBytes, remainingBytes };
  }

  refreshTranscript(taskId: string): void {
    const taskDir = this.findTaskDir(taskId) ?? this.paths(taskId).taskDir;
    this.deriveTranscript(taskId, path.join(taskDir, "transcript.jsonl"));
  }

  private findTaskDir(taskId: string): string | undefined {
    const current = this.paths(taskId).taskDir;
    if (fs.existsSync(current)) return current;
    return this.taskEntries().find((entry) => entry.taskId === taskId)?.taskDir;
  }

  private maybeQueuePlanReminder(reportPath: string, existing: string, appended: string): void {
    const key = path.resolve(reportPath);
    if (this.planReminded.has(key)) return;
    if (isCommentOnly(appended)) return;
    if (planHasChecklist(existing) || planHasChecklist(`${existing}${appended}`)) return;
    this.planReminded.add(key);
    this.pendingPlanReminders.set(key, [
      "The Plan section in report.md is still the placeholder checklist.",
      "Edit that Plan into concrete `- [ ]` items before writing more into ## Report.",
      `The text just appended was kept. File: ${path.resolve(reportPath)}`,
    ].join(" "));
  }

  private withReportLock<T>(reportPath: string, fn: () => T): T {
    const key = path.resolve(reportPath);
    if (this.reportLocks.has(key)) {
      return fn();
    }
    this.reportLocks.add(key);
    try {
      return fn();
    } finally {
      this.reportLocks.delete(key);
    }
  }

  private deriveTranscript(taskId: string, destination: string): void {
    if (!fs.existsSync(this.tracePath)) {
      fs.writeFileSync(destination, "", "utf8");
      return;
    }
    const matching = fs.readFileSync(this.tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        try {
          return (JSON.parse(line) as { taskId?: string }).taskId === taskId;
        } catch {
          return false;
        }
      });
    fs.writeFileSync(destination, matching.length ? `${matching.join("\n")}\n` : "", "utf8");
  }

  private taskEntries(): Array<{
    taskId: string;
    taskDir: string;
    bytes: number;
    mtimeMs: number;
    pinned: boolean;
    terminal: boolean;
    hasLiveWorkspace: boolean;
  }> {
    const runsDir = path.join(this.projectDir, "runs");
    if (!fs.existsSync(runsDir)) return [];
    const entries: Array<{
      taskId: string;
      taskDir: string;
      bytes: number;
      mtimeMs: number;
      pinned: boolean;
      terminal: boolean;
      hasLiveWorkspace: boolean;
    }> = [];
    for (const run of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const tasksDir = path.join(runsDir, run.name, "tasks");
      if (!fs.existsSync(tasksDir)) continue;
      for (const task of fs.readdirSync(tasksDir, { withFileTypes: true })) {
        if (!task.isDirectory()) continue;
        const taskDir = path.join(tasksDir, task.name);
        const stat = fs.statSync(taskDir);
        const resultPath = path.join(taskDir, "result.json");
        let hasLiveWorkspace = false;
        if (fs.existsSync(resultPath)) {
          try {
            const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as TaskResult;
            if (result.workspace) {
              const manager = WorktreeManager.tryCreate(result.workspace.repoRoot, {});
              hasLiveWorkspace = !manager ||
                !manager.isCleanupSafe(result.workspace, result.workspace);
              if (fs.existsSync(result.workspace.path)) hasLiveWorkspace = true;
            }
          } catch {
            // Preserve corrupt terminal metadata for manual recovery.
            hasLiveWorkspace = true;
          }
        }
        entries.push({
          taskId: task.name,
          taskDir,
          bytes: directorySize(taskDir),
          mtimeMs: stat.mtimeMs,
          pinned: fs.existsSync(path.join(taskDir, ".pinned")),
          terminal: fs.existsSync(resultPath),
          hasLiveWorkspace,
        });
      }
    }
    return entries;
  }

  private projectOverheadBytes(): number {
    const runsDir = path.join(this.projectDir, "runs");
    if (!fs.existsSync(runsDir)) return 0;
    let total = 0;
    for (const run of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const runDir = path.join(runsDir, run.name);
      for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
        if (entry.isFile()) total += fs.statSync(path.join(runDir, entry.name)).size;
      }
    }
    return total;
  }
}

export function planHasChecklist(content: string): boolean {
  const start = content.indexOf(PLAN_START_MARKER);
  const end = content.indexOf(PLAN_END_MARKER);
  if (start < 0 || end <= start) return false;
  const plan = content.slice(start + PLAN_START_MARKER.length, end);
  return plan.split("\n").some((line) => {
    const trimmed = line.trim();
    return /^- \[[ xX]\] /.test(trimmed) &&
      !trimmed.includes("fill this checklist before writing the report");
  });
}

function buildReportTemplate(task: TaskDetail): string {
  return [
    `# ${task.description}`,
    "",
    `- Task ID: \`${task.taskId}\``,
    `- Subagent: \`${task.subagentType}\``,
    `- Created: ${new Date(task.createdAt).toISOString()}`,
    ...(task.scope?.length ? [`- Scope: ${task.scope.join(", ")}`] : []),
    "",
    PLAN_START_MARKER,
    "## Plan",
    "",
    PLAN_PLACEHOLDER_ITEM,
    PLAN_END_MARKER,
    "",
    "## Report",
    "",
  ].join("\n");
}

function pathsForTaskDir(taskDir: string): TaskArtifactPaths {
  return {
    taskDir,
    task: path.join(taskDir, "task.json"),
    result: path.join(taskDir, "result.json"),
    report: path.join(taskDir, "report.md"),
    transcript: path.join(taskDir, "transcript.jsonl"),
    coverage: path.join(taskDir, "coverage.json"),
    patch: path.join(taskDir, "changes.patch"),
  };
}

function readTaskSpec(taskDir: string): PersistedTaskSpec | undefined {
  const specPath = path.join(taskDir, "task.json");
  if (!fs.existsSync(specPath)) return undefined;
  try {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as PersistedTaskSpec;
    if (!spec.taskId || !spec.description || !spec.prompt || !spec.subagentType) return undefined;
    return spec;
  } catch {
    return undefined;
  }
}

function readTaskResult(taskDir: string): TaskResult | undefined {
  const resultPath = path.join(taskDir, "result.json");
  if (!fs.existsSync(resultPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(resultPath, "utf8")) as TaskResult;
  } catch {
    return undefined;
  }
}

function isNotified(taskDir: string): boolean {
  return fs.existsSync(path.join(taskDir, "notified"));
}

function isCommentOnly(content: string): boolean {
  return content.replace(/<!--[\s\S]*?-->/g, "").trim().length === 0;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(filePath: string, content: string): void {
  const temp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  fs.renameSync(temp, filePath);
}

function directorySize(directory: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(entryPath);
    else if (entry.isFile()) total += fs.statSync(entryPath).size;
  }
  return total;
}
