import { describe, expect, it } from "vitest";
import { PromptAssembler, getPromptAssembler } from "../src/prompt/assembler.js";
import { buildCapabilityPrompt } from "../src/prompt/capability.js";
import { assembleContext } from "../src/runtime/context-assembler.js";

const ctx = {
  workingDir: "/test",
  sessionId: "test",
  readGuard: {} as any,
  permissionManager: {} as any,
  config: { model: { provider: "deepseek", model: "deepseek-chat" } } as any,
  mode: "default" as const,
  depth: 0,
};

const tools = [
  { name: "Read", type: "read" as const, isConcurrencySafe: true, description: "Read file", inputSchema: { type: "object", properties: {} } },
  { name: "Write", type: "write" as const, description: "Write file", inputSchema: { type: "object", properties: {} } },
];

describe("PromptAssembler", () => {
  it("assembles the three production prompt layers", () => {
    const layers = new PromptAssembler().assemble(ctx, tools);
    expect(layers.static).toBeTruthy();
    expect(layers.capability).toContain("Read");
    expect(layers.dynamic).toBeTruthy();
  });

  it("keeps one production singleton", () => {
    expect(getPromptAssembler()).toBe(getPromptAssembler());
  });

  it("describes the asynchronous report and timeout contract", () => {
    const prompt = buildCapabilityPrompt([{
      name: "Subagent",
      type: "read",
      description: "Background analysis",
      inputSchema: { type: "object", properties: {} },
    } as any]);
    expect(prompt).toContain("always dispatches");
    expect(prompt).toContain("returns immediately");
    expect(prompt).toContain("not a work budget");
    expect(prompt).toContain("Never wait, watch, join, acknowledge, or poll");
    expect(prompt).toContain("Grep its exposed path first");
    expect(prompt).toContain("Subagents cannot dispatch Subagents");
  });

  it("replaces root identity and requires progressive reporting", async () => {
    const result = await assembleContext({
      workingDir: "/tmp",
      prompt: "inspect one thing",
      ctx,
      tools: [tools[0] as any],
      roleSystemPrompt: "You are the dedicated architecture verifier.",
      contextProfile: "subagent",
    });
    expect(result.systemPrompt).toContain("dedicated architecture verifier");
    expect(result.systemPrompt).toContain("appended to report.md while you work");
    expect(result.systemPrompt).toContain("End naturally");
    expect(result.systemPrompt).not.toContain("You are Rubato (rubato)");
  });
});
