import fs from "fs";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import type {
  CoverageManifest,
  TaskArtifactPaths,
  TaskDetail,
  TaskResult,
} from "../../shared/core-types.js";
import { redactText, redactValue } from "./redaction.js";
import { coverageSummary, emptyCoverageManifest } from "./coverage.js";
import { WorktreeManager } from "../worktrees/worktree-manager.js";
import {
  legacyTruncatedProjectMemoryId,
  projectMemoryId,
} from "../../memory-files/paths.js";

export class ArtifactStore {
  readonly projectDir: string;
  readonly runDir: string;
  readonly tracePath: string;

  constructor(
    projectDir: string,
    rootSessionId: string,
    rubatoHome = process.env.RUBATO_HOME ?? path.join(os.homedir(), ".rubato"),
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

  static recoverProjectOrphans(
    projectDir: string,
    rubatoHome = process.env.RUBATO_HOME ?? path.join(os.homedir(), ".rubato"),
  ): TaskResult[] {
    const recovered: TaskResult[] = [];
    for (const projectHash of new Set([
      projectMemoryId(projectDir),
      legacyTruncatedProjectMemoryId(projectDir),
    ])) {
      const runsDir = path.join(rubatoHome, "projects", projectHash, "runs");
      if (!fs.existsSync(runsDir)) continue;
      for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const store = new ArtifactStore(
          projectDir,
          entry.name,
          rubatoHome,
          projectHash,
        );
        recovered.push(...store.recoverOrphaned());
      }
    }
    return recovered;
  }

  paths(taskId: string): TaskArtifactPaths {
    const taskDir = path.join(this.runDir, "tasks", safeSegment(taskId));
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

  initializeTask(task: TaskDetail): void {
    fs.mkdirSync(task.artifacts.taskDir, { recursive: true });
    writeJsonAtomic(task.artifacts.task, redactValue({
      taskId: task.taskId,
      agentId: task.agentId,
      rootSessionId: task.rootSessionId,
      parentTaskId: task.parentTaskId,
      description: task.description,
      prompt: task.prompt,
      subagentType: task.subagentType,
      dependency: task.dependency,
      scope: task.scope,
      workspace: task.workspace,
      depth: task.depth,
      createdAt: task.createdAt,
    }));
  }

  updateTask(task: TaskDetail): void {
    writeJsonAtomic(task.artifacts.task, redactValue({
      taskId: task.taskId,
      agentId: task.agentId,
      rootSessionId: task.rootSessionId,
      parentTaskId: task.parentTaskId,
      description: task.description,
      prompt: task.prompt,
      subagentType: task.subagentType,
      dependency: task.dependency,
      scope: task.scope,
      workspace: task.workspace,
      depth: task.depth,
      createdAt: task.createdAt,
    }));
  }

  finalizeTask(
    task: TaskDetail,
    result: TaskResult,
    report: string,
    coverage: CoverageManifest = emptyCoverageManifest(false),
  ): void {
    fs.mkdirSync(task.artifacts.taskDir, { recursive: true });
    fs.writeFileSync(task.artifacts.report, redactText(report), "utf8");
    writeJsonAtomic(task.artifacts.coverage, redactValue(coverage));
    writeJsonAtomic(task.artifacts.result, redactValue({
      ...result,
      coveragePath: task.artifacts.coverage,
      coverage: result.coverage ?? coverageSummary(coverage),
    }));
    this.deriveTranscript(task.taskId, task.artifacts.transcript);
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
    const taskDir = this.paths(taskId).taskDir;
    if (!fs.existsSync(taskDir)) return false;
    fs.rmSync(taskDir, { recursive: true, force: true });
    return true;
  }

  setPinned(taskId: string, pinned: boolean): void {
    const marker = path.join(this.paths(taskId).taskDir, ".pinned");
    if (pinned) {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `${Date.now()}\n`, "utf8");
    } else {
      fs.rmSync(marker, { force: true });
    }
  }

  isPinned(taskId: string): boolean {
    return fs.existsSync(path.join(this.paths(taskId).taskDir, ".pinned"));
  }

  hasTask(taskId: string): boolean {
    return fs.existsSync(this.paths(taskId).taskDir);
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

  recoverOrphaned(): TaskResult[] {
    const tasksDir = path.join(this.runDir, "tasks");
    if (!fs.existsSync(tasksDir)) return [];
    const recovered: TaskResult[] = [];
    for (const taskId of fs.readdirSync(tasksDir)) {
      const paths = this.paths(taskId);
      if (!fs.existsSync(paths.task) || fs.existsSync(paths.result)) continue;
      try {
        const task = JSON.parse(fs.readFileSync(paths.task, "utf8")) as {
          agentId: string;
          createdAt?: number;
          workspace?: import("../../shared/core-types.js").TaskWorkspace;
          scope?: string[];
        };
        const endedAt = Date.now();
        let workspaceResult;
        if (task.workspace && fs.existsSync(task.workspace.path)) {
          try {
            workspaceResult = new WorktreeManager(task.workspace.repoRoot, {}).finalize(
              task.workspace,
              paths.patch,
              task.scope,
            );
          } catch {
            // Preserve a conservative recovery record when Git inspection fails.
          }
        }
        workspaceResult ??= task.workspace
          ? {
              ...task.workspace,
              headCommit: task.workspace.baseCommit,
              commits: [],
              filesChanged: [],
              dirty: fs.existsSync(task.workspace.path),
              patchPath: paths.patch,
              scopeDeviations: [],
            }
          : undefined;
        const result: TaskResult = {
          taskId,
          agentId: task.agentId,
          status: "orphaned",
          summary: "Task was running when the previous Rubato process exited.",
          reportPath: paths.report,
          resultPath: paths.result,
          transcriptPath: paths.transcript,
          coveragePath: paths.coverage,
          usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
          coverage: coverageSummary(emptyCoverageManifest(false)),
          error: "Recovered without a live task process.",
          startedAt: task.createdAt,
          endedAt,
          workspace: workspaceResult,
        };
        this.finalizeTask(
          {
            taskId,
            agentId: task.agentId,
            rootSessionId: "",
            description: "",
            prompt: "",
            subagentType: "",
            dependency: "required",
            status: "orphaned",
            depth: 1,
            createdAt: task.createdAt ?? endedAt,
            endedAt,
            lastActivityAt: endedAt,
            childCount: 0,
            workspace: task.workspace,
            artifacts: paths,
          },
          result,
          "# Orphaned task\n\nThe prior Rubato process exited before this task reached a terminal state.",
        );
        recovered.push(result);
      } catch {
        // A corrupt task record is left intact for manual inspection.
      }
    }
    return recovered;
  }

  refreshTranscript(taskId: string): void {
    this.deriveTranscript(taskId, this.paths(taskId).transcript);
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

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
