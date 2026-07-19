import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import type {
  AgentConfig,
  AgentContext,
  AgentEvent,
  SubagentDefinition,
} from "../src/shared/core-types.js";

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

vi.mock("../src/runtime/session/storage.js", () => ({
  SessionStore: class {
    init() {}
    append() {}
    close() {}
  },
}));

vi.mock("../src/memory/store.js", () => ({
  getMnemosyneStore: () => ({
    searchWithRelevance: () => [],
    recordFeedback: () => {},
  }),
}));

const config: AgentConfig = {
  model: { provider: "test", model: "test-model" },
  permissions: {
    bash: "auto",
    read: "auto",
    write: "auto",
    edit: "auto",
    web: "auto",
  },
  embedding: { source: "local_onnx" },
  mnemosyne: { bootstrap_on_first_open: false, bootstrap_max_files: 100 },
  session: { cleanupPeriodDays: 30 },
};

const context: AgentContext = {
  workingDir: process.cwd(),
  sessionId: "result-test",
  readGuard: {
    hasRead: () => false,
    markAsRead: () => {},
    serialize: () => ({ files: {} }),
  },
  permissionManager: { check: () => ({ allowed: true }) },
  config,
  depth: 0,
};

const definition: SubagentDefinition = {
  name: "test",
  description: "test agent",
  systemPrompt: "complete the task",
  tools: [],
  readonly: true,
};

const artifactPaths = new Set<string>();

function trackArtifacts(result: { resultPath?: string; transcriptPath?: string }): void {
  if (result.resultPath) artifactPaths.add(result.resultPath);
  if (result.transcriptPath) artifactPaths.add(result.transcriptPath);
}

beforeEach(() => {
  loopState.events = [];
  loopState.options = [];
});

afterEach(() => {
  for (const artifactPath of artifactPaths) {
    fs.rmSync(artifactPath, { force: true });
  }
  artifactPaths.clear();
});

describe("subagent result delivery", () => {
  it("returns only the final turn and stores the earlier work in a transcript", async () => {
    loopState.events = [
      { type: "turn_start", turn: 1 },
      { type: "text", text: "Searching the repository" },
      { type: "tool_result", name: "Grep", result: "found src/example.ts", isError: false },
      { type: "turn_end", turn: 1, usage: { input: 10, output: 2 } },
      { type: "turn_start", turn: 2 },
      { type: "text", text: "Final answer with evidence" },
      { type: "turn_end", turn: 2, usage: { input: 12, output: 4 } },
      { type: "done", reason: "end_turn" },
    ];

    const { spawnSubagent } = await import("../src/agent/subagent.js");
    const result = await spawnSubagent(definition, "inspect the code", context, config, {
      agentId: "result-test-sub-final",
    });
    trackArtifacts(result);

    expect(result.output).toBe("Final answer with evidence");
    expect(loopState.options[0].maxTurns).toBe(Number.POSITIVE_INFINITY);
    expect(loopState.options[0].skipCompaction).toBeUndefined();
    expect(result.resultPath).toBe("/tmp/rubato-subagent-result-test-sub-final.md");
    expect(result.transcriptPath).toBe("/tmp/rubato-subagent-result-test-sub-final.transcript.md");

    const report = fs.readFileSync(result.resultPath!, "utf-8");
    const transcript = fs.readFileSync(result.transcriptPath!, "utf-8");
    expect(report).toContain("Final answer with evidence");
    expect(report).not.toContain("Searching the repository");
    expect(transcript).toContain("Searching the repository");
    expect(transcript).toContain("found src/example.ts");
    expect(transcript).toContain("Final answer with evidence");
  });

  it("uses the handle ID for the background run and its result file", async () => {
    loopState.events = [
      { type: "turn_start", turn: 1 },
      { type: "text", text: "Background result" },
      { type: "turn_end", turn: 1, usage: { input: 5, output: 2 } },
      { type: "done", reason: "end_turn" },
    ];

    const { spawnSubagentInBackground } = await import("../src/agent/subagent.js");
    const handle = spawnSubagentInBackground(definition, "background task", context, config);
    const result = await handle.wait();
    trackArtifacts(result);

    expect(result.agentId).toBe(handle.agentId);
    expect(result.resultPath).toBe(`/tmp/rubato-subagent-${handle.agentId}.md`);
    expect(fs.readFileSync(result.resultPath!, "utf-8")).toContain(`**Agent ID:** ${handle.agentId}`);
    expect(handle.status).toBe("completed");
  });

  it("keeps the synchronous Agent tool result small and points to the full report", async () => {
    const longReport = "x".repeat(35_000);
    loopState.events = [
      { type: "turn_start", turn: 1 },
      { type: "text", text: longReport },
      { type: "turn_end", turn: 1, usage: { input: 5, output: 9_000 } },
      { type: "done", reason: "end_turn" },
    ];

    const { agentTool } = await import("../src/tools/agent.js");
    const toolResult = await agentTool.handler({
      description: "large report",
      prompt: "produce a large report",
      subagent_type: "general",
    }, context);

    const match = toolResult.content.match(/\*\*Full report:\*\* (\/tmp\/rubato-subagent-[^\n]+\.md)/);
    expect(match).not.toBeNull();
    artifactPaths.add(match![1]);
    artifactPaths.add(match![1].replace(/\.md$/, ".transcript.md"));
    expect(toolResult.content.length).toBeLessThan(5_000);
    expect(toolResult.content).toContain("... [full report:");
    expect(fs.readFileSync(match![1], "utf-8")).toContain(longReport);
  });
});
