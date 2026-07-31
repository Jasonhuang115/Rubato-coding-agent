// ShellSandbox — validates shell commands before execution
// Detects dangerous metacharacters, command patterns, and enforces allowlists.

import type { ISandbox, SandboxResult } from "./sandbox.js";
import fs from "fs";
import os from "os";
import path from "path";
import { FsSandbox } from "./fs-sandbox.js";
import {
  matchSensitivePath,
  matchSensitiveShellReference,
} from "./sensitive-paths.js";

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
  grep: { mode: "safe", command: /^grep\b/ },
  rg: { mode: "safe", command: /^rg\b/ },
  sed: { mode: "safe", command: /^sed\b/ },
  awk: { mode: "safe", command: /^awk\b/ },
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
  private readonly fsSandbox = new FsSandbox();

  validate(toolName: string, input: Record<string, unknown>, workingDir: string): SandboxResult {
    if (toolName !== "Bash") return { allowed: true };

    const command = (input.command as string)?.trim();
    if (!command) return { allowed: false, reason: "Empty command" };

    const requestedWorkdir = input.workdir as string | undefined;
    if (requestedWorkdir) {
      const resolved = path.resolve(workingDir, requestedWorkdir);
      if (resolved !== workingDir && !resolved.startsWith(`${workingDir}${path.sep}`)) {
        return { allowed: false, reason: `Bash workdir must stay inside the workspace: "${requestedWorkdir}"` };
      }
    }
    const effectiveWorkdir = requestedWorkdir
      ? path.resolve(workingDir, requestedWorkdir)
      : workingDir;

    // 1. Check dangerous patterns (hard blocklist)
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { allowed: false, reason: `Dangerous command blocked: ${reason} (command: "${command.slice(0, 80)}")` };
      }
    }

    // 2. Shell substitutions can hide a second command from categorization.
    if (/`|\$\(/.test(command)) {
      return { allowed: false, reason: "Command substitution is not allowed in Bash commands." };
    }

    // Categorize every pipeline/chained segment, rather than trusting only the
    // first command (for example `cat file | curl ...`).
    const segments = command.split(/(?:&&|\|\||;|\|)/).map((segment) => segment.trim()).filter(Boolean);
    const categories = segments.map((segment) => this.categorize(segment));

    // 3. A shell is otherwise an alternate file reader. Apply the same
    // sensitive-path and workspace boundary policy used by Read/Grep/Glob
    // before the command is handed to a child process.
    const sensitiveReference = matchSensitiveShellReference(command);
    if (sensitiveReference) {
      return {
        allowed: false,
        reason: `Sensitive path blocked in Bash command (${sensitiveReference.label}). ` +
          "A security denial must not be bypassed with another command or interpreter.",
      };
    }
    for (let index = 0; index < segments.length; index++) {
      const pathResult = this.validateSegmentPaths(
        segments[index],
        categories[index],
        effectiveWorkdir,
        workingDir,
      );
      if (!pathResult.allowed) return pathResult;
    }

    // 4. Network commands — require WebFetch/WebSearch tool instead
    if (categories.includes("network")) {
      return {
        allowed: false,
        reason: `Network command blocked: "${command.slice(0, 80)}". Use WebFetch or WebSearch tool instead.`,
      };
    }

    // 5. Blocked commands
    if (categories.includes("blocked")) {
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

  private validateSegmentPaths(
    segment: string,
    category: "safe" | "modify" | "network" | "blocked",
    effectiveWorkdir: string,
    workspaceRoot: string,
  ): SandboxResult {
    const words = tokenizeShellWords(segment);
    if (words.length === 0) return { allowed: true };
    const commandName = path.basename(words[0]).toLowerCase();

    // Inline programs are intentionally not treated as a second unrestricted
    // file-reading language. Normal scripts, builds and tests remain allowed.
    if (
      ["python", "python3", "node", "ruby", "perl", "bash", "sh", "zsh"].includes(commandName) &&
      hasInlineProgram(words) &&
      /\b(?:open|readFile(?:Sync)?|createReadStream|read_text|read_bytes|File\.read|IO\.read)\s*\(/i.test(segment)
    ) {
      return {
        allowed: false,
        reason:
          "Inline interpreter filesystem reads are blocked in Bash. " +
          "Use Read/Grep/Glob so the filesystem policy can validate the path.",
      };
    }

    const directReader = [
      "cat", "head", "tail", "sed", "awk", "grep", "rg", "wc", "file",
      "less", "more", "strings", "xxd", "od",
    ].includes(commandName);
    const simpleReader = [
      "cat", "head", "tail", "wc", "file", "less", "more", "strings", "xxd", "od",
    ].includes(commandName);
    if (
      simpleReader &&
      words.slice(1).some((word) =>
        /(?:^|[^\\])\$(?:\{|[A-Za-z_])/.test(word) || /[*?[\]]/.test(word),
      )
    ) {
      return {
        allowed: false,
        reason:
          "Dynamic file paths are blocked for shell file-reading commands. " +
          "Use Read/Grep/Glob with an explicit path.",
      };
    }
    for (const candidate of potentialPathOperands(words.slice(1), effectiveWorkdir)) {
      if (directReader && candidate.dynamic) {
        return {
          allowed: false,
          reason:
            "Dynamic file paths are blocked for shell file-reading commands. " +
            "Use Read/Grep/Glob with an explicit path.",
        };
      }
      const filePath = candidate.value;
      const sensitive = matchSensitivePath(filePath, effectiveWorkdir);
      if (sensitive) {
        return {
          allowed: false,
          reason: `Sensitive path blocked in Bash command (${sensitive.label}). ` +
            "A security denial must not be bypassed with another command or interpreter.",
        };
      }
      const concretePath = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(effectiveWorkdir, filePath);
      const result = this.fsSandbox.validate(
        category === "safe" ? "BashRead" : "BashWrite",
        { file_path: concretePath },
        workspaceRoot,
      );
      if (!result.allowed) {
        return {
          allowed: false,
          reason: `Bash path blocked by filesystem policy: ${result.reason ?? "path denied"}`,
        };
      }
    }
    return { allowed: true };
  }
}

function hasInlineProgram(words: string[]): boolean {
  return words.some((word) =>
    word === "-c" ||
    word === "-e" ||
    word === "--eval" ||
    word.startsWith("-c=") ||
    word.startsWith("-e=") ||
    word.startsWith("--eval="),
  );
}

function tokenizeShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    if (char === ">" || char === "<") {
      if (current) words.push(current);
      words.push(char);
      current = "";
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

function potentialPathOperands(
  operands: string[],
  workingDir: string,
): Array<{ value: string; dynamic: boolean }> {
  const candidates: Array<{ value: string; dynamic: boolean }> = [];
  for (const operand of operands) {
    if (!operand || operand === ">" || operand === "<" || operand === ">>" || operand === "<<") continue;
    let value = operand;
    const equals = value.indexOf("=");
    if (value.startsWith("-") && equals < 0) continue;
    if (equals >= 0) value = value.slice(equals + 1);
    if (!value || /^(?:https?|git|ssh):\/\//i.test(value)) continue;

    const dynamic = /(?:^|[^\\])\$(?:\{|[A-Za-z_])/.test(value) || /[*?[\]]/.test(value);
    if (value.startsWith("~/")) {
      value = path.join(os.homedir(), value.slice(2));
    }
    const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(workingDir, value);
    const pathLike =
      path.isAbsolute(value) ||
      value.startsWith("./") ||
      value.startsWith("../") ||
      value.includes("/") ||
      Boolean(matchSensitivePath(value, workingDir)) ||
      fs.existsSync(resolved);
    if (pathLike) candidates.push({ value, dynamic });
  }
  return candidates;
}
