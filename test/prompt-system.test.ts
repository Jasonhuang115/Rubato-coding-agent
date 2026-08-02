// PromptAssembler tests — the prompt path used by ContextAssembler.
import { describe, it, expect } from "vitest";
import { PromptAssembler, getPromptAssembler } from "../src/prompt/assembler.js";
import { assembleContext } from "../src/runtime/context-assembler.js";
import { buildCapabilityPrompt } from "../src/prompt/capability.js";

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
    const first = getPromptAssembler();
    expect(getPromptAssembler()).toBe(first);
  });

  it("keeps root ownership and makes advisory the normal delegation mode", () => {
    const prompt = buildCapabilityPrompt([{
      name: "Agent",
      type: "read",
      description: "Delegate analysis",
      inputSchema: { type: "object", properties: {} },
    } as any]);

    expect(prompt).toContain("Mandatory delegation checkpoint");
    expect(prompt).toContain("Before creating a TodoWrite plan or starting broad reads");
    expect(prompt).toContain("two or more genuinely independent substantial scopes");
    expect(prompt).toContain("you MUST partition the work");
    expect(prompt).toContain("Never hand the entire user request to a subagent");
    expect(prompt).toContain("retain a meaningful, non-overlapping part");
    expect(prompt).toContain("non-blocking now");
    expect(prompt).toContain("optional forever");
    expect(prompt).toContain("immediate decision gate");
    expect(prompt).toContain("final join point");
    expect(prompt).toContain("Always pass `dependency` explicitly");
  });

  it("replaces root identity for a fresh subagent profile", async () => {
    const result = await assembleContext({
      workingDir: "/tmp",
      prompt: "inspect one thing",
      ctx,
      tools: [tools[0] as any],
      roleSystemPrompt: "You are the dedicated architecture verifier.",
      contextProfile: "subagent",
    });

    expect(result.systemPrompt).toContain("dedicated architecture verifier");
    expect(result.systemPrompt).toContain("MUST call CompleteTask");
    expect(result.systemPrompt).not.toContain("You are Rubato (rubato)");
    expect(result.systemPrompt).not.toContain("Previous Session Context");
  });
});
