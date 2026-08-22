// Tests for runtime components used by the production agent loop.
import { describe, it, expect } from "vitest";
import {
  estimateMessageTokens,
  getAutoCompactThreshold,
} from "../src/runtime/compaction-controller.js";
import { getCompactionBudget } from "../src/runtime/model-windows.js";
import { roughTokenEstimate } from "../src/shared/tokens.js";

describe("CompactionController token estimation", () => {
  it("estimates text and structured messages", () => {
    expect(roughTokenEstimate("hello world")).toBeGreaterThan(0);
    expect(estimateMessageTokens([{ role: "user", content: "hello world" }])).toBeGreaterThan(0);
    expect(estimateMessageTokens([{
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    }])).toBeGreaterThan(0);
  });

  it("uses the working window without a global 240k root ceiling", () => {
    const budget = getCompactionBudget({ model: "deepseek-v4-pro" });
    expect(getAutoCompactThreshold("deepseek-v4-pro")).toBe(budget.trigger);
    expect(budget.window).toBe(256_000);
    expect(budget.trigger).toBeLessThan(256_000);
    expect(getAutoCompactThreshold("deepseek-v4-pro", true)).toBe(120_000);
  });

  it("still respects providers with smaller context windows", () => {
    const budget = getCompactionBudget({ model: "gpt-4o" });
    expect(getAutoCompactThreshold("gpt-4o")).toBe(budget.trigger);
    expect(budget.window).toBe(128_000);
    expect(getAutoCompactThreshold("gpt-4o", true)).toBe(108_000);
  });
});
