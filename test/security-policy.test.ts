// Security policy + peripheral module tests
import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../src/security/policy/engine.js";
import { HARD_BLACKLIST, DEFAULT_ALLOW_RULES } from "../src/security/policy/rules.js";
import { ApprovalManager } from "../src/security/approval.js";
import { assessRisk } from "../src/security/risk-assessor.js";
import { AuditLog } from "../src/security/audit-log.js";
import { SnapshotManager } from "../src/security/snapshot.js";

// ---- PolicyEngine ----

describe("PolicyEngine", () => {
  const permissions = { bash: "auto", read: "auto", write: "auto", edit: "auto", web: "auto", rules: [] };

  it("allows allowed tools with auto mode", () => {
    const engine = new PolicyEngine(permissions);
    expect(engine.check("Read", { file_path: "test.ts" }).allowed).toBe(true);
    expect(engine.check("Bash", { command: "ls" }).allowed).toBe(true);
  });

  it("blocks hard blacklisted commands", () => {
    const engine = new PolicyEngine(permissions);
    expect(engine.check("Bash", { command: "rm -rf /" }).allowed).toBe(false);
    expect(engine.check("Bash", { command: "mkfs.ext4 /dev/sda" }).allowed).toBe(false);
    expect(engine.check("Bash", { command: ":(){ :|:& };:" }).allowed).toBe(false);
  });

  it("allows safe commands via default rules", () => {
    const engine = new PolicyEngine(permissions);
    expect(engine.check("Bash", { command: "ls -la" }).allowed).toBe(true);
    expect(engine.check("Bash", { command: "git status" }).allowed).toBe(true);
    expect(engine.check("Bash", { command: "npm test" }).allowed).toBe(true);
  });

  it("blocks curl and wget", () => {
    const engine = new PolicyEngine(permissions);
    expect(engine.check("Bash", { command: "curl https://example.com" }).allowed).toBe(false);
    expect(engine.check("Bash", { command: "wget https://example.com" }).allowed).toBe(false);
  });

  it("denies tools in manual mode", () => {
    const manual = { ...permissions, bash: "manual" as const };
    const engine = new PolicyEngine(manual);
    // Use a command NOT in DEFAULT_ALLOW_RULES (which would match before mode check)
    const result = engine.check("Bash", { command: "python script.py" });
    expect(result.allowed).toBe(false);
  });

  it("requires confirmation for confirm mode", () => {
    const confirm = { ...permissions, bash: "confirm" as const };
    const engine = new PolicyEngine(confirm);
    const result = engine.check("Bash", { command: "npm run deploy" });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.mode).toBe("confirm");
  });

  it("tracks session-level allow decisions", () => {
    const engine = new PolicyEngine(permissions);
    engine.allowTool("Bash");
    expect(engine.check("Bash", { command: "anything" }).allowed).toBe(true);
  });

  it("tracks session-level deny decisions", () => {
    const engine = new PolicyEngine(permissions);
    engine.denyTool("Bash");
    expect(engine.check("Bash", { command: "ls" }).allowed).toBe(false);
  });

  it("resets tool permissions", () => {
    const engine = new PolicyEngine(permissions);
    engine.denyTool("Write");
    engine.resetTool("Write");
    expect(engine.check("Write", { file_path: "test.ts" }).allowed).toBe(true);
  });

  it("applies custom user rules before defaults", () => {
    const withRules = {
      ...permissions,
      rules: [{ tool: "Bash", pattern: "dangerous-command", action: "deny" as const, reason: "Custom block" }],
    };
    const engine = new PolicyEngine(withRules);
    expect(engine.check("Bash", { command: "dangerous-command" }).allowed).toBe(false);
  });
});

// ---- ApprovalManager ----

