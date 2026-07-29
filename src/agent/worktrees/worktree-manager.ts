import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import type {
  AgentConfig,
  TaskWorkspace,
  WorkspaceResult,
} from "../../shared/core-types.js";

interface GitOptions {
  cwd?: string;
  allowFailure?: boolean;
  timeout?: number;
}

export class WorktreeManager {
  readonly repoRoot: string;

  constructor(
    readonly workingDir: string,
    readonly config: Pick<AgentConfig, "worktree">,
  ) {
    this.repoRoot = git(["rev-parse", "--show-toplevel"], { cwd: workingDir }).trim();
  }

  static tryCreate(
    workingDir: string,
    config: Pick<AgentConfig, "worktree">,
  ): WorktreeManager | null {
    try {
      return new WorktreeManager(workingDir, config);
    } catch {
      return null;
    }
  }

  sweepMergedWorktrees(olderThanMs: number): string[] {
    const worktreesRoot = path.resolve(this.repoRoot, ".rubato", "worktrees");
    const removed: string[] = [];
    const records = git(["worktree", "list", "--porcelain"], {
      cwd: this.repoRoot,
      allowFailure: true,
    }).split(/\n\n+/);
    for (const record of records) {
      const values = new Map(
        record.split("\n")
          .filter(Boolean)
          .map((line) => {
            const separator = line.indexOf(" ");
            return separator < 0
              ? [line, ""]
              : [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      const workspacePath = values.get("worktree");
      const branchRef = values.get("branch");
      if (!workspacePath || !branchRef?.startsWith("refs/heads/rubato/")) continue;
      const resolved = path.resolve(workspacePath);
      if (!resolved.startsWith(`${worktreesRoot}${path.sep}`) || values.has("locked")) continue;
      if (!fs.existsSync(resolved) || fs.statSync(resolved).mtimeMs > olderThanMs) continue;
      if (git(["status", "--porcelain"], { cwd: resolved, allowFailure: true }).trim()) continue;
      const head = git(["rev-parse", "HEAD"], { cwd: resolved, allowFailure: true }).trim();
      if (!head || !this.isIntegrated(branchRef.slice("refs/heads/".length), head)) {
        continue;
      }
      git(["worktree", "remove", resolved], { cwd: this.repoRoot });
      git(["branch", "-D", branchRef.slice("refs/heads/".length)], {
        cwd: this.repoRoot,
        allowFailure: true,
      });
      removed.push(resolved);
    }
    git(["worktree", "prune"], { cwd: this.repoRoot, allowFailure: true });
    return removed;
  }

  create(taskId: string, rootSessionId: string): TaskWorkspace {
    this.assertRepositoryReady();
    const baseRef = this.resolveBaseRef();
    const baseCommit = git(["rev-parse", baseRef], { cwd: this.repoRoot }).trim();
    const safeTask = safeSegment(taskId);
    const branch = `rubato/${safeSegment(rootSessionId).slice(0, 12)}/${safeTask.slice(0, 24)}`;
    const worktreesDir = path.join(this.repoRoot, ".rubato", "worktrees");
    const workspacePath = path.join(worktreesDir, safeTask);
    this.ensureWorktreeRootIgnored();
    fs.mkdirSync(worktreesDir, { recursive: true });
    if (fs.existsSync(workspacePath)) {
      throw new Error(`Worktree path already exists: ${workspacePath}`);
    }
    if (gitSucceeds(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.repoRoot)) {
      throw new Error(`Worktree branch already exists: ${branch}`);
    }

    try {
      git(["worktree", "add", "-b", branch, workspacePath, baseRef], {
        cwd: this.repoRoot,
        timeout: 30_000,
      });
      git(["worktree", "lock", "--reason", `rubato task ${taskId}`, workspacePath], {
        cwd: this.repoRoot,
      });
      this.copyIncludedIgnoredFiles(workspacePath);
    } catch (error) {
      if (fs.existsSync(workspacePath)) {
        git(["worktree", "remove", "--force", workspacePath], {
          cwd: this.repoRoot,
          allowFailure: true,
        });
      }
      git(["branch", "-D", branch], { cwd: this.repoRoot, allowFailure: true });
      throw error;
    }

    return {
      path: workspacePath,
      branch,
      baseCommit,
      repoRoot: this.repoRoot,
      locked: true,
      createdAt: Date.now(),
      sourceDirty: git(["status", "--porcelain"], {
        cwd: this.repoRoot,
        allowFailure: true,
      }).trim().length > 0,
    };
  }

  finalize(workspace: TaskWorkspace, patchPath: string, scope: string[] = []): WorkspaceResult {
    const status = git(["status", "--porcelain"], { cwd: workspace.path, allowFailure: true });
    const dirty = status.trim().length > 0;
    const headCommit = git(["rev-parse", "HEAD"], { cwd: workspace.path }).trim();
    const commits = lines(git([
      "log",
      "--format=%H",
      `${workspace.baseCommit}..${headCommit}`,
    ], { cwd: workspace.path, allowFailure: true }));
    const filesChanged = parseNameStatus(git([
      "diff",
      "--name-status",
      `${workspace.baseCommit}..${headCommit}`,
    ], { cwd: workspace.path, allowFailure: true }));
    for (const file of parsePorcelainPaths(status)) {
      if (!filesChanged.includes(file)) filesChanged.push(file);
    }
    const patch = git([
      "diff",
      "--binary",
      workspace.baseCommit,
      headCommit,
    ], { cwd: workspace.path, allowFailure: true });
    fs.mkdirSync(path.dirname(patchPath), { recursive: true });
    fs.writeFileSync(patchPath, patch, "utf8");
    const scopeDeviations = scope.length > 0
      ? filesChanged.filter((file) => !scope.some((entry) => matchesScope(file, entry)))
      : [];

    if (workspace.locked) {
      git(["worktree", "unlock", workspace.path], {
        cwd: workspace.repoRoot,
        allowFailure: true,
      });
      workspace.locked = false;
    }

    return {
      ...workspace,
      headCommit,
      commits,
      filesChanged: filesChanged.sort(),
      dirty,
      patchPath,
      scopeDeviations,
    };
  }

  cleanupIfSafe(workspace: TaskWorkspace, result?: WorkspaceResult): boolean {
    if (!this.isCleanupSafe(workspace, result)) return false;

    if (fs.existsSync(workspace.path) && workspace.locked) {
      git(["worktree", "unlock", workspace.path], {
        cwd: workspace.repoRoot,
        allowFailure: true,
      });
      workspace.locked = false;
    }
    if (fs.existsSync(workspace.path)) {
      git(["worktree", "remove", workspace.path], { cwd: workspace.repoRoot });
    }
    if (this.branchExists(workspace.branch)) {
      git(["branch", "-D", workspace.branch], {
        cwd: workspace.repoRoot,
        allowFailure: true,
      });
    }
    return true;
  }

  isCleanupSafe(workspace: TaskWorkspace, result?: WorkspaceResult): boolean {
    const pathExists = fs.existsSync(workspace.path);
    const branchExists = this.branchExists(workspace.branch);
    if (!pathExists && !branchExists) return true;
    if (pathExists) {
      const status = git(["status", "--porcelain"], {
        cwd: workspace.path,
        allowFailure: true,
      }).trim();
      if (status) return false;
    }
    const headCommit = git(["rev-parse", pathExists ? "HEAD" : workspace.branch], {
      cwd: pathExists ? workspace.path : workspace.repoRoot,
      allowFailure: true,
    }).trim() || result?.headCommit || "";
    const noTaskCommits = !headCommit || headCommit === workspace.baseCommit;
    return noTaskCommits || (branchExists && this.isIntegrated(workspace.branch, headCommit));
  }

  private isIntegrated(branch: string, headCommit: string): boolean {
    if (gitSucceeds(["merge-base", "--is-ancestor", headCommit, "HEAD"], this.repoRoot)) {
      return true;
    }
    // Cherry-pick changes commit IDs. `git cherry` marks patch-equivalent
    // commits with "-", allowing safe cleanup after every worker commit was
    // integrated without requiring ancestry.
    const comparison = lines(git(["cherry", "HEAD", branch], {
      cwd: this.repoRoot,
      allowFailure: true,
    }));
    return comparison.length > 0 && comparison.every((line) => line.startsWith("- "));
  }

  private branchExists(branch: string): boolean {
    return gitSucceeds(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.repoRoot);
  }

  private resolveBaseRef(): string {
    if (this.config.worktree?.baseRef === "head") return "HEAD";
    const remoteHead = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
      cwd: this.repoRoot,
      allowFailure: true,
    }).trim();
    if (remoteHead && gitSucceeds(["rev-parse", "--verify", remoteHead], this.repoRoot)) {
      return remoteHead;
    }
    return "HEAD";
  }

  private assertRepositoryReady(): void {
    const gitDir = git(["rev-parse", "--git-dir"], { cwd: this.repoRoot }).trim();
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD"]) {
      if (fs.existsSync(path.resolve(this.repoRoot, gitDir, marker))) {
        throw new Error(`Cannot create worker worktree while Git operation ${marker} is active.`);
      }
    }
  }

  private ensureWorktreeRootIgnored(): void {
    const rawExclude = git(["rev-parse", "--git-path", "info/exclude"], {
      cwd: this.repoRoot,
    }).trim();
    const excludePath = path.isAbsolute(rawExclude)
      ? rawExclude
      : path.resolve(this.repoRoot, rawExclude);
    const rule = "/.rubato/worktrees/";
    const existing = fs.existsSync(excludePath)
      ? fs.readFileSync(excludePath, "utf8")
      : "";
    if (existing.split(/\r?\n/).some((line) => line.trim() === rule)) return;
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(
      excludePath,
      `${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${rule}\n`,
      "utf8",
    );
  }

  private copyIncludedIgnoredFiles(workspacePath: string): void {
    const includePath = path.join(this.repoRoot, ".worktreeinclude");
    if (!fs.existsSync(includePath)) return;
    const ignored = new Set(zeroLines(gitBuffer([
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ], this.repoRoot)));
    const included = zeroLines(gitBuffer([
      "ls-files",
      "--others",
      "--ignored",
      `--exclude-from=${includePath}`,
      "-z",
    ], this.repoRoot));
    for (const relative of included) {
      if (!ignored.has(relative) || !isSafeRelative(relative)) continue;
      const source = path.resolve(this.repoRoot, relative);
      const destination = path.resolve(workspacePath, relative);
      if (!destination.startsWith(`${path.resolve(workspacePath)}${path.sep}`)) continue;
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }
}

function git(args: string[], options: GitOptions = {}): string {
  try {
    return execFileSync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 10_000,
    });
  } catch (error) {
    if (options.allowFailure) return "";
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
    throw new Error(stderr || `git ${args.join(" ")} failed`);
  }
}

function gitBuffer(args: string[], cwd: string): Buffer {
  return execFileSync("git", args, {
    cwd,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
}

function gitSucceeds(args: string[], cwd: string): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "task";
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function zeroLines(value: Buffer): string[] {
  return value.toString("utf8").split("\0").filter(Boolean);
}

function parseNameStatus(value: string): string[] {
  const files: string[] = [];
  for (const line of lines(value)) {
    const [, ...paths] = line.split("\t");
    for (const file of paths) if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

function parsePorcelainPaths(value: string): string[] {
  return lines(value).flatMap((line) => {
    const raw = line.slice(3).trim();
    const renamed = raw.split(" -> ");
    return renamed.map((item) => item.replace(/^"|"$/g, "")).filter(Boolean);
  });
}

function matchesScope(file: string, rawScope: string): boolean {
  const scope = rawScope.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/$/, "");
  return file === scope || file.startsWith(`${scope}/`);
}

function isSafeRelative(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false;
  const parts = value.split(/[\\/]/);
  return !parts.includes("..") && !parts.includes(".git");
}
