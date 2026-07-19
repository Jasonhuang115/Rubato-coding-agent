// Recursive SubAgent — BudgetManager + canSpawn tests
import { describe, it, expect, beforeEach } from "vitest";
import { BudgetManager } from "../src/runtime/budget-manager.js";
import { getBuiltinDefinition } from "../src/agent/subagent.js";

// ---- BudgetManager (simplified: only hardDepth + maxAgents + maxParallel) ----

describe("BudgetManager", () => {
  let budget: BudgetManager;

  beforeEach(() => {
    budget = new BudgetManager({ maxAgents: 4, maxParallel: 2, hardDepth: 3 });
  });

  it("allocates agents when under budget", () => {
    expect(budget.tryAllocate(0).allowed).toBe(true);
    expect(budget.activeAgents).toBe(1);
    expect(budget.remainingAgents).toBe(3);
  });

  it("denies when agent budget exhausted", () => {
    for (let i = 0; i < 4; i++) {
      budget.tryAllocate(0);
      budget.releaseAgent();
    }
    const r = budget.tryAllocate(0);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("Agent limit");
  });

  it("denies when parallel limit reached", () => {
    budget.tryAllocate(0);
    budget.tryAllocate(0);
    const r = budget.tryAllocate(0);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("Parallel limit");
  });

  it("denies at hard depth (default 3)", () => {
    expect(budget.tryAllocate(0).allowed).toBe(true); budget.releaseAgent();
    expect(budget.tryAllocate(1).allowed).toBe(true); budget.releaseAgent();
    expect(budget.tryAllocate(2).allowed).toBe(true); budget.releaseAgent();
    const r = budget.tryAllocate(3);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("Maximum depth");
  });

  it("releases agent slots", () => {
    budget.tryAllocate(0);
    budget.tryAllocate(0);
    expect(budget.activeAgents).toBe(2);
    budget.releaseAgent();
    expect(budget.activeAgents).toBe(1);
    budget.releaseAgent();
    expect(budget.activeAgents).toBe(0);
  });
});

// ---- SubagentDefinition canSpawn ----

describe("SubagentDefinition recursion capability", () => {
  it("general subagent allows recursion", () => {
    const def = getBuiltinDefinition("general");
    expect(def.canSpawn).toBe(true);
  });

  it("explore subagent does not allow recursion", () => {
    const def = getBuiltinDefinition("explore");
    expect(def.canSpawn).toBeFalsy();
  });

  it("verify subagent does not allow recursion", () => {
    const def = getBuiltinDefinition("verify");
    expect(def.canSpawn).toBeFalsy();
  });

  it("subagent definitions have no maxTurns (unlimited steps)", () => {
    const general = getBuiltinDefinition("general");
    const explore = getBuiltinDefinition("explore");
    const verify = getBuiltinDefinition("verify");
    expect(general.maxTurns).toBeUndefined();
    expect(explore.maxTurns).toBeUndefined();
    expect(verify.maxTurns).toBeUndefined();
  });
});