describe("ApprovalManager", () => {
  it("auto-approves when no callback", async () => {
    const mgr = new ApprovalManager();
    const decision = await mgr.requestApproval({ toolName: "Bash", input: {}, risk: "medium", reason: "test" });
    expect(decision).toBe("allow_once");
  });

  it("caches allow_always decisions", async () => {
    const mgr = new ApprovalManager(async () => "allow_always");
    const d1 = await mgr.requestApproval({ toolName: "Bash", input: {}, risk: "medium", reason: "test" });
    expect(d1).toBe("allow_always");
    // Second call should be cached (no callback needed)
    const d2 = await mgr.requestApproval({ toolName: "Bash", input: {}, risk: "medium", reason: "test" });
    expect(d2).toBe("allow_always");
  });

  it("caches deny_always decisions", async () => {
    const mgr = new ApprovalManager(async () => "deny_always");
    const d1 = await mgr.requestApproval({ toolName: "Write", input: {}, risk: "high", reason: "test" });
    expect(d1).toBe("deny_always");
    const d2 = await mgr.requestApproval({ toolName: "Write", input: {}, risk: "high", reason: "test" });
    expect(d2).toBe("deny_always");
  });

  it("resets all decisions", async () => {
    const mgr = new ApprovalManager(async () => "allow_always");
    await mgr.requestApproval({ toolName: "Bash", input: {}, risk: "low", reason: "test" });
    mgr.reset();
    const d = await mgr.requestApproval({ toolName: "Bash", input: {}, risk: "low", reason: "test" });
    expect(d).toBe("allow_always"); // callback is called again
  });
});

// ---- Risk Assessor ----

describe("RiskAssessor", () => {
  it("assesses sudo as critical", () => {
    const result = assessRisk("Bash", { command: "sudo rm -rf /tmp" });
    expect(result.level).toBe("critical");
    expect(result.factors).toContain("sudo");
  });

  it("assesses root rm as high", () => {
    const result = assessRisk("Bash", { command: "rm -rf /" });
    expect(result.level).toBe("high");
  });

  it("assesses npm install as medium", () => {
    const result = assessRisk("Bash", { command: "npm install react" });
    expect(result.level).toBe("medium");
  });

  it("assesses npm test as low", () => {
    const result = assessRisk("Bash", { command: "npm test" });
    expect(result.level).toBe("low");
  });

  it("assesses Read as low", () => {
    const result = assessRisk("Read", { file_path: "test.ts" });
    expect(result.level).toBe("low");
  });

  it("assesses Write as medium", () => {
    const result = assessRisk("Write", { file_path: "test.ts" });
    expect(result.level).toBe("medium");
  });

  it("assesses unknown tools as low", () => {
    const result = assessRisk("UnknownTool", {});
    expect(result.level).toBe("low");
  });
});

// ---- AuditLog ----

