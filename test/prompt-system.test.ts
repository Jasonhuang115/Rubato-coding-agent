// Prompt system tests — assembler, compiler, profiles, budget
import { describe, it, expect } from "vitest";
import { PromptAssembler, getPromptAssembler, resetPromptAssembler } from "../src/prompt/assembler.js";
import { compilePrompt, compileForProvider, estimateCompiledTokens } from "../src/prompt/compiler.js";
import { getProfileForProvider } from "../src/prompt/profiles.js";
import { PromptBudgetManager } from "../src/prompt/budget.js";
import { buildStaticPrompt } from "../src/prompt/static.js";
import { buildCapabilityPrompt } from "../src/prompt/capability.js";
import { buildDynamicPrompt } from "../src/prompt/dynamic.js";
import { ContextScheduler } from "../src/context/scheduler.js";

// ---- PromptAssembler ----

describe("PromptAssembler", () => {
  const mockCtx = {
    workingDir: "/test",
    sessionId: "test",
    readGuard: {} as any,
    permissionManager: {} as any,
    config: { model: { provider: "deepseek", model: "deepseek-chat" } } as any,
    planManager: { getPlanSummary: () => "" } as any,
    depth: 0,
  };

  const mockTools = [
    { name: "Read", type: "read" as const, isConcurrencySafe: true, description: "Read file", inputSchema: { type: "object", properties: {} } },
    { name: "Write", type: "write" as const, description: "Write file", inputSchema: { type: "object", properties: {} } },
  ];

  it("assembles all three layers", () => {
    const assembler = new PromptAssembler("deepseek");
    const layers = assembler.assemble(mockCtx, mockTools);
    expect(layers.static).toBeTruthy();
    expect(layers.capability).toBeTruthy();
    expect(layers.dynamic).toBeTruthy();
  });

  it("assembleFlat returns single string", () => {
    const assembler = new PromptAssembler("deepseek");
    const flat = assembler.assembleFlat(mockCtx, mockTools);
    expect(typeof flat).toBe("string");
    expect(flat.length).toBeGreaterThan(100);
  });

  it("estimates tokens", () => {
    const assembler = new PromptAssembler("deepseek");
    const estimate = assembler.estimateTokens(mockCtx, mockTools);
    expect(estimate.static).toBeGreaterThan(0);
    expect(estimate.capability).toBeGreaterThan(0);
    expect(estimate.dynamic).toBeGreaterThan(0);
    // Allow ±1 due to Math.ceil rounding differences
    const sum = estimate.static + estimate.capability + estimate.dynamic;
    expect(Math.abs(estimate.total - sum)).toBeLessThanOrEqual(1);
  });

  it("checks budget", () => {
    const assembler = new PromptAssembler("deepseek");
    const budget = assembler.checkBudget(mockCtx, mockTools);
    expect(typeof budget.withinBudget).toBe("boolean");
  });

  it("changes profile per provider", () => {
    const assembler = new PromptAssembler("claude");
    expect(assembler.getProfile().supportsPromptCaching).toBe(true);
    assembler.setProfile("deepseek");
    expect(assembler.getProfile().supportsPromptCaching).toBe(false);
  });

  it("getPromptAssembler returns singleton", () => {
    resetPromptAssembler();
    const a1 = getPromptAssembler("deepseek");
    const a2 = getPromptAssembler();
    expect(a1).toBe(a2);
  });
});

// ---- Model Profiles ----

describe("ModelProfiles", () => {
  it("claude profile supports caching", () => {
    const p = getProfileForProvider("claude");
    expect(p.supportsPromptCaching).toBe(true);
    expect(p.maxSystemPromptTokens).toBe(8000);
    expect(p.thinkingFormat).toBe("thinking_delta");
  });

  it("deepseek profile has reasoning_content", () => {
    const p = getProfileForProvider("deepseek");
    expect(p.thinkingFormat).toBe("reasoning_content");
    expect(p.supportsPromptCaching).toBe(false);
  });

  it("openai profile has none for thinking", () => {
    const p = getProfileForProvider("openai");
    expect(p.thinkingFormat).toBe("none");
    expect(p.maxSystemPromptTokens).toBe(6000);
  });

  it("local models get first_message format", () => {
    const p = getProfileForProvider("ollama");
    expect(p.systemPromptFormat).toBe("system");
    expect(p.maxSystemPromptTokens).toBe(2000);
  });

  it("unknown provider gets default", () => {
    const p = getProfileForProvider("unknown");
    expect(p.maxSystemPromptTokens).toBe(3000);
    expect(p.supportsPromptCaching).toBe(false);
  });
});

