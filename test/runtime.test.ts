// Tests for runtime components used by the production agent loop.
import { describe, it, expect } from "vitest";
import {
  estimateMessageTokens,
  getAutoCompactThreshold,
} from "../src/runtime/compaction-controller.js";
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

  it("uses an operational ceiling below very large provider windows", () => {
    expect(getAutoCompactThreshold("deepseek-v4-pro")).toBe(240_000);
    expect(getAutoCompactThreshold("deepseek-v4-pro", true)).toBe(120_000);
  });

  it("still respects providers with smaller context windows", () => {
    expect(getAutoCompactThreshold("gpt-4o")).toBe(108_000);
    expect(getAutoCompactThreshold("gpt-4o", true)).toBe(108_000);
  });
});
