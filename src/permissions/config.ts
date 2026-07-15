// Default permission configuration

import type { AgentConfig } from "../core-types.js";

export const DEFAULT_PERMISSIONS: AgentConfig["permissions"] = {
  bash: "confirm",
  read: "auto",
  write: "confirm",
  edit: "confirm",
  web: "confirm",
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

export interface PermissionRule {
  tool: string;
  pattern: string;
  action: "allow" | "deny";
  reason: string;
}
