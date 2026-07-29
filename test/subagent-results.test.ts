import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type {
  AgentConfig,
  AgentContext,
  SubagentDefinition,
} from "../src/shared/core-types.js";
import type { AgentEvent } from "../src/agent/loop.js";

const loopState = vi.hoisted(() => ({
  events: [] as AgentEvent[],
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/agent/loop.js", () => ({
  agentLoop: (options: Record<string, unknown>) => (async function* () {
    loopState.options.push(options);
    for (const event of loopState.events) yield event;
  })(),
}));

const config: AgentConfig = {
  model: { provider: "test", model: "test-model" },
  permissions: { bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto" },
  embedding: { source: "local_hash" },
  mnemosyne: { bootstrap_on_first_open: false, bootstrap_max_files: 100 },
  session: { cleanupPeriodDays: 30 },
};

const definition: SubagentDefinition = {
  name: "test",
  description: "test agent",
  systemPrompt: "complete the assigned test task",
  tools: ["*", "Write", "Bash"],
  readonly: false,
  canSpawn: true,
};

let artifactHome = "";
let sessionId = "";

function context(): AgentContext {
  return {
    workingDir: process.cwd(),
    sessionId,
    readGuard: {
      hasRead: () => false,
      markAsRead: () => {},
      serialize: () => ({ files: {} }),
    },
    permissionManager: { check: () => ({ allowed: true }) },
    config,
    depth: 0,
  };
}

beforeEach(() => {
  loopState.events = [];
  loopState.options = [];
  artifactHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-subagent-test-"));
  process.env.RUBATO_HOME = artifactHome;
  sessionId = `result-test-${Math.random().toString(16).slice(2)}`;
});

afterEach(async () => {
  const { processSubagentRegistry } = await import("../src/agent/subagents/registry.js");
  processSubagentRegistry.remove(sessionId, true);
  fs.rmSync(artifactHome, { recursive: true, force: true });
  delete process.env.RUBATO_HOME;
});

describe("managed subagent result delivery", () => {
  it("uses fresh role context and persists CompleteTask report/result/derived transcript", async () => {
    loopState.events = [
      { type: "turn_start", turn: 1 },
      { type: "text", text: "Searching the repository" },
      { type: "tool_call", id: "grep-1", name: "Grep", input: { pattern: "target" } },
      { type: "tool_result", id: "grep-1", name: "Grep", result: "found src/example.ts", isError: false },
      { type: "turn_end", turn: 1, usage: { input: 10, output: 2 } },
      {
        type: "task_completion",
        completion: {
          status: "completed",
          summary: "Found the implementation.",
          report_markdown: "# Findings\n\nEvidence: `src/example.ts`.",
          key_files: ["src/example.ts"],
        },
      },
      { type: "done", reason: "task_completion" },
    ];

    const { spawnSubagent } = await import("../src/agent/subagent.js");
    const result = await spawnSubagent(definition, "inspect the code", context(), config);

    expect(result.status).toBe("completed");
    expect(result.output).toContain("Evidence: `src/example.ts`");
    expect(loopState.options[0]).toMatchObject({
      roleSystemPrompt: "complete the assigned test task",
      contextProfile: "subagent",
      depth: 1,
    });
    expect(loopState.options[0]).not.toHaveProperty("messages");
    const toolNames = (loopState.options[0].tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(toolNames).toEqual(["CompleteTask"]);
    expect(fs.readFileSync(result.reportPath!, "utf8")).toContain("src/example.ts");
    expect(JSON.parse(fs.readFileSync(result.resultJsonPath!, "utf8"))).toMatchObject({
      status: "completed",
      summary: "Found the implementation.",
    });
    const transcript = fs.readFileSync(result.transcriptPath!, "utf8");
    expect(transcript).toContain("found src/example.ts");
    expect(transcript).not.toContain("thinking");
  });

  it("runs advisory work through the registry and acknowledges it when the legacy handle waits", async () => {
    loopState.events = [
      {
        type: "task_completion",
        completion: {
          status: "completed",
          summary: "Background evidence ready.",
          report_markdown: "# Background\n\nReady.",
        },
      },
      { type: "done", reason: "task_completion" },
    ];

    const { spawnSubagentInBackground } = await import("../src/agent/subagent.js");
    const handle = spawnSubagentInBackground(definition, "background task", context(), config);
    const result = await handle.wait();
    await Promise.resolve();

    expect(result.agentId).toBe(handle.agentId);
    expect(result.taskId).toBe(handle.taskId);
    expect(handle.status).toBe("completed");
    const { processSubagentRegistry } = await import("../src/agent/subagents/registry.js");
    const runtime = processSubagentRegistry.get(sessionId)!;
    expect(runtime.inbox.drain()).toEqual([]);
    const trace = fs.readFileSync(runtime.artifacts.tracePath, "utf8");
    expect(trace).toContain("background_notification_acknowledged");
  });

  it("keeps required Agent output bounded and points to full local artifacts", async () => {
    const longReport = `# Report\n\n${"x".repeat(35_000)}`;
    loopState.events = [
      {
        type: "task_completion",
        completion: {
          status: "completed",
          summary: "Large report complete.",
          report_markdown: longReport,
        },
      },
      { type: "done", reason: "task_completion" },
    ];

    const { agentTool } = await import("../src/tools/agent.js");
    const toolResult = await agentTool.handler({
      description: "large report",
      prompt: "produce a large report",
      subagent_type: "general",
      dependency: "required",
      isolation: "worktree",
    }, context());

    expect(toolResult.content.length).toBeLessThan(5_000);
    expect(toolResult.content).toContain("Report:");
    expect(toolResult.content).toContain("Result:");
    expect(toolResult.content).toContain("Worktree:");
    expect(toolResult.content).toContain("Branch: rubato/");
    expect(toolResult.content).toContain("Commits: (none)");
    const reportPath = toolResult.content.match(/Report: (.+report\.md)/)?.[1];
    expect(reportPath).toBeTruthy();
    expect(fs.readFileSync(reportPath!, "utf8")).toBe(longReport);
  });

  it("recovers accumulated notes and tool evidence when CompleteTask is still missing", async () => {
    loopState.events = [
      { type: "turn_start", turn: 1 },
      { type: "text", text: "Important finding: the entry point is src/index.ts.\n" },
      {
        type: "tool_call",
        id: "read-index",
        name: "Read",
        input: { file_path: path.join(process.cwd(), "package.json") },
      },
      {
        type: "tool_result",
        id: "read-index",
        name: "Read",
        result: "File: package.json (10 lines)\nimportant observable output",
        isError: false,
      },
      { type: "turn_end", turn: 1, usage: { input: 20, output: 3 } },
      { type: "completion_retry", attempt: 1 },
      { type: "turn_start", turn: 2 },
      { type: "text", text: "Now I will compile the final report." },
      { type: "turn_end", turn: 2, usage: { input: 25, output: 2 } },
      { type: "done", reason: "missing_task_completion" },
    ];

    const { spawnSubagent } = await import("../src/agent/subagent.js");
    const result = await spawnSubagent(definition, "inspect the entry point", context(), config);

    expect(result.status).toBe("partial");
    const report = fs.readFileSync(result.reportPath!, "utf8");
    expect(report).toContain("# Recovered partial subagent report");
    expect(report).toContain("Important finding: the entry point is src/index.ts.");
    expect(report).toContain("Now I will compile the final report.");
    expect(report).toContain("important observable output");
    expect(report).toContain("package.json");
    expect(report.length).toBeGreaterThan(300);
    expect(fs.existsSync(result.coveragePath!)).toBe(true);
    const trace = fs.readFileSync(result.transcriptPath!, "utf8");
    expect(trace).toContain("completion_retry_requested");
  });

  it("persists coverage and downgrades a false exhaustive completed result", async () => {
    const project = path.join(artifactHome, "coverage-project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(project, "b.ts"), "export const b = 2;\n");
    loopState.events = [
      {
        type: "tool_call",
        id: "glob-all",
        name: "Glob",
        input: { path: project, pattern: "**/*", include_hidden: true },
      },
      {
        type: "tool_result",
        id: "glob-all",
        name: "Glob",
        result: [
          `2 files matching "**/*" in ${project}:`,
          "",
          "     20B  a.ts",
          "     20B  b.ts",
        ].join("\n"),
        isError: false,
      },
      {
        type: "tool_call",
        id: "read-a",
        name: "Read",
        input: { file_path: path.join(project, "a.ts") },
      },
      {
        type: "tool_result",
        id: "read-a",
        name: "Read",
        result: "a.ts",
        isError: false,
      },
      {
        type: "task_completion",
        completion: {
          status: "completed",
          summary: "Every line was inspected.",
          report_markdown: "# Claimed complete",
          coverage: { exhaustive: true, scope_roots: [project] },
        },
      },
      { type: "done", reason: "task_completion" },
    ];

    const { spawnSubagent } = await import("../src/agent/subagent.js");
    const result = await spawnSubagent(
      definition,
      "Inspect every line of every source file.",
      { ...context(), workingDir: project },
      config,
    );

    expect(result.status).toBe("partial");
    expect(result.summary).toContain("downgraded");
    const coverage = JSON.parse(fs.readFileSync(result.coveragePath!, "utf8"));
    expect(coverage).toMatchObject({
      required: true,
      complete: false,
      gate_satisfied: false,
      discovered: 2,
      inspected: 1,
    });
    expect(fs.readFileSync(result.reportPath!, "utf8")).toContain("Runtime coverage gate");
  });
});
