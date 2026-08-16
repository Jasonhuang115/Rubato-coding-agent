import { describe, expect, it, vi } from "vitest";
import { RootDelegationGate, requiresParallelDelegation } from "../src/agent/delegation-gate.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";
import { SecurityRuntime } from "../src/security/runtime.js";
import type { AgentContext, ToolDefinition } from "../src/shared/core-types.js";

describe("RootDelegationGate", () => {
  it("detects explicit parallel multi-scope requests only", () => {
    expect(requiresParallelDelegation("并行探索目录下所有项目")).toBe(true);
    expect(requiresParallelDelegation("Analyze all repositories concurrently")).toBe(true);
    expect(requiresParallelDelegation("探索一下这个项目")).toBe(false);
  });

  it("blocks substantive work until a background dispatch succeeds", () => {
    const gate = new RootDelegationGate("并行检查全部模块");
    gate.prepareTurn([{ name: "Glob", input: {} }]);
    expect(gate.check("TodoWrite", {})).toBeNull();
    expect(gate.check("Glob", {})).toContain("delegation gate");
    gate.prepareTurn([{ name: "Subagent", input: {} }, { name: "Read", input: {} }]);
    expect(gate.check("Subagent", {})).toBeNull();
    expect(gate.check("Read", {})).toBeNull();
    expect(gate.check("Bash", {})).toContain("delegation gate");
    gate.recordToolResult("Subagent", true);
    expect(gate.check("Bash", {})).toBeNull();
  });

  it("resets for each user request", () => {
    const gate = new RootDelegationGate("并行探索所有仓库");
    expect(gate.isRequired).toBe(true);
    gate.observeUserMessage("只读取这个文件");
    expect(gate.isRequired).toBe(false);
  });

  it("runs before a scoped handler", async () => {
    const handler = vi.fn(async () => ({ content: "bad" }));
    const tool: ToolDefinition = {
      name: "Glob",
      description: "glob",
      inputSchema: { type: "object", properties: {} },
      type: "read",
      requiresApproval: false,
      handler,
    };
    const permissions = {
      bash: "auto" as const, read: "auto" as const, write: "auto" as const,
      edit: "auto" as const, web: "auto" as const,
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
      readGuard: { hasRead: () => false, markAsRead: () => {}, serialize: () => ({ files: {} }) },
      permissionManager: { check: () => ({ allowed: true }) },
      config: { model: { provider: "test", model: "test" }, permissions, session: { cleanupPeriodDays: 30 } },
      mode: "default",
      depth: 0,
      delegationGate: gate,
    } as AgentContext);
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});