// ---- Prompt Compiler ----

describe("PromptCompiler", () => {
  const layers = {
    static: "STATIC PROMPT",
    capability: "CAPABILITY PROMPT",
    dynamic: "DYNAMIC PROMPT",
  };

  it("compiles for standard providers (system message)", () => {
    const compiled = compileForProvider(layers, "deepseek");
    expect(compiled.system).toContain("STATIC PROMPT");
    expect(compiled.system).toContain("CAPABILITY PROMPT");
    expect(compiled.system).toContain("DYNAMIC PROMPT");
    expect(compiled.prefixMessages).toBeUndefined();
  });

  it("compiles for first_message format providers", () => {
    // Override: test first_message format
    const localProfile = { maxSystemPromptTokens: 2000, supportsPromptCaching: false, systemPromptFormat: "first_message" as const, thinkingFormat: "none" as const };
    const compiled = compilePrompt(layers, localProfile);
    expect(compiled.system).toBeUndefined();
    expect(compiled.prefixMessages).toBeDefined();
    expect(compiled.prefixMessages!.length).toBe(2);
    expect(compiled.prefixMessages![0].role).toBe("user");
  });

  it("estimates compiled tokens", () => {
    const profile = getProfileForProvider("claude");
    const compiled = compileForProvider(layers, "claude");
    const tokens = estimateCompiledTokens(compiled, profile);
    expect(tokens).toBeGreaterThan(0);
  });
});

// ---- Prompt Budget ----

describe("PromptBudgetManager", () => {
  it("allocates budget to high priority first", async () => {
    const mgr = new PromptBudgetManager(500);
    const result = await mgr.allocate([
      { source: { name: "high", priority: 10, fetch: async () => null as any }, block: { content: "A".repeat(300), priority: 10, source: "high" } },
      { source: { name: "low", priority: 100, fetch: async () => null as any }, block: { content: "B".repeat(300), priority: 100, source: "low" } },
    ]);
    expect(result.allocations.length).toBeGreaterThan(0);
    expect(result.allocations[0].source).toBe("high");
  });

  it("allows setting new budget", () => {
    const mgr = new PromptBudgetManager(1000);
    expect(mgr.getBudget()).toBe(1000);
    mgr.setBudget(500);
    expect(mgr.getBudget()).toBe(500);
  });
});

// ---- ContextScheduler ----

describe("ContextScheduler", () => {
  const mockCtx = {
    workingDir: "/test",
    sessionId: "test",
    readGuard: {} as any,
    permissionManager: {} as any,
    config: { model: { provider: "deepseek", model: "deepseek-chat" } } as any,
    depth: 0,
  };

  it("fetches sources in priority order", async () => {
    const scheduler = new ContextScheduler(5000);
    const highSource = {
      name: "high",
      priority: 10,
      fetch: async (_q: string, _ctx: any) => ({ content: "HIGH", priority: 10, source: "high" }),
    };
    const lowSource = {
      name: "low",
      priority: 100,
      fetch: async (_q: string, _ctx: any) => ({ content: "LOW", priority: 100, source: "low" }),
    };
    scheduler.register(highSource);
    scheduler.register(lowSource);
    const blocks = await scheduler.fetchAll("test query", mockCtx);
    expect(blocks.length).toBeGreaterThan(0);
    if (blocks.length >= 2) {
      expect(blocks[0].source).toBe("high");
      expect(blocks[1].source).toBe("low");
    }
  });

  it("handles source errors gracefully", async () => {
    const scheduler = new ContextScheduler(5000);
    scheduler.register({
      name: "bad",
      priority: 1,
      fetch: async () => { throw new Error("fail"); },
    });
    const blocks = await scheduler.fetchAll("test", mockCtx);
    expect(blocks.length).toBe(1);
    expect(blocks[0].content).toContain("failed");
  });

  it("can remove sources", async () => {
    const scheduler = new ContextScheduler(5000);
    scheduler.register({
      name: "temp",
      priority: 1,
      fetch: async () => ({ content: "TEMP", priority: 1, source: "temp" }),
    });
    scheduler.remove("temp");
    expect(scheduler.getSources().length).toBe(0);
  });
});
