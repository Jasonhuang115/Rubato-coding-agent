// Agent loop lifecycle tests — done events must follow finalization.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AgentConfig, ModelProvider, StreamRenderer } from "../src/shared/core-types.js";

const fakeProvider = vi.hoisted(() => ({
  name: "test",
  chat: vi.fn(),
  supportsPromptCaching: vi.fn(() => false),
  countTokens: vi.fn(async () => 1),
}));

const persistKnowledge = vi.hoisted(() => vi.fn(() => ({ saved: 0 })));
const getInjectedMemoriesForSession = vi.hoisted(() => vi.fn(() => []));
const markReferenced = vi.hoisted(() => vi.fn());
const markIgnoredForSession = vi.hoisted(() => vi.fn());
const autoTuneStrategyWeights = vi.hoisted(() => vi.fn());
const getPendingConsolidations = vi.hoisted(() => vi.fn(() => []));

vi.mock("../src/model/router.js", () => ({
  createProvider: () => fakeProvider,
}));

vi.mock("../src/runtime/context-assembler.js", () => ({
  assembleContext: vi.fn(async () => ({ systemPrompt: "system", systemTokens: 1 })),
}));

vi.mock("../src/memory/journal/extractor.js", () => ({
  persistKnowledge,
}));

vi.mock("../src/memory/store.js", () => ({
  getMnemosyneStore: vi.fn(() => ({
    getInjectedMemoriesForSession,
    markReferenced,
    markIgnoredForSession,
    autoTuneStrategyWeights,
    getPendingConsolidations,
  })),
}));

vi.mock("../src/tools/git/hooks.js", () => ({
  sessionEndHook: vi.fn(async () => ({ advice: [] })),
  prePushHook: vi.fn(async () => null),
  preCommitHook: vi.fn(async () => null),
}));

const renderer: StreamRenderer = {
  renderUserMessage: () => {},
  renderAssistantMessage: () => {},
  renderThinking: () => {},
  renderSystemMessage: () => {},
  renderToolUse: () => {},
  renderToolResult: () => {},
  renderError: () => {},
  renderWarning: () => {},
  clear: () => {},
  flush: () => {},
};

const config: AgentConfig = {
  model: { provider: "test", model: "test-model", baseURL: "http://example.invalid" },
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

describe("agentLoop lifecycle", () => {
  let previousHome: string | undefined;
  let homeDir: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-agent-loop-"));
    process.env.HOME = homeDir;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("finalizes interrupted sessions before emitting a single done event", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    fakeProvider.chat.mockImplementation(async function* () {
      throw abortError;
    });

    const updates: Array<{ id: string; updates: Record<string, unknown> }> = [];
    const sessionManager = {
      getProjectHash: () => "test-project",
      updateSession: (id: string, update: Record<string, unknown>) => {
        updates.push({ id, updates: update });
      },
    };

    const { agentLoop } = await import("../src/agent/loop.js");
    const events = [];

    for await (const event of agentLoop({
      config,
      workingDir: homeDir,
      prompt: "hello",
      renderer,
      tools: [],
      sessionId: "lifecycle-session",
      sessionManager: sessionManager as never,
      maxTurns: 1,
    })) {
      events.push(event);
    }

    const doneEvents = events.filter((event) => event.type === "done");
    expect(doneEvents).toEqual([{ type: "done", reason: "user_interrupt" }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: "lifecycle-session",
      updates: { status: "ended" },
    });
    expect(markIgnoredForSession).not.toHaveBeenCalled();
    expect(autoTuneStrategyWeights).toHaveBeenCalled();
    expect(persistKnowledge).toHaveBeenCalled();
  });

  it("resolves memory feedback after a successful assistant response", async () => {
    fakeProvider.chat.mockImplementation(async function* () {
      yield { type: "text_delta" as const, text: "A complete answer" };
      yield {
        type: "message_stop" as const,
        stopReason: "end_turn" as const,
        usage: { inputTokens: 1, outputTokens: 3 },
      };
    });

    const { agentLoop } = await import("../src/agent/loop.js");
    for await (const _event of agentLoop({
      config,
      workingDir: homeDir,
      prompt: "hello",
      renderer,
      tools: [],
      sessionId: "answered-session",
      maxTurns: 1,
    })) { /* consume */ }

    expect(getInjectedMemoriesForSession).toHaveBeenCalledWith("answered-session");
    expect(markIgnoredForSession).toHaveBeenCalledWith("answered-session");
    expect(autoTuneStrategyWeights).toHaveBeenCalled();
  });
});
