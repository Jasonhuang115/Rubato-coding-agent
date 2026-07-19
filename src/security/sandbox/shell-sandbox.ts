// ShellSandbox — validates shell commands before execution
// Detects dangerous metacharacters, command patterns, and enforces allowlists.

import type { ISandbox, SandboxResult } from "./sandbox.js";

/** Command patterns that are always denied regardless of workspace. */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // rm targeting root — matches: rm -rf /, rm -r -f /, rm -rf /*, rm /, etc.
  // Does NOT match: rm -rf ./node_modules, rm file.txt
  { pattern: /\brm\s+(-[^\s]*\s+)*\//, reason: "Root-targeting rm command blocked" },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: "Raw disk write blocked" },
  { pattern: /\bmkfs\./, reason: "Filesystem format blocked" },
  { pattern: /\bdd\s+if=/, reason: "Raw disk operations blocked" },
  { pattern: /:\(\)\s*\{/, reason: "Fork bomb blocked" },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\//, reason: "Recursive root permission change blocked" },
  { pattern: /\bchown\s+(-R\s+)?.*\s+\//, reason: "Recursive root ownership change blocked" },
  { pattern: /\bmv\s+.*\s+\/etc\//, reason: "System config modification blocked" },
];

/**
 * Shell execution modes:
 * - "safe": read-only commands that don't need sandbox checks
 * - "modify": can write/modify files, needs workspace boundary check
 * - "network": can make network requests, needs network sandbox
 * - "blocked": never allowed
 */
const COMMAND_CATEGORIES: Record<string, { mode: "safe" | "modify" | "network" | "blocked"; command: RegExp }> = {
  // Read-only — always safe
  ls: { mode: "safe", command: /^ls\b/ },
  cat: { mode: "safe", command: /^cat\b/ },
  head: { mode: "safe", command: /^head\b/ },
  tail: { mode: "safe", command: /^tail\b/ },
  find: { mode: "safe", command: /^find\b/ },
  wc: { mode: "safe", command: /^wc\b/ },
  file: { mode: "safe", command: /^file\b/ },
  pwd: { mode: "safe", command: /^pwd$/ },
  echo: { mode: "safe", command: /^echo\b/ },
  which: { mode: "safe", command: /^which\b/ },
  uname: { mode: "safe", command: /^uname\b/ },
  env: { mode: "safe", command: /^env$/ },

  // Git read-only
  "git-status": { mode: "safe", command: /^git\s+status\b/ },
  "git-diff": { mode: "safe", command: /^git\s+diff\b/ },
  "git-log": { mode: "safe", command: /^git\s+log\b/ },
  "git-branch": { mode: "safe", command: /^git\s+branch\b/ },
  "git-remote": { mode: "safe", command: /^git\s+remote\b/ },
  "git-show": { mode: "safe", command: /^git\s+show\b/ },

  // Dev read-only
  "node-version": { mode: "safe", command: /^node\s+(--version|-v)$/ },
  "npm-ls": { mode: "safe", command: /^npm\s+ls\b/ },

  // File operations
  rm: { mode: "modify", command: /^rm\b/ },
  cp: { mode: "modify", command: /^cp\b/ },
  mv: { mode: "modify", command: /^mv\b/ },
  mkdir: { mode: "modify", command: /^mkdir\b/ },
  touch: { mode: "modify", command: /^touch\b/ },
  npm: { mode: "modify", command: /^npm\b/ },
  npx: { mode: "modify", command: /^npx\b/ },
  node: { mode: "modify", command: /^node\b/ },
  yarn: { mode: "modify", command: /^yarn\b/ },
  pnpm: { mode: "modify", command: /^pnpm\b/ },
  git: { mode: "modify", command: /^git\b/ },
  python: { mode: "modify", command: /^python[3]?\b/ },
  cargo: { mode: "modify", command: /^cargo\b/ },
  go: { mode: "modify", command: /^go\b/ },

  // Network — needs network sandbox
  curl: { mode: "network", command: /^curl\b/ },
  wget: { mode: "network", command: /^wget\b/ },
};

export class ShellSandbox implements ISandbox {
  readonly name = "shell-sandbox";

  validate(toolName: string, input: Record<string, unknown>, _workingDir: string): SandboxResult {
    if (toolName !== "Bash") return { allowed: true };

    const command = (input.command as string)?.trim();
    if (!command) return { allowed: false, reason: "Empty command" };

    // 1. Check dangerous patterns (hard blocklist)
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { allowed: false, reason: `Dangerous command blocked: ${reason} (command: "${command.slice(0, 80)}")` };
      }
    }

    // 2. Check command category
    const category = this.categorize(command);

    // 3. Network commands — require WebFetch/WebSearch tool instead
    if (category === "network") {
      return {
        allowed: false,
        reason: `Network command blocked: "${command.slice(0, 80)}". Use WebFetch or WebSearch tool instead.`,
      };
    }

    // 4. Blocked commands
    if (category === "blocked") {
      return { allowed: false, reason: `Command blocked by policy: "${command.slice(0, 80)}"` };
    }

    return { allowed: true };
  }

  private categorize(command: string): "safe" | "modify" | "network" | "blocked" {
    // Check known commands first
    for (const [, { mode, command: cmdPattern }] of Object.entries(COMMAND_CATEGORIES)) {
      if (cmdPattern.test(command)) return mode;
    }
    // Unknown commands default to blocked
    return "blocked";
  }
}
