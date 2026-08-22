import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkAndCompact,
  wouldCompact,
} from "../src/runtime/compaction-controller.js";
import {
  getCompactionBudget,
  resolveWorkingContextWindow,
} from "../src/runtime/model-windows.js";
import { compactCutFrom } from "../src/context/compression.js";
import {
  applyToolResultActions,
  collectToolResultEntries,
  heuristicToolResultActions,
  shrinkOldestKeptTurn,
} from "../src/context/layered-compact.js";
import { microCompactBeforeRequest } from "../src/context/micro-compact.js";
import { extractOffloadPath, offloadIfLarge } from "../src/context/tool-result-offload.js";
import type {
  AgentConfig,
  AgentContext,
  Message,
  ModelProvider,
  ReadGuardState,
} from "../src/shared/core-types.js";

const originalHome = process.env.RUBATO_HOME;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-layered-"));
  process.env.RUBATO_HOME = tmpRoot;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.RUBATO_HOME;
  else process.env.RUBATO_HOME = originalHome;
});

function config(overrides: Partial<AgentConfig["model"]> = {}): AgentConfig {
  return {
    model: {
      provider: "test",
      model: "gpt-4o",
      ...overrides,
    },
    permissions: { bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto" },
    session: { cleanupPeriodDays: 30 },
  };
}

function readGuard(): ReadGuardState {
  return {
    hasRead: () => false,
    markAsRead: () => {},
    serialize: () => ({ files: {} }),
  };
}

function ctx(cfg: AgentConfig): AgentContext {
  return {
    workingDir: tmpRoot,
    projectId: "a".repeat(64),
    sessionId: "session-compact",
    readGuard: readGuard(),
    permissionManager: { check: () => ({ allowed: true }) },
    config: cfg,
    mode: "default",
    depth: 0,
  };
}

function summaryProvider(pass2Json?: string, failSummary = false): ModelProvider {
  return {
    name: "test",
    supportsPromptCaching: () => false,
    countTokens: async () => 1,
    async *chat(params) {
      const system = params.system;
      if (system.includes("compressing a coding-agent")) {
        if (failSummary) throw new Error("summarizer down");
        yield { type: "text_delta" as const, text: "<summary>Prior work on the repo.</summary>" };
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 10, outputTokens: 10 },
        };
        return;
      }
      if (system.includes("shrink recent tool results")) {
        yield {
          type: "text_delta" as const,
          text: pass2Json ?? '{"decisions":[]}',
        };
        yield {
          type: "message_stop" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 5, outputTokens: 5 },
        };
        return;
      }
      throw new Error(`unexpected compact call: ${system.slice(0, 80)}`);
    },
  };
}

function userTurn(text: string, toolBody?: string, index = 0): Message[] {
  const messages: Message[] = [{ role: "user", content: text }];
  if (toolBody !== undefined) {
    messages.push({
      role: "assistant",
      content: [{
        type: "tool_use",
        id: `t-${index}`,
        name: "Read",
        input: { file_path: `/tmp/f-${index}.ts` },
      }],
    });
    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: `t-${index}`,
        content: toolBody,
      }],
    });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `looked at file ${index}` }],
    });
  } else {
    messages.push({ role: "assistant", content: `ok ${text.slice(0, 20)}` });
  }
  return messages;
}

describe("working window table", () => {
  it("matches dated prefixes for Sol and Opus 5", () => {
    expect(resolveWorkingContextWindow("gpt-5.6-sol-2026-03-01").tokens).toBe(272_000);
    expect(resolveWorkingContextWindow("claude-opus-5-preview").tokens).toBe(1_000_000);
    expect(resolveWorkingContextWindow("gpt-5.6-sol-2026-03-01").tokens)
      .not.toBe(resolveWorkingContextWindow("claude-opus-5-preview").tokens);
  });

  it("does not silently treat unknown models as 128k", () => {
    const resolved = resolveWorkingContextWindow("mystery-model-xyz");
    expect(resolved.tokens).toBeNull();
    expect(resolved.warning).toMatch(/contextWindow/);
    expect(wouldCompact({
      messages: [{ role: "user", content: "x".repeat(50_000) }],
      systemTokens: 1_100,
      model: "mystery-model-xyz",
    })).toBe(false);
  });

  it("honors model.contextWindow overrides", () => {
    expect(resolveWorkingContextWindow("mystery-model-xyz", 50_000).tokens).toBe(50_000);
    expect(getCompactionBudget({ model: "gpt-4o", contextWindow: 64_000 }).window).toBe(64_000);
  });
});

describe("turn-based cut", () => {
  it("keeps the last 10 user turns rather than 60 messages", () => {
    const messages = Array.from({ length: 16 }, (_, i) => userTurn(`turn ${i}`, `body ${i}`, i)).flat();
    const cut = compactCutFrom(messages, 10);
    expect(cut).toBeGreaterThan(0);
    const kept = messages.slice(cut);
    const keptTurns = kept.filter((m) => m.role === "user" && typeof m.content === "string").length;
    expect(keptTurns).toBe(10);
  });
});

