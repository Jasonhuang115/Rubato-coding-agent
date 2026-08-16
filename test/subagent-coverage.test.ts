import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObservableCoverageTracker } from "../src/agent/subagents/coverage.js";

describe("observable exhaustive coverage gate", () => {
  let projectDir = "";
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-coverage-"));
    fs.mkdirSync(path.join(projectDir, "src"));
    fs.writeFileSync(path.join(projectDir, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(projectDir, "src", "b.ts"), "one\ntwo\n");
  });
  afterEach(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  it("stays failed until discovery and every file range are closed", () => {
    const tracker = new ObservableCoverageTracker(projectDir, "Inspect every line of every source file.");
    tracker.recordToolResult("Glob", {
      path: path.join(projectDir, "src"), pattern: "**/*", include_hidden: true,
    }, `2 files matching "**/*" in ${path.join(projectDir, "src")}:\n\na.ts\nb.ts`, false);
    tracker.recordToolResult("Read", { file_path: path.join(projectDir, "src", "a.ts") }, "a", false);
    tracker.recordToolResult("Read", {
      file_path: path.join(projectDir, "src", "b.ts"), offset: 1, limit: 1,
    }, "one", false);
    expect(tracker.snapshot()).toMatchObject({ required: true, complete: false, gate_satisfied: false });
    tracker.recordToolResult("Read", {
      file_path: path.join(projectDir, "src", "b.ts"), offset: 2, limit: 10,
    }, "two", false);
    expect(tracker.snapshot()).toMatchObject({
      discovery_complete: true,
      complete: true,
      gate_satisfied: true,
      discovered: 2,
      inspected: 2,
    });
  });

  it("does not accept truncated discovery", () => {
    const tracker = new ObservableCoverageTracker(projectDir, "exhaustively inspect all source files");
    tracker.recordToolResult("Glob", {
      path: path.join(projectDir, "src"), pattern: "**/*", include_hidden: true,
    }, `2 files matching "**/*" in ${path.join(projectDir, "src")} (limited to 2):\n\na.ts\nb.ts`, false);
    for (const file of ["a.ts", "b.ts"]) {
      tracker.recordToolResult("Read", { file_path: path.join(projectDir, "src", file) }, file, false);
    }
    expect(tracker.snapshot()).toMatchObject({
      discovery_complete: false,
      complete: false,
      gate_satisfied: false,
    });
  });

  it("requires hidden entries in exhaustive discovery", () => {
    const tracker = new ObservableCoverageTracker(projectDir, "Exhaustively inspect all files");
    tracker.recordToolResult("Glob", {
      path: projectDir, pattern: "**/*", include_hidden: false,
    }, `No files matching "**/*" in ${projectDir}`, false);
    expect(tracker.snapshot()).toMatchObject({ discovery_complete: false, gate_satisfied: false });
    expect(tracker.snapshot().notes.join("\n")).toContain("include_hidden=true");
  });

  it("keeps inaccessible discovery open", () => {
    const tracker = new ObservableCoverageTracker(projectDir, "Exhaustively inspect all files");
    tracker.recordToolResult("Glob", {
      path: projectDir, pattern: "**/*", include_hidden: true,
    }, [
      `No files matching "**/*" in ${projectDir}`,
      `Glob incomplete: skipped ${path.join(projectDir, "locked")} (EACCES)`,
    ].join("\n"), false);
    expect(tracker.snapshot()).toMatchObject({ discovery_complete: false, gate_satisfied: false });
    expect(tracker.snapshot().notes.join("\n")).toContain("Glob incomplete");
  });
});
