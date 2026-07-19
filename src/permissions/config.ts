// Default permission configuration

import type { AgentConfig } from "../shared/core-types.js";

export const DEFAULT_PERMISSIONS: AgentConfig["permissions"] = {
  bash: "auto",
  read: "auto",
  write: "auto",
  edit: "auto",
  web: "auto",
  rules: [],
};

// Hard blacklist — these patterns are always denied, regardless of mode
export const HARD_BLACKLIST: PermissionRule[] = [
  {
    tool: "Bash",
    pattern: "rm -rf /",
    action: "deny",
    reason: "Destructive recursive root delete",
  },
  {
    tool: "Bash",
    pattern: "> /dev/sda",
    action: "deny",
    reason: "Raw disk write",
  },
  {
    tool: "Bash",
    pattern: "mkfs.",
    action: "deny",
    reason: "Filesystem format",
  },
  {
    tool: "Bash",
    pattern: "dd if=",
    action: "deny",
    reason: "Raw disk operations",
  },
  {
    tool: "Bash",
    pattern: ":(){ :|:& };:",
    action: "deny",
    reason: "Fork bomb",
  },
  {
    tool: "Bash",
    pattern: "chmod 777 /",
    action: "deny",
    reason: "Recursive permission change on root",
  },
  {
    tool: "Bash",
    pattern: "curl", // Not blacklisted, just noted — will be further refined in Phase 2
    action: "deny",
    reason: "Network requests require explicit approval in Phase 1",
  },
  {
    tool: "Bash",
    pattern: "wget",
    action: "deny",
    reason: "Network requests require explicit approval in Phase 1",
  },
];

// Default safe list — common read-only / dev commands that don't need confirmation.
// Users can override or extend these in config.yml under permissions.rules.
export const DEFAULT_ALLOW_RULES: PermissionRule[] = [
  // Read-only filesystem
  { tool: "Bash", pattern: "ls",    action: "allow", reason: "Safe: list directory" },
  { tool: "Bash", pattern: "cat ",  action: "allow", reason: "Safe: read file" },
  { tool: "Bash", pattern: "head ", action: "allow", reason: "Safe: read file" },
  { tool: "Bash", pattern: "tail ", action: "allow", reason: "Safe: read file" },
  { tool: "Bash", pattern: "find ", action: "allow", reason: "Safe: find files" },
  { tool: "Bash", pattern: "wc ",   action: "allow", reason: "Safe: count words/lines" },
  { tool: "Bash", pattern: "file ", action: "allow", reason: "Safe: identify file type" },
  { tool: "Bash", pattern: "pwd",   action: "allow", reason: "Safe: print working dir" },
  { tool: "Bash", pattern: "echo ", action: "allow", reason: "Safe: print text" },
  { tool: "Bash", pattern: "which ", action: "allow", reason: "Safe: locate command" },
  { tool: "Bash", pattern: "uname ", action: "allow", reason: "Safe: system info" },
  { tool: "Bash", pattern: "env",   action: "allow", reason: "Safe: list env vars" },

  // Git read-only
  { tool: "Bash", pattern: "git status",   action: "allow", reason: "Safe: git status" },
  { tool: "Bash", pattern: "git diff",     action: "allow", reason: "Safe: git diff" },
  { tool: "Bash", pattern: "git log",      action: "allow", reason: "Safe: git log" },
  { tool: "Bash", pattern: "git branch",   action: "allow", reason: "Safe: git branch" },
  { tool: "Bash", pattern: "git remote",   action: "allow", reason: "Safe: git remote" },
  { tool: "Bash", pattern: "git show",     action: "allow", reason: "Safe: git show" },
  { tool: "Bash", pattern: "git stash list", action: "allow", reason: "Safe: git stash list" },

  // Dev tools — read-only / safe
  { tool: "Bash", pattern: "node --version", action: "allow", reason: "Safe: version check" },
  { tool: "Bash", pattern: "npm ls",     action: "allow", reason: "Safe: list packages" },
  { tool: "Bash", pattern: "npm test",   action: "allow", reason: "Safe: run tests" },
  { tool: "Bash", pattern: "npm run build", action: "allow", reason: "Safe: build" },
  { tool: "Bash", pattern: "npx tsc --noEmit", action: "allow", reason: "Safe: typecheck" },
  { tool: "Bash", pattern: "npx tsc --no-emit", action: "allow", reason: "Safe: typecheck" },
];

export interface PermissionRule {
  tool: string;
  pattern: string;
  action: "allow" | "deny";
  reason: string;
}