describe("layered compaction", () => {
  it("fails closed when the system prompt leaves no conversation room", async () => {
    const cfg = config({ contextWindow: 40_000, maxTokens: 4_000 });
    const result = await checkAndCompact({
      messages: [{ role: "user", content: "hello" }],
      systemTokens: 50_000,
      model: cfg.model.model,
      ctx: ctx(cfg),
      config: cfg,
      provider: summaryProvider(),
      readGuard: readGuard(),
      consecutiveFailures: 0,
    });
    expect(result.outcome).toBe("unrecoverable");
    expect(result.unrecoverableCode).toBe("system_too_large");
    expect(result.compacted).toBe(false);
    expect(result.reason).toMatch(/System prompt is unexpectedly large/);
  });

  it("offloads combined-fat recent tool results that never hit the ingest threshold", async () => {
    const cfg = config({ contextWindow: 40_000, maxTokens: 4_000 });
    const medium = `tool-${"n".repeat(12_000)}`;
    expect(medium.length).toBeLessThan(30_000);
    const messages = Array.from({ length: 12 }, (_, i) =>
      userTurn(`please read file ${i}`, medium, i),
    ).flat();

    expect(wouldCompact({
      messages,
      systemTokens: 1_100,
      model: cfg.model.model,
      contextWindow: cfg.model.contextWindow,
      maxTokens: cfg.model.maxTokens,
    })).toBe(true);

    const ids = collectToolResultEntries(messages).map((e) => e.toolUseId);
    const pass2 = `{"decisions":${JSON.stringify(ids.map((id) => ({ id, action: "offload" })))}}`;
    const result = await checkAndCompact({
      messages,
      systemTokens: 1_100,
      model: cfg.model.model,
      ctx: ctx(cfg),
      config: cfg,
      provider: summaryProvider(pass2),
      readGuard: readGuard(),
      consecutiveFailures: 0,
    });

    expect(result.outcome).toBe("ok");
    expect(result.compacted).toBe(true);
    const bodies = JSON.stringify(result.messages);
    expect(bodies).toMatch(/offloaded to /);
  });

  it("stops when long user pastes still overflow after shrinking to one turn", async () => {
    const cfg = config({ contextWindow: 16_000, maxTokens: 2_000 });
    const hugeUser = "paste\n" + "x".repeat(20_000);
    const messages = Array.from({ length: 12 }, (_, i) => userTurn(`${hugeUser} ${i}`)).flat();
    const result = await checkAndCompact({
      messages,
      systemTokens: 1_100,
      model: cfg.model.model,
      ctx: ctx(cfg),
      config: cfg,
      provider: summaryProvider(undefined, true),
      readGuard: readGuard(),
      consecutiveFailures: 0,
    });
    expect(result.outcome).toBe("unrecoverable");
    expect(result.unrecoverableCode).toBe("occupancy");
    expect(result.reason).toMatch(/Start a new conversation with \/clear/);
    expect(result.handoff?.sessionId).toBe("session-compact");
    expect(result.modelCallFailed).toBe(true);
    expect(result.disableAutoCompact).toBe(false);
  });

  it("does not disable auto-compaction for occupancy stops", async () => {
    const cfg = config({ contextWindow: 16_000, maxTokens: 2_000 });
    const hugeUser = "paste\n" + "y".repeat(20_000);
    const messages = Array.from({ length: 12 }, (_, i) => userTurn(`${hugeUser} ${i}`)).flat();
    const result = await checkAndCompact({
      messages,
      systemTokens: 1_100,
      model: cfg.model.model,
      ctx: ctx(cfg),
      config: cfg,
      provider: summaryProvider(),
      readGuard: readGuard(),
      consecutiveFailures: 2,
    });
    expect(result.outcome).toBe("unrecoverable");
    expect(result.disableAutoCompact).toBe(false);
    expect(result.modelCallFailed).toBe(false);
  });

  it("compacts against the smaller window after a model switch", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      userTurn(`turn ${i}`, "n".repeat(20_000), i),
    ).flat();
    expect(wouldCompact({
      messages,
      systemTokens: 1_100,
      model: "claude-opus-5-preview",
    })).toBe(false);
    expect(wouldCompact({
      messages,
      systemTokens: 1_100,
      model: "gpt-4o",
    })).toBe(true);
  });
});

describe("micro-compact offload paths", () => {
  it("keeps the offload path when clearing a stale tool result", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "off-"));
    const content = "z".repeat(31_000);
    const preview = offloadIfLarge(content, "Read", undefined, dir);
    const offPath = extractOffloadPath(preview);
    const messages: Message[] = Array.from({ length: 14 }, (_, index) => [
      {
        role: "assistant" as const,
        content: [{
          type: "tool_use" as const,
          id: `read-${index}`,
          name: "Read",
          input: { file_path: `/project/file-${index}.ts` },
        }],
      },
      {
        role: "user" as const,
        content: [{
          type: "tool_result" as const,
          tool_use_id: `read-${index}`,
          content: index === 0 ? preview : `full source ${index}`,
        }],
      },
    ]).flat();

    const compacted = microCompactBeforeRequest(messages);
    expect(compacted.cleared).toBeGreaterThan(0);
    const first = compacted.messages.find((m) =>
      typeof m.content !== "string" &&
      m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "read-0"),
    );
    expect(JSON.stringify(first)).toContain(offPath);
    expect(JSON.stringify(first)).toContain("full output at");
  });
});

describe("heuristic pass-2 and shrink helpers", () => {
  it("offloads large live results and shrinks extra turns", () => {
    const entries = collectToolResultEntries(userTurn("go", "n".repeat(12_000), 0));
    const actions = heuristicToolResultActions(entries);
    expect(actions.get("t-0")).toBe("offload");
    const dir = fs.mkdtempSync(path.join(tmpRoot, "p2-"));
    const applied = applyToolResultActions(
      userTurn("go", "n".repeat(12_000), 0),
      actions,
      dir,
    );
    expect(JSON.stringify(applied)).toMatch(/offloaded to /);

    const many = Array.from({ length: 3 }, (_, i) => userTurn(`u${i}`)).flat();
    const shrunk = shrinkOldestKeptTurn(many);
    expect(shrunk.length).toBeLessThan(many.length);
  });
});
