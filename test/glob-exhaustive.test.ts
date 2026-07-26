import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globTool } from "../src/tools/glob.js";
import type { AgentContext } from "../src/shared/core-types.js";

describe("Glob exhaustive discovery", () => {
  let projectDir = "";

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-glob-"));
    fs.mkdirSync(path.join(projectDir, ".hidden"));
    fs.mkdirSync(path.join(projectDir, "node_modules"));
    fs.mkdirSync(path.join(projectDir, ".git"));
    fs.writeFileSync(path.join(projectDir, "visible.ts"), "export {};\n");
    fs.writeFileSync(path.join(projectDir, ".hidden.ts"), "export const hidden = true;\n");
    fs.writeFileSync(path.join(projectDir, ".hidden", "nested.ts"), "export {};\n");
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const ctx = () => ({
    workingDir: projectDir,
  } as AgentContext);

  it("includes dotfiles only when include_hidden is explicitly enabled", async () => {
    const ordinary = await globTool.handler({
      path: projectDir,
      pattern: "**/*",
    }, ctx());
    expect(ordinary.content).toContain("visible.ts");
    expect(ordinary.content).not.toContain(".hidden.ts");

    const exhaustive = await globTool.handler({
      path: projectDir,
      pattern: "**/*",
      include_hidden: true,
    }, ctx());
    expect(exhaustive.content).toContain(".hidden.ts");
    expect(exhaustive.content).toContain(path.join(".hidden", "nested.ts"));
    expect(exhaustive.content).toContain("Glob policy exclusion:");
    expect(exhaustive.content).toContain("node_modules");
    expect(exhaustive.content).toContain(".git");
  });

  it("reports symbolic-link directories as incomplete instead of silently skipping them", async () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-glob-target-"));
    try {
      fs.symlinkSync(external, path.join(projectDir, "linked-dir"), "dir");
      const result = await globTool.handler({
        path: projectDir,
        pattern: "**/*",
        include_hidden: true,
      }, ctx());

      expect(result.content).toContain("Glob incomplete: skipped");
      expect(result.content).toContain("symbolic-link directories are not traversed");
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});
