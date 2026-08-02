import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentModeController } from "../src/agent/mode.js";
import { PromptAssembler } from "../src/prompt/assembler.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";
import { SecurityRuntime } from "../src/security/runtime.js";
import type { AgentContext, ToolDefinition } from "../src/shared/core-types.js";
import { PLAN_TOOL_NAMES } from "../src/tools/registry.js";
import { submitPlanTool, planFilePath } from "../src/tools/submit-plan.js";
import { agentTool } from "../src/tools/agent.js";
import { taskTool } from "../src/tools/task.js";

const originalRubatoHome = process.env.RUBATO_HOME;
afterEach(() => {
  if (originalRubatoHome === undefined) delete process.env.RUBATO_HOME;
  else process.env.RUBATO_HOME = originalRubatoHome;
});

function context(workingDir: string, mode: "default" | "plan" = "plan"): AgentContext {
  const permissions = {
    bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto",
  } as const;
  const security = new SecurityRuntime(permissions as any);
  return {
    workingDir,
    sessionId: "session/one",
    mode,
    readGuard: { hasRead: () => true, markAsRead: () => {}, serialize: () => ({ files: {} }) },
    permissionManager: security.policyEngine,
    config: {
      model: { provider: "deepseek", model: "deepseek-chat" },
      permissions,
    } as any,
    depth: 0,
  };
}

describe("Plan mode state and prompt", () => {
  it("switches explicitly and transforms approval into trusted default-mode execution context", () => {
    const controller = new AgentModeController();
    controller.enablePlan();
    expect(controller.mode).toBe("plan");
    controller.markReady({ type: "plan_ready", title: "T", markdown: "# Plan\n\nDo it.", path: "/p.md" });
    expect(controller.phase).toBe("awaiting_approval");

    const approved = controller.transformUserInput("按计划执行");
    expect(approved.event).toBe("approved");
    expect(approved.modelMessage).toContain("# Plan");
    expect(controller.mode).toBe("default");
    expect(controller.phase).toBe("planning");
  });

  it("keeps revision feedback in Plan mode and /off semantics never approve", () => {
    const controller = new AgentModeController();
    controller.enablePlan();
    controller.markReady({ type: "plan_ready", title: "T", markdown: "# Old", path: "/p.md" });
    expect(controller.transformUserInput("把验收标准补全").event).toBe("revision_requested");
    expect(controller.mode).toBe("plan");
    controller.disablePlan();
    expect(controller.mode).toBe("default");
  });

  it("uses the research-first, one-question, Markdown-only Plan profile", () => {
    const ctx = context("/workspace");
    const tools = [...PLAN_TOOL_NAMES].map((name) => ({ name } as ToolDefinition));
    const layers = new PromptAssembler().assemble(ctx, tools);
    expect(layers.static).toContain("Investigate the repository");
    expect(layers.static).toContain("exactly one focused question");
    expect(layers.static).toContain("recommended answer");
    expect(layers.static).toContain("Every response must be Markdown");
    expect(layers.static.toLowerCase()).toContain("do not implement");
    expect(layers.static).toContain("SubmitPlan");
    expect(layers.capability).toBe("");
    expect(layers.dynamic).toBe("");
  });

  it("defines the exact public Plan tool allowlist", () => {
    expect([...PLAN_TOOL_NAMES].sort()).toEqual([
      "Agent", "Glob", "Grep", "Read", "SubmitPlan", "Task", "WebFetch", "WebSearch",
    ]);
  });
});

describe("Plan mode runtime enforcement", () => {
  it.each(["Write", "Edit", "Bash", "TodoWrite", "Skill", "MemoryPropose", "McpDynamic"])(
    "blocks a forged %s call before its handler runs",
    async (name) => {
      let ran = false;
      const tool: ToolDefinition = {
        name,
        description: "forged",
        inputSchema: { type: "object", properties: {} },
        type: "write",
        handler: async () => { ran = true; return { content: "bad" }; },
      };
      const ctx = context("/tmp");
      const runtime = new ToolRuntime({
        securityRuntime: new SecurityRuntime(ctx.config.permissions),
        workingDir: ctx.workingDir,
        tools: [tool],
      });
      const result = await runtime.execute(name, {}, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Plan mode blocked");
      expect(ran).toBe(false);
    },
  );

  it("rejects worker and worktree subagents", async () => {
    const ctx = context("/tmp");
    const worker = await agentTool.handler({
      description: "write", prompt: "change code", dependency: "required", subagent_type: "worker",
    }, ctx);
    expect(worker.isError).toBe(true);
    const worktree = await agentTool.handler({
      description: "inspect", prompt: "inspect", dependency: "required", subagent_type: "explore", isolation: "worktree",
    }, ctx);
    expect(worktree.isError).toBe(true);
  });

  it("allows only non-mutating Task actions", async () => {
    const ctx = context("/tmp");
    const cleanup = await taskTool.handler({ action: "cleanup", task_id: "x" }, ctx);
    expect(cleanup.isError).toBe(true);
    expect(cleanup.content).toContain("blocked in Plan mode");
  });
});

describe("SubmitPlan persistence", () => {
  it("writes only to the project-hashed private plan path and atomically revises it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-plan-home-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-plan-workspace-"));
    process.env.RUBATO_HOME = root;
    try {
      const before = fs.readdirSync(workspace);
      const ctx = context(workspace);
      const first = await submitPlanTool.handler({ title: "First", markdown: "# First\n\nOne." }, ctx);
      expect(first.control?.type).toBe("plan_ready");
      const target = planFilePath(workspace, ctx.sessionId);
      expect(target).toMatch(/projects\/[a-f0-9]{64}\/plans\/plan-session_one\.md$/);
      expect(fs.readFileSync(target, "utf8")).toBe("# First\n\nOne.");

      await submitPlanTool.handler({ title: "Second", markdown: "# Second\n\nTwo." }, ctx);
      expect(fs.readFileSync(target, "utf8")).toBe("# Second\n\nTwo.");
      expect(fs.readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
      expect(fs.readdirSync(workspace)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects submission outside Plan mode", async () => {
    const result = await submitPlanTool.handler({ title: "T", markdown: "# P" }, context("/tmp", "default"));
    expect(result.isError).toBe(true);
  });
});