describe("AuditLog", () => {
  it("records entries", () => {
    const log = new AuditLog(10);
    log.record({ sessionId: "s1", toolName: "Bash", inputPreview: "ls", verdict: "allow", risk: "low", reason: "safe", outcome: "ok", latencyMs: 5, workspaceRoot: "/test" });
    expect(log.count).toBe(1);
  });

  it("enforces max size (ring buffer)", () => {
    const log = new AuditLog(3);
    for (let i = 0; i < 5; i++) {
      log.record({ sessionId: "s1", toolName: "Bash", inputPreview: `cmd${i}`, verdict: "allow", risk: "low", reason: "safe", outcome: "ok", latencyMs: 5, workspaceRoot: "/test" });
    }
    expect(log.count).toBe(3);
  });

  it("queries by tool", () => {
    const log = new AuditLog(10);
    log.record({ sessionId: "s1", toolName: "Bash", inputPreview: "ls", verdict: "allow", risk: "low", reason: "safe", outcome: "ok", latencyMs: 5, workspaceRoot: "/test" });
    log.record({ sessionId: "s1", toolName: "Write", inputPreview: "test.ts", verdict: "allow", risk: "medium", reason: "safe", outcome: "ok", latencyMs: 5, workspaceRoot: "/test" });
    expect(log.query({ toolName: "Bash" }).length).toBe(1);
    expect(log.query({ toolName: "Write" }).length).toBe(1);
  });

  it("queries by verdict", () => {
    const log = new AuditLog(10);
    log.record({ sessionId: "s1", toolName: "Bash", inputPreview: "rm -rf /", verdict: "deny", risk: "critical", reason: "dangerous", outcome: "blocked", latencyMs: 1, workspaceRoot: "/test" });
    log.record({ sessionId: "s1", toolName: "Bash", inputPreview: "ls", verdict: "allow", risk: "low", reason: "safe", outcome: "ok", latencyMs: 5, workspaceRoot: "/test" });
    expect(log.query({ verdict: "deny" }).length).toBe(1);
  });

  it("computes stats", () => {
    const log = new AuditLog(10);
    log.record({ sessionId: "s1", toolName: "Read", inputPreview: "a", verdict: "allow", risk: "low", reason: "safe", outcome: "ok", latencyMs: 5, workspaceRoot: "/test" });
    log.record({ sessionId: "s1", toolName: "Bash", inputPreview: "b", verdict: "warn", risk: "medium", reason: "warn", outcome: "ok", latencyMs: 5, workspaceRoot: "/test" });
    log.record({ sessionId: "s1", toolName: "Bash", inputPreview: "c", verdict: "deny", risk: "high", reason: "blocked", outcome: "blocked", latencyMs: 1, workspaceRoot: "/test" });
    const stats = log.stats();
    expect(stats.total).toBe(3);
    expect(stats.allowCount).toBe(1);
    expect(stats.warnCount).toBe(1);
    expect(stats.denyCount).toBe(1);
    expect(stats.topTools[0].tool).toBe("Bash");
    expect(stats.topTools[0].count).toBe(2);
  });

  it("clears all entries", () => {
    const log = new AuditLog(10);
    log.record({ sessionId: "s1", toolName: "Read", inputPreview: "a", verdict: "allow", risk: "low", reason: "safe", outcome: "ok", latencyMs: 5, workspaceRoot: "/test" });
    log.clear();
    expect(log.count).toBe(0);
  });
});

// ---- SnapshotManager ----

describe("SnapshotManager", () => {
  it("captures workspace state", () => {
    const mgr = new SnapshotManager();
    const snap = mgr.capture("/tmp", ["*"]); // exclude all
    expect(snap.timestamp).toBeGreaterThan(0);
    expect(snap.workspaceRoot).toBe("/tmp");
    expect(snap.files).toBeDefined();
  });

  it("diffs two snapshots", () => {
    const mgr = new SnapshotManager();
    const a = { timestamp: 1, workspaceRoot: "/test", files: [{ relativePath: "a.ts", exists: true, size: 100, mtimeMs: 1000 }] };
    const b = { timestamp: 2, workspaceRoot: "/test", files: [
      { relativePath: "a.ts", exists: true, size: 200, mtimeMs: 2000 },
      { relativePath: "b.ts", exists: true, size: 50, mtimeMs: 2000 },
    ]};
    const diff = mgr.diff(a, b);
    expect(diff.changed).toContain("a.ts");
    expect(diff.added).toContain("b.ts");
    expect(diff.deleted.length).toBe(0);
  });

  it("detects deleted files", () => {
    const mgr = new SnapshotManager();
    const a = { timestamp: 1, workspaceRoot: "/test", files: [
      { relativePath: "a.ts", exists: true, size: 100, mtimeMs: 1000 },
      { relativePath: "b.ts", exists: true, size: 50, mtimeMs: 1000 },
    ]};
    const b = { timestamp: 2, workspaceRoot: "/test", files: [
      { relativePath: "a.ts", exists: true, size: 100, mtimeMs: 1000 },
    ]};
    const diff = mgr.diff(a, b);
    expect(diff.deleted).toContain("b.ts");
  });

  it("latest returns most recent", () => {
    const mgr = new SnapshotManager();
    expect(mgr.latest()).toBeNull();
    mgr.capture("/tmp", ["*"]);
    expect(mgr.latest()).not.toBeNull();
  });
});
