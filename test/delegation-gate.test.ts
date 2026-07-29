import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  RootDelegationGate,
  requiresParallelDelegation,
} from "../src/agent/delegation-gate.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";
import { SecurityRuntime } from "../src/security/runtime.js";
import type { AgentContext, ToolDefinition } from "../src/shared/core-types.js";
import { globTool } from "../src/tools/glob.js";

describe("RootDelegationGate", () => {
  it("detects explicit parallel multi-scope requests without matching ordinary reads", () => {
    expect(requiresParallelDelegation(
      "并行探索 /Users/me/code 下所有项目，并写一个独立脚本",
    )).toBe(true);
    expect(requiresParallelDelegation(
      "Analyze all repositories concurrently and summarize them.",
    )).toBe(true);
    expect(requiresParallelDelegation("探索一下这个项目并评价架构")).toBe(false);
    expect(requiresParallelDelegation("并行读取这两个已知文件")).toBe(false);
  });

  it("blocks substantive root work until an Agent task succeeds", () => {
    const gate = new RootDelegationGate("并行探索这个目录下所有项目");
    gate.prepareTurn([{ name: "Glob", input: {} }]);

    expect(gate.check("TodoWrite")).toBeNull();
    expect(gate.check("Glob")).toContain("delegation gate");
    expect(gate.check("Write")).toContain("delegation gate");

    gate.prepareTurn([{ name: "Agent", input: { dependency: "advisory" } }]);
    expect(gate.check("Agent", { dependency: "required" })).toContain("advisory");
    expect(gate.check("Agent", { dependency: "advisory" })).toBeNull();
    gate.recordToolResult("Agent", true);
    expect(gate.check("Glob")).toBeNull();
    expect(gate.check("Write")).toBeNull();
  });

  it("allows retained root reads in the same turn as a planned Agent call", () => {
    const gate = new RootDelegationGate("并行检查全部模块");
    gate.prepareTurn([
      { name: "Agent", input: { dependency: "advisory" } },
      { name: "Glob", input: {} },
      { name: "Read", input: {} },
    ]);

    expect(gate.check("Glob")).toBeNull();
    expect(gate.check("Read")).toBeNull();
    expect(gate.check("Bash")).toContain("delegation gate");

    gate.recordToolResult("Agent", false);
    gate.prepareTurn([{ name: "Bash", input: {} }]);
    expect(gate.check("Bash")).toContain("delegation gate");
  });

  it("resets the requirement for each new user request", () => {
    const gate = new RootDelegationGate("并行探索所有仓库");
    expect(gate.isRequired).toBe(true);
    gate.observeUserMessage("只读取这个文件");
    expect(gate.isRequired).toBe(false);
    expect(gate.check("Read")).toBeNull();
  });

  it("is enforced before a scoped tool handler executes", async () => {
    const handler = vi.fn(async () => ({ content: "should not execute" }));
    const tool: ToolDefinition = {
      name: "Glob",
      description: "glob",
      inputSchema: { type: "object", properties: {} },
      type: "read",
      requiresApproval: false,
      handler,
    };
    const permissions = {
      bash: "auto" as const,
      read: "auto" as const,
      write: "auto" as const,
      edit: "auto" as const,
      web: "auto" as const,
    };
    const gate = new RootDelegationGate("并行探索所有项目");
    gate.prepareTurn([{ name: "Glob", input: {} }]);
    const runtime = new ToolRuntime({
      securityRuntime: new SecurityRuntime(permissions),
      workingDir: process.cwd(),
      tools: [tool],
    });
    const result = await runtime.execute("Glob", {}, {
      workingDir: process.cwd(),
      sessionId: "gate",
      readGuard: {
        hasRead: () => false,
        markAsRead: () => {},
        serialize: () => ({ files: {} }),
      },
      permissionManager: { check: () => ({ allowed: true }) },
      config: {
        model: { provider: "test", model: "test" },
        permissions,
        embedding: { source: "local_hash" },
        mnemosyne: { bootstrap_on_first_open: false, bootstrap_max_files: 1 },
        session: { cleanupPeriodDays: 30 },
      },
      depth: 0,
      delegationGate: gate,
    } as AgentContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("delegation gate");
    expect(handler).not.toHaveBeenCalled();
  });

  it("marks limited Glob output as incomplete evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-glob-limit-"));
    try {
      fs.writeFileSync(path.join(root, "a.ts"), "a");
      fs.writeFileSync(path.join(root, "b.ts"), "b");
      const result = await globTool.handler({
        pattern: "**/*",
        path: root,
        max_results: 1,
        include_hidden: true,
      }, {
        workingDir: root,
        abortSignal: undefined,
      } as AgentContext);
      expect(result.content).toContain("(limited to 1)");
      expect(result.content).toContain("INCOMPLETE DISCOVERY");
      expect(result.content).toContain("partial sample");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
