// Subagent recursion — resolveTools + BudgetManager integration tests

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { register, clear, getTool, getAllTools } from "../src/tools/registry.js";
import { BudgetManager } from "../src/runtime/budget-manager.js";
import type { ToolDefinition } from "../src/shared/core-types.js";

const TEST_TOOLS: ToolDefinition[] = [
  { name: "Agent", description: "spawn", inputSchema: { type: "object", properties: {} }, type: "write", handler: async () => ({ content: "" }) },
  { name: "Read",  description: "read",  inputSchema: { type: "object", properties: {} }, type: "read", handler: async () => ({ content: "" }) },
  { name: "Write", description: "write", inputSchema: { type: "object", properties: {} }, type: "write", handler: async () => ({ content: "" }) },
  { name: "Bash",  description: "run",   inputSchema: { type: "object", properties: {} }, type: "write", handler: async () => ({ content: "" }) },
  { name: "Skill", description: "skill", inputSchema: { type: "object", properties: {} }, type: "write", handler: async () => ({ content: "" }) },
];

beforeAll(() => { clear(); for (const t of TEST_TOOLS) register(t); });
afterAll(() => { clear(); });

// ---- resolveTools replica ----

function resolveTools(
  allowlist: string[],
  opts?: { canSpawn?: boolean; depth?: number; hardDepth?: number }
): ToolDefinition[] {
  const hardDepth = opts?.hardDepth ?? 3;
  const shouldRemoveAgent = !opts?.canSpawn || (opts?.depth ?? 0) >= hardDepth;

  if (allowlist.includes("*")) {
    let tools = getAllTools();
    if (shouldRemoveAgent) tools = tools.filter((t) => t.name !== "Agent" && t.name !== "Skill");
    return tools;
  }
  let tools = allowlist.map((name) => getTool(name)).filter((t): t is ToolDefinition => t !== undefined);
  if (shouldRemoveAgent) tools = tools.filter((t) => t.name !== "Agent" && t.name !== "Skill");
  return tools;
}

// ---- Depth control (hardDepth=3) ----

describe("resolveTools — 3-level recursion", () => {
  it("depth 0 (root) has AgentTool", () => {
    const tools = resolveTools(["*"], { canSpawn: true, depth: 0 });
    expect(tools.map(t => t.name)).toContain("Agent");
  });

  it("depth 1 (child) has AgentTool", () => {
    const tools = resolveTools(["*"], { canSpawn: true, depth: 1 });
    expect(tools.map(t => t.name)).toContain("Agent");
  });

  it("depth 2 (grandchild) has AgentTool", () => {
    const tools = resolveTools(["*"], { canSpawn: true, depth: 2 });
    expect(tools.map(t => t.name)).toContain("Agent");
  });

  it("depth 3 (great-grandchild) loses AgentTool — hard limit", () => {
    const tools = resolveTools(["*"], { canSpawn: true, depth: 3 });
    expect(tools.map(t => t.name)).not.toContain("Agent");
  });

  it("depth 100 loses AgentTool", () => {
    const tools = resolveTools(["*"], { canSpawn: true, depth: 100 });
    expect(tools.map(t => t.name)).not.toContain("Agent");
  });

  it("canSpawn=false removes AgentTool at any depth", () => {
    expect(resolveTools(["*"], { canSpawn: false, depth: 0 }).map(t => t.name)).not.toContain("Agent");
    expect(resolveTools(["*"], { canSpawn: false, depth: 1 }).map(t => t.name)).not.toContain("Agent");
  });

  it("core tools always present", () => {
    const tools = resolveTools(["*"], { canSpawn: true, depth: 3 });
    const names = tools.map(t => t.name);
    expect(names).toContain("Read");
    expect(names).toContain("Write");
    expect(names).toContain("Bash");
    expect(names).not.toContain("Agent");
  });
});

// ---- BudgetManager + resolveTools alignment ----

describe("BudgetManager + resolveTools alignment at hardDepth=3", () => {
  it("depth 2: BudgetManager allows, resolveTools keeps AgentTool", () => {
    const budget = new BudgetManager({ hardDepth: 3 });
    const tools = resolveTools(["*"], { canSpawn: true, depth: 2 });
    expect(budget.tryAllocate(2).allowed).toBe(true);
    expect(tools.some(t => t.name === "Agent")).toBe(true);
  });

  it("depth 3: BudgetManager denies, resolveTools removes AgentTool", () => {
    const budget = new BudgetManager({ hardDepth: 3 });
    expect(budget.tryAllocate(3).allowed).toBe(false);
    const tools = resolveTools(["*"], { canSpawn: true, depth: 3 });
    expect(tools.some(t => t.name === "Agent")).toBe(false);
  });

  it("agent limit still guards against explosion", () => {
    const budget = new BudgetManager({ maxAgents: 3, maxParallel: 10 });
    budget.tryAllocate(0);
    budget.tryAllocate(0);
    budget.tryAllocate(0);
    const r = budget.tryAllocate(0);
    expect(r.allowed).toBe(false);
  });
});
