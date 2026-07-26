import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactText, redactValue } from "../src/agent/subagents/redaction.js";
import { scrubPersistedData } from "../src/security/scrub.js";
import { ShellSandbox } from "../src/security/sandbox/shell-sandbox.js";

describe("Bash sensitive-path isolation", () => {
  let workspace = "";
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-shell-security-"));
    fs.mkdirSync(path.join(workspace, "src"));
    fs.writeFileSync(path.join(workspace, "src", "safe.ts"), "safe\n");
    fs.writeFileSync(path.join(workspace, ".env"), "SECRET=fake\n");
  });
  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  it.each([
    'cat ".env"',
    "head .env.local",
    "sed -n '1p' .npmrc",
    "python3 -c \"print(open('.env').read())\"",
    "node -e \"require('fs').readFileSync('.env','utf8')\"",
    "TARGET=.env cat \"$TARGET\"",
    "cp .env src/copied.txt",
  ])("blocks alternate secret-reader command: %s", (command) => {
    const result = new ShellSandbox().validate("Bash", { command }, workspace);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Sensitive path|filesystem reads|Dynamic file paths/);
  });

  it("continues to allow ordinary in-workspace development commands", () => {
    const sandbox = new ShellSandbox();
    expect(sandbox.validate("Bash", { command: "cat src/safe.ts" }, workspace).allowed).toBe(true);
    expect(sandbox.validate("Bash", { command: "npm test" }, workspace).allowed).toBe(true);
    expect(sandbox.validate("Bash", { command: "node scripts/check.js" }, workspace).allowed).toBe(true);
  });
});

describe("persistent credential redaction", () => {
  const googleKey = `AIza${"A".repeat(35)}`;

  it("redacts provider-shaped credentials without a surrounding key name", () => {
    const input = [
      googleKey,
      `AKIA${"B".repeat(16)}`,
      `ghp_${"C".repeat(30)}`,
      `Bearer ${"D".repeat(40)}`,
    ].join("\n");
    const output = redactText(input);
    expect(output).not.toContain(googleKey);
    expect(output).not.toContain("AKIA");
    expect(output).not.toContain("ghp_");
    expect(output).not.toContain("D".repeat(40));
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("removes terminal control sequences before persistence", () => {
    expect(redactText("\u001b[1mHeading\u001b[0m")).toBe("Heading");
  });

  it("is idempotent for values that have already been redacted", () => {
    for (const value of [
      "api_key=[REDACTED]",
      "Authorization: [REDACTED]",
      '{"client_secret":"[REDACTED]"}',
    ]) {
      expect(redactText(redactText(value))).toBe(redactText(value));
    }
  });

  it("removes private reasoning fields and redacts nested secret fields", () => {
    expect(redactValue({
      thinking: "private chain",
      nested: {
        apiKey: googleKey,
        message: `public text ${googleKey}`,
      },
    })).toEqual({
      nested: {
        apiKey: "[REDACTED]",
        message: "public text [REDACTED]",
      },
    });
  });

  it("dry-runs then atomically scrubs persisted trace, session, and report data", () => {
    const rubatoHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-scrub-"));
    try {
      const runDir = path.join(rubatoHome, "projects", "project", "runs", "run");
      const taskDir = path.join(runDir, "tasks", "task");
      const sessionDir = path.join(rubatoHome, "projects", "project", "sessions");
      fs.mkdirSync(taskDir, { recursive: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      const tracePath = path.join(runDir, "trace.jsonl");
      const reportPath = path.join(taskDir, "report.md");
      const sessionPath = path.join(sessionDir, "session.jsonl");
      fs.writeFileSync(tracePath, `${JSON.stringify({ type: "tool", output: googleKey })}\n`);
      fs.writeFileSync(reportPath, `# Report\n\n${googleKey}\n`);
      fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "message", data: googleKey })}\n`);

      const dryRun = scrubPersistedData({ rubatoHome, dryRun: true });
      expect(dryRun.filesChanged).toBe(3);
      expect(fs.readFileSync(tracePath, "utf8")).toContain(googleKey);

      const scrubbed = scrubPersistedData({ rubatoHome });
      expect(scrubbed.filesChanged).toBe(3);
      for (const file of [tracePath, reportPath, sessionPath]) {
        const content = fs.readFileSync(file, "utf8");
        expect(content).not.toContain(googleKey);
        expect(content).toContain("[REDACTED]");
      }
      expect(fs.readdirSync(runDir).some((name) => name.includes("rubato-scrub"))).toBe(false);
    } finally {
      fs.rmSync(rubatoHome, { recursive: true, force: true });
    }
  });

  it("refuses to scrub a target outside Rubato-owned persistence", () => {
    const rubatoHome = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-scrub-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-scrub-outside-"));
    try {
      expect(() => scrubPersistedData({ rubatoHome, target: outside })).toThrow(
        "inside the Rubato data directory",
      );
    } finally {
      fs.rmSync(rubatoHome, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
