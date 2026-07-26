import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AgentContext, SubagentDefinition, ToolDefinition } from "../src/shared/core-types.js";
import { clear, register } from "../src/tools/registry.js";
import {
  getBuiltinDefinition,
  resolveSubagentTools,
} from "../src/agent/subagent.js";
import { completeTaskTool } from "../src/tools/complete-task.js";
import { SecurityRuntime } from "../src/security/runtime.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

function tool(name: string, type: "read" | "write"): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    type,
    async handler() { return { content: "ok" }; },
  };
}

beforeEach(() => {
  clear();
  for (const definition of [
    tool("Read", "read"),
    tool("Grep", "read"),
    tool("Glob", "read"),
    tool("WebFetch", "read"),
    tool("WebSearch", "read"),
    tool("Agent", "read"),
    tool("Write", "write"),
    tool("Edit", "write"),
    tool("Bash", "write"),
    tool("Skill", "write"),
  ]) register(definition);
});

describe("subagent capability boundary", () => {
  it("does not let wildcard or legacy write declarations escape the allowlist", () => {
    const custom: SubagentDefinition = {
      name: "legacy-custom",
      description: "legacy",
      systemPrompt: "legacy",
      tools: ["*", "Write", "Edit", "Bash", "Skill", "Agent"],
      readonly: false,
      canSpawn: true,
    };
    expect(resolveSubagentTools(custom, 1).map((item) => item.name))
      .toEqual(["Read", "Grep", "Glob", "CompleteTask"]);
  });

  it("grants recursive Agent only to General below the depth limit", () => {
    expect(resolveSubagentTools(getBuiltinDefinition("general"), 1, 3).map((item) => item.name))
      .toContain("Agent");
    expect(resolveSubagentTools(getBuiltinDefinition("general"), 3, 3).map((item) => item.name))
      .not.toContain("Agent");
    expect(resolveSubagentTools(getBuiltinDefinition("explore"), 1, 3).map((item) => item.name))
      .toEqual(["Read", "Grep", "Glob", "CompleteTask"]);
  });

  it("rejects a hallucinated write tool at the scoped runtime boundary", async () => {
    const permissions = {
      bash: "auto" as const,
      read: "auto" as const,
      write: "auto" as const,
      edit: "auto" as const,
      web: "auto" as const,
    };
    const runtime = new ToolRuntime({
      securityRuntime: new SecurityRuntime(permissions),
      workingDir: process.cwd(),
      tools: [tool("Read", "read"), completeTaskTool],
    });
    const result = await runtime.execute("Write", {
      file_path: "forbidden.txt",
      content: "no",
    }, {
      workingDir: process.cwd(),
      taskRuntime: {
        rootSessionId: "root",
        taskId: "task",
        agentId: "agent",
        depth: 1,
        completionSubmitted: false,
      },
      config: {
        model: { provider: "test", model: "test" },
        permissions,
        embedding: { source: "local_hash" },
        mnemosyne: { bootstrap_on_first_open: false, bootstrap_max_files: 1 },
        session: { cleanupPeriodDays: 30 },
      },
    } as AgentContext);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
    expect(fs.existsSync(path.join(process.cwd(), "forbidden.txt"))).toBe(false);
  });

  it("accepts CompleteTask once and emits a control signal", async () => {
    const runtime = {
      rootSessionId: "root",
      taskId: "task",
      agentId: "agent",
      depth: 1,
      completionSubmitted: false,
    };
    const ctx = {
      taskRuntime: runtime,
    } as unknown as AgentContext;
    const input = {
      status: "completed",
      summary: "done",
      report_markdown: "# Done",
    };
    const first = await completeTaskTool.handler(input, ctx);
    const second = await completeTaskTool.handler(input, ctx);

    expect(first.control).toEqual({
      type: "task_completion",
      completion: input,
    });
    expect(second.isError).toBe(true);
    expect(second.content).toContain("already");
  });

  it("strips unsafe custom-agent declarations at load time and warns", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-custom-agent-"));
    const agentsDir = path.join(project, ".rubato", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "unsafe.md"), [
      "---",
      "name: unsafe",
      "description: legacy writer",
      "tools: [Read, Write, Bash, Agent]",
      "readonly: false",
      "canSpawn: true",
      "---",
      "Inspect the project.",
    ].join("\n"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { loadCustomDefinitions } = await import("../src/agent/agent-defs.js");
      const [loaded] = loadCustomDefinitions(project);
      expect(loaded.tools).toEqual(["Read"]);
      expect(loaded.readonly).toBe(true);
      expect(loaded.canSpawn).toBe(false);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("Removed: Write, Bash, Agent"));
    } finally {
      warning.mockRestore();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
