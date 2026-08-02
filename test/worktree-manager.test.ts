import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/shared/core-types.js";
import { WorktreeManager } from "../src/agent/worktrees/worktree-manager.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-worktree-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Rubato Test");
  git(root, "config", "user.email", "rubato@example.test");
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n*.secret\n");
  git(root, "add", "base.txt", ".gitignore");
  git(root, "commit", "-qm", "base");
  return root;
}

function config(): AgentConfig {
  return {
    model: { provider: "test", model: "test" },
    permissions: {
      bash: "auto",
      read: "auto",
      write: "auto",
      edit: "auto",
      web: "auto",
    },
    session: { cleanupPeriodDays: 30 },
    worktree: { baseRef: "head" },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("WorktreeManager", () => {
  it("creates an isolated branch and copies only ignored files explicitly included", () => {
    const root = repository();
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=test-only\n");
    fs.writeFileSync(path.join(root, "private.secret"), "do-not-copy\n");
    fs.writeFileSync(path.join(root, ".worktreeinclude"), ".env\n");
    const manager = new WorktreeManager(root, config());

    const workspace = manager.create("task/write", "session/root");

    expect(workspace.branch).toMatch(/^rubato\/session-root\/task-write$/);
    expect(workspace.baseCommit).toBe(git(root, "rev-parse", "HEAD"));
    expect(fs.readFileSync(path.join(workspace.path, ".env"), "utf8"))
      .toBe("TOKEN=test-only\n");
    expect(fs.existsSync(path.join(workspace.path, "private.secret"))).toBe(false);
    expect(git(root, "worktree", "list", "--porcelain")).toContain("locked");
    expect(git(root, "status", "--porcelain")).not.toContain(".rubato/worktrees");
  });

  it("returns commit and diff evidence, then cleans only after integration", () => {
    const root = repository();
    const manager = new WorktreeManager(root, config());
    const workspace = manager.create("task-commit", "session");
    fs.writeFileSync(path.join(workspace.path, "feature.txt"), "implemented\n");
    git(workspace.path, "add", "feature.txt");
    git(workspace.path, "commit", "-qm", "implement feature");
    const patchPath = path.join(root, ".rubato", "artifacts", "changes.patch");

    const result = manager.finalize(workspace, patchPath, ["feature.txt"]);

    expect(result.commits).toEqual([git(workspace.path, "rev-parse", "HEAD")]);
    expect(result.filesChanged).toEqual(["feature.txt"]);
    expect(result.dirty).toBe(false);
    expect(result.scopeDeviations).toEqual([]);
    expect(fs.readFileSync(patchPath, "utf8")).toContain("implemented");
    expect(manager.cleanupIfSafe(workspace, result)).toBe(false);

    git(root, "merge", "--no-ff", "-m", "integrate worker", workspace.branch);
    expect(manager.cleanupIfSafe(workspace, result)).toBe(true);
    expect(fs.existsSync(workspace.path)).toBe(false);
    expect(() => execFileSync(
      "git",
      ["show-ref", "--verify", `refs/heads/${workspace.branch}`],
      { cwd: root, stdio: "ignore" },
    )).toThrow();
  });

  it("preserves dirty worktrees and reports scope deviations", () => {
    const root = repository();
    const manager = new WorktreeManager(root, config());
    const workspace = manager.create("task-dirty", "session");
    fs.writeFileSync(path.join(workspace.path, "unexpected.txt"), "uncommitted\n");

    const result = manager.finalize(
      workspace,
      path.join(root, ".rubato", "artifacts", "dirty.patch"),
      ["src/"],
    );

    expect(result.dirty).toBe(true);
    expect(result.filesChanged).toContain("unexpected.txt");
    expect(result.scopeDeviations).toEqual(["unexpected.txt"]);
    expect(manager.cleanupIfSafe(workspace, result)).toBe(false);
    expect(fs.existsSync(workspace.path)).toBe(true);
  });

  it("recognizes patch-equivalent cherry-picked commits as integrated", () => {
    const root = repository();
    const manager = new WorktreeManager(root, config());
    const workspace = manager.create("task-cherry-pick", "session");
    fs.writeFileSync(path.join(workspace.path, "picked.txt"), "picked\n");
    git(workspace.path, "add", "picked.txt");
    git(workspace.path, "commit", "-qm", "pick this");
    const result = manager.finalize(
      workspace,
      path.join(root, ".rubato", "artifacts", "picked.patch"),
    );

    fs.writeFileSync(path.join(root, "main-only.txt"), "root change\n");
    git(root, "add", "main-only.txt");
    git(root, "commit", "-qm", "advance root");
    git(root, "cherry-pick", result.headCommit);

    expect(git(root, "rev-parse", "HEAD")).not.toBe(result.headCommit);
    expect(manager.cleanupIfSafe(workspace, result)).toBe(true);
    expect(() => execFileSync(
      "git",
      ["show-ref", "--verify", `refs/heads/${workspace.branch}`],
      { cwd: root, stdio: "ignore" },
    )).toThrow();
  });

  it("sweeps only old, unlocked, clean, integrated Rubato worktrees", () => {
    const root = repository();
    const manager = new WorktreeManager(root, config());
    const workspace = manager.create("task-sweep", "session");
    fs.writeFileSync(path.join(workspace.path, "swept.txt"), "sweep me\n");
    git(workspace.path, "add", "swept.txt");
    git(workspace.path, "commit", "-qm", "sweepable change");
    const result = manager.finalize(
      workspace,
      path.join(root, ".rubato", "artifacts", "swept.patch"),
    );
    git(root, "merge", "--no-ff", "-m", "integrate sweepable", result.branch);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60_000);
    fs.utimesSync(workspace.path, old, old);

    expect(manager.sweepMergedWorktrees(Date.now() - 24 * 60 * 60_000))
      .toEqual([workspace.path]);
    expect(fs.existsSync(workspace.path)).toBe(false);
  });

  it("preserves an unmerged branch even if its worktree directory disappeared", () => {
    const root = repository();
    const manager = new WorktreeManager(root, config());
    const workspace = manager.create("task-missing-path", "session");
    fs.writeFileSync(path.join(workspace.path, "branch-only.txt"), "preserve branch\n");
    git(workspace.path, "add", "branch-only.txt");
    git(workspace.path, "commit", "-qm", "branch-only change");
    const result = manager.finalize(
      workspace,
      path.join(root, ".rubato", "artifacts", "branch-only.patch"),
    );
    git(root, "worktree", "remove", workspace.path);

    expect(manager.cleanupIfSafe(workspace, result)).toBe(false);
    git(root, "cherry-pick", result.headCommit);
    expect(manager.cleanupIfSafe(workspace, result)).toBe(true);
  });
});
