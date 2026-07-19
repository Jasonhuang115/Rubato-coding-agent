// Tool Capability + Context Scheduler tests
import { describe, it, expect } from "vitest";
import { getCapability, getRisk, isConcurrencySafe, estimateCost, filterByRisk } from "../src/tools/capability.js";

describe("ToolCapability", () => {
  it("returns capability for known tools", () => {
    const cap = getCapability("Read");
    expect(cap).not.toBeNull();
    expect(cap!.name).toBe("Read");
    expect(cap!.abilities.filesystem).toBe("read");
    expect(cap!.risk).toBe("safe");
    expect(cap!.isIdempotent).toBe(true);
  });

  it("returns null for unknown tools", () => {
    expect(getCapability("UnknownTool")).toBeNull();
  });

  it("Bash is dangerous", () => {
    const cap = getCapability("Bash");
    expect(cap!.risk).toBe("dangerous");
    expect(cap!.abilities.shell).toBe("full");
    expect(cap!.cost.isExpensive).toBe(true);
  });

  it("getRisk returns correct level", () => {
    expect(getRisk("Read")).toBe("safe");
    expect(getRisk("Bash")).toBe("dangerous");
    expect(getRisk("WebFetch")).toBe("moderate");
    expect(getRisk("UnknownTool")).toBe("moderate"); // default
  });

  it("isConcurrencySafe for idempotent tools", () => {
    expect(isConcurrencySafe("Read")).toBe(true);
    expect(isConcurrencySafe("Grep")).toBe(true);
    expect(isConcurrencySafe("Glob")).toBe(true);
    expect(isConcurrencySafe("Bash")).toBe(false);
    expect(isConcurrencySafe("Write")).toBe(false);
  });

  it("estimateCost returns token estimates", () => {
    const cost = estimateCost("Read");
    expect(cost.input).toBeGreaterThan(0);
    expect(cost.output).toBeGreaterThan(0);
  });

  it("filterByRisk filters correctly", () => {
    const safe = filterByRisk("safe");
    expect(safe.every((c) => c.risk === "safe")).toBe(true);

    const dangerous = filterByRisk("dangerous");
    expect(dangerous.some((c) => c.risk === "dangerous")).toBe(true);
    expect(dangerous.some((c) => c.risk === "safe")).toBe(true);
  });

  it("Write is moderate risk", () => {
    const cap = getCapability("Write");
    expect(cap!.risk).toBe("moderate");
    expect(cap!.hasSideEffects).toBe(true);
    expect(cap!.isIdempotent).toBe(false);
  });

  it("all defined capabilities are consistent", () => {
    const knownTools = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "TodoWrite"];
    for (const name of knownTools) {
      const cap = getCapability(name);
      expect(cap, `Missing capability for ${name}`).not.toBeNull();
      expect(cap!.name).toBe(name);
      expect(["safe", "moderate", "dangerous", "destructive"]).toContain(cap!.risk);
    }
  });
});
