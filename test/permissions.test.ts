// Permissions system tests
import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../src/permissions/policy.js";
import { DEFAULT_PERMISSIONS } from "../src/permissions/config.js";

describe("PolicyEngine", () => {
  const defaultPerms = { ...DEFAULT_PERMISSIONS };

  it("allows auto-mode tools without confirmation", () => {
    const engine = new PolicyEngine({
      ...defaultPerms,
      read: "auto",
      bash: "confirm",
    });

    const result = engine.check("Read", { file_path: "/tmp/test.ts" });
    expect(result.allowed).toBe(true);
  });

  it("requires confirmation for confirm-mode tools", () => {
    const engine = new PolicyEngine({
      ...defaultPerms,
      bash: "confirm",
    });

    const result = engine.check("Bash", { command: "mkdir test-dir" });
    expect(result.allowed).toBe(false);
    expect("mode" in result && result.mode).toBe("confirm");
  });

  it("blocks tools in manual mode", () => {
    const engine = new PolicyEngine({
      ...defaultPerms,
      write: "manual",
    });

    const result = engine.check("Write", { file_path: "/tmp/test.ts" });
    expect(result.allowed).toBe(false);
    expect("mode" in result && result.mode).toBe("manual");
  });

  it("enforces hard blacklist", () => {
    const engine = new PolicyEngine(defaultPerms);

    const result = engine.check("Bash", { command: "rm -rf / --no-preserve-root" });
    expect(result.allowed).toBe(false);
    expect("reason" in result && result.reason).toContain("security policy");
  });

  it("allows safe bash commands", () => {
    const engine = new PolicyEngine({
      ...defaultPerms,
      bash: "auto",
    });

    const result = engine.check("Bash", { command: "ls -la" });
    expect(result.allowed).toBe(true);
  });

  it("remembers allowed tools within session", () => {
    const engine = new PolicyEngine({
      ...defaultPerms,
      bash: "confirm",
    });

    // First call needs confirmation
    const first = engine.check("Bash", { command: "mkdir test-dir" });
    expect(first.allowed).toBe(false);

    // Allow it
    engine.allowTool("Bash");

    // Now it should be allowed
    const second = engine.check("Bash", { command: "mkdir test-dir" });
    expect(second.allowed).toBe(true);
  });

  it("remembers denied tools within session", () => {
    const engine = new PolicyEngine({
      ...defaultPerms,
      bash: "auto",
    });

    engine.denyTool("Bash");

    const result = engine.check("Bash", { command: "mkdir test-dir" });
    expect(result.allowed).toBe(false);
    expect("reason" in result && result.reason).toContain("denied earlier");
  });

  it("resets tool permissions", () => {
    const engine = new PolicyEngine({
      ...defaultPerms,
      bash: "confirm",
    });

    engine.denyTool("Bash");
    engine.resetTool("Bash");

    // Should be back to confirm
    const result = engine.check("Bash", { command: "mkdir test-dir" });
    expect(result.allowed).toBe(false);
    expect("mode" in result && result.mode).toBe("confirm");
  });

  it("blocks curl/wget commands (network policy)", () => {
    const engine = new PolicyEngine({
      ...defaultPerms,
      bash: "auto",
    });

    const curlResult = engine.check("Bash", { command: "curl https://example.com" });
    expect(curlResult.allowed).toBe(false);
    expect("reason" in curlResult && curlResult.reason).toContain("Network");

    const wgetResult = engine.check("Bash", { command: "wget https://example.com" });
    expect(wgetResult.allowed).toBe(false);
  });
});
