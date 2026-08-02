import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObservableCoverageTracker } from "../src/agent/subagents/coverage.js";
import { completeTaskTool } from "../src/tools/complete-task.js";
import type { AgentContext } from "../src/shared/core-types.js";

describe("observable exhaustive coverage gate", () => {
  let projectDir = "";

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-coverage-"));
    fs.mkdirSync(path.join(projectDir, "src"));
    fs.writeFileSync(path.join(projectDir, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(
      path.join(projectDir, "src", "b.ts"),
      "export const b = 1;\nexport const c = 2;\n",
    );
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("rejects completed until discovery and every file range are closed", async () => {
    const tracker = new ObservableCoverageTracker(
      projectDir,
      "Inspect every line of every source file.",
    );
    tracker.recordToolResult("Glob", {
      path: path.join(projectDir, "src"),
      pattern: "**/*",
      include_hidden: true,
    }, [
      `2 files matching "**/*" in ${path.join(projectDir, "src")}:`,
      "",
      "     20B  a.ts",
      "     40B  b.ts",
    ].join("\n"), false);
    tracker.recordToolResult("Read", {
      file_path: path.join(projectDir, "src", "a.ts"),
    }, "a", false);
    tracker.recordToolResult("Read", {
      file_path: path.join(projectDir, "src", "b.ts"),
      offset: 1,
      limit: 1,
    }, "b line 1", false);

    const taskRuntime = {
      rootSessionId: "root",
      taskId: "task",
      agentId: "agent",
      depth: 1,
      completionSubmitted: false,
      coverage: tracker,
    };
    const ctx = {
      workingDir: projectDir,
      sessionId: "agent",
      readGuard: { hasRead: () => false, markAsRead: () => {}, serialize: () => ({ files: {} }) },
      permissionManager: { check: () => ({ allowed: true as const }) },
      config: {
        model: { provider: "test", model: "test" },
        permissions: { bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto" },
        session: { cleanupPeriodDays: 30 },
      },
      taskRuntime,
      depth: 1,
    } satisfies AgentContext;
    const completion = {
      status: "completed",
      summary: "Every source line was inspected.",
      report_markdown: "# Complete\n\nEvery line is covered.",
      coverage: {
        exhaustive: true,
        scope_roots: [path.join(projectDir, "src")],
      },
    };

    const rejected = await completeTaskTool.handler(completion, ctx);
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain("coverage is not closed");
    expect(taskRuntime.completionSubmitted).toBe(false);

    tracker.recordToolResult("Read", {
      file_path: path.join(projectDir, "src", "b.ts"),
      offset: 2,
      limit: 10,
    }, "b remaining lines", false);
    const accepted = await completeTaskTool.handler(completion, ctx);
    expect(accepted.isError).not.toBe(true);
    expect(accepted.control?.type).toBe("task_completion");
    expect(taskRuntime.completionSubmitted).toBe(true);

    const manifest = tracker.snapshot();
    expect(manifest).toMatchObject({
      required: true,
      discovery_complete: true,
      complete: true,
      gate_satisfied: true,
      discovered: 2,
      inspected: 2,
      failed: 0,
    });
    expect(manifest.files.every((file) =>
      typeof file.line_count === "number" &&
      typeof file.content_hash === "string")).toBe(true);
  });

  it("does not accept a truncated discovery as complete", () => {
    const tracker = new ObservableCoverageTracker(projectDir, "exhaustively inspect all source files");
    tracker.recordToolResult("Glob", {
      path: path.join(projectDir, "src"),
      pattern: "**/*",
      include_hidden: true,
    }, [
      `2 files matching "**/*" in ${path.join(projectDir, "src")} (limited to 2):`,
      "",
      "     20B  a.ts",
      "     40B  b.ts",
    ].join("\n"), false);
    for (const file of ["a.ts", "b.ts"]) {
      tracker.recordToolResult("Read", {
        file_path: path.join(projectDir, "src", file),
      }, file, false);
    }

    expect(tracker.snapshot()).toMatchObject({
      discovery_complete: false,
      complete: false,
      gate_satisfied: false,
    });
  });

  it("treats a literal-prefixed recursive Glob as broad discovery of that subdirectory", () => {
    const tracker = new ObservableCoverageTracker(
      projectDir,
      "Exhaustively inspect the src project.",
    );
    tracker.recordToolResult("Glob", {
      path: projectDir,
      pattern: "src/**/*",
      include_hidden: true,
    }, [
      `2 files matching "src/**/*" in ${projectDir}:`,
      "",
      "     20B  src/a.ts",
      "     40B  src/b.ts",
    ].join("\n"), false);
    for (const file of ["a.ts", "b.ts"]) {
      tracker.recordToolResult("Read", {
        file_path: path.join(projectDir, "src", file),
      }, file, false);
    }
    tracker.applyDeclaration({
      exhaustive: true,
      scope_roots: [path.join(projectDir, "src")],
      exclusions: [],
    });

    expect(tracker.snapshot()).toMatchObject({
      discovery_complete: true,
      complete: true,
      gate_satisfied: true,
      discovered: 2,
      inspected: 2,
    });
  });

  it("rejects directory exclusions instead of silently excluding every child", () => {
    const tracker = new ObservableCoverageTracker(
      projectDir,
      "Exhaustively inspect the src project.",
    );
    tracker.recordToolResult("Glob", {
      path: path.join(projectDir, "src"),
      pattern: "**/*",
      include_hidden: true,
    }, [
      `2 files matching "**/*" in ${path.join(projectDir, "src")}:`,
      "",
      "     20B  a.ts",
      "     40B  b.ts",
    ].join("\n"), false);
    for (const file of ["a.ts", "b.ts"]) {
      tracker.recordToolResult("Read", {
        file_path: path.join(projectDir, "src", file),
      }, file, false);
    }

    expect(tracker.applyDeclaration({
      exhaustive: true,
      scope_roots: [path.join(projectDir, "src")],
      exclusions: [{
        path: path.join(projectDir, "src"),
        reason: "Directory, not a source file.",
      }],
    })).toEqual([path.join(projectDir, "src")]);
    expect(tracker.snapshot()).toMatchObject({
      inspected: 2,
      excluded: 0,
    });
  });

  it("does not close exhaustive discovery when hidden entries were not included", () => {
    const tracker = new ObservableCoverageTracker(projectDir, "Exhaustively inspect all files");
    tracker.recordToolResult("Glob", {
      path: projectDir,
      pattern: "**/*",
      include_hidden: false,
    }, `No files matching "**/*" in ${projectDir}`, false);
    tracker.applyDeclaration({
      exhaustive: true,
      scope_roots: [projectDir],
      exclusions: [],
    });

    expect(tracker.snapshot()).toMatchObject({
      discovery_complete: false,
      gate_satisfied: false,
    });
    expect(tracker.snapshot().notes.join("\n")).toContain("include_hidden=true");
  });

  it("does not close discovery when Glob reports an inaccessible path", () => {
    const tracker = new ObservableCoverageTracker(projectDir, "Exhaustively inspect all files");
    tracker.recordToolResult("Glob", {
      path: projectDir,
      pattern: "**/*",
      include_hidden: true,
    }, [
      `No files matching "**/*" in ${projectDir}`,
      "",
      `Glob incomplete: skipped ${path.join(projectDir, "locked")} (EACCES)`,
    ].join("\n"), false);
    tracker.applyDeclaration({
      exhaustive: true,
      scope_roots: [projectDir],
      exclusions: [],
    });

    expect(tracker.snapshot()).toMatchObject({
      discovery_complete: false,
      gate_satisfied: false,
    });
    expect(tracker.snapshot().notes.join("\n")).toContain("Glob incomplete");
  });
});
