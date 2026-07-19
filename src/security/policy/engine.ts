// Policy Engine — unified permission evaluation
// Migrated from permissions/policy.ts.
// Answers "is this tool call allowed?" before sandbox enforcement.

import type { PermissionManager, PermissionResult, AgentConfig } from "../../shared/core-types.js";
import { HARD_BLACKLIST, DEFAULT_ALLOW_RULES } from "./rules.js";
import type { PermissionRule } from "./rules.js";

export { HARD_BLACKLIST, DEFAULT_ALLOW_RULES };
export type { PermissionRule };

export class PolicyEngine implements PermissionManager {
  private config: AgentConfig["permissions"];
  private allowedTools: Set<string> = new Set();
  private deniedTools: Set<string> = new Set();

  constructor(config: AgentConfig["permissions"]) {
    this.config = config;
  }

  check(toolName: string, input: Record<string, unknown>): PermissionResult {
    // 1. Hard blacklist (always enforced)
    const blacklistResult = this.checkBlacklist(toolName, input);
    if (blacklistResult) return blacklistResult;

    // 2. Session-level allow/deny (user previously decided)
    if (this.allowedTools.has(toolName)) {
      return { allowed: true };
    }
    if (this.deniedTools.has(toolName)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" was denied earlier this session.`,
        mode: "manual",
      };
    }

    // 3. Custom rules (user rules first, then defaults)
    const ruleResult = this.checkRules(toolName, input);
    if (ruleResult) return ruleResult;

    // 4. Fall back to tool-level mode
    const mode = this.getToolMode(toolName);
    switch (mode) {
      case "auto":
        return { allowed: true };
      case "manual":
        return {
          allowed: false,
          reason: `Tool "${toolName}" is set to manual mode. Use /permissions to adjust.`,
          mode: "manual",
        };
      case "confirm":
      default:
        return {
          allowed: false,
          reason: `Tool "${toolName}" requires confirmation.`,
          mode: "confirm",
        };
    }
  }

  allowTool(toolName: string): void {
    this.allowedTools.add(toolName);
  }

  denyTool(toolName: string): void {
    this.deniedTools.add(toolName);
  }

  resetTool(toolName: string): void {
    this.allowedTools.delete(toolName);
    this.deniedTools.delete(toolName);
  }

  // ---- Private ----

  private checkBlacklist(toolName: string, input: Record<string, unknown>): PermissionResult | null {
    const command = (input.command as string) ?? (input.file_path as string) ?? JSON.stringify(input);
    for (const rule of HARD_BLACKLIST) {
      if (rule.tool !== toolName && rule.tool !== "*") continue;
      if (command.includes(rule.pattern)) {
        return {
          allowed: false,
          reason: `Blocked by security policy: ${rule.reason}`,
          mode: "manual",
        };
      }
    }
    return null;
  }

  private checkRules(toolName: string, input: Record<string, unknown>): PermissionResult | null {
    const allRules = [
      ...(this.config.rules ?? []),
      ...DEFAULT_ALLOW_RULES,
    ];

    const command = (input.command as string) ?? (input.file_path as string) ?? JSON.stringify(input);
    for (const rule of allRules) {
      if (rule.tool !== toolName && rule.tool !== "*") continue;
      if (command.includes(rule.pattern)) {
        if (rule.action === "deny") {
          return {
            allowed: false,
            reason: `Blocked by rule: "${rule.pattern}"${rule.reason ? ` — ${rule.reason}` : ""}`,
            mode: "manual",
          };
        }
        if (rule.action === "allow") {
          return { allowed: true };
        }
      }
    }
    return null;
  }

  private getToolMode(toolName: string): string {
    const key = toolName.toLowerCase();
    switch (key) {
      case "bash": return this.config.bash;
      case "read":
      case "glob":
      case "grep": return this.config.read;
      case "write": return this.config.write;
      case "edit": return this.config.edit;
      case "webfetch":
      case "websearch": return this.config.web;
      default: return "confirm";
    }
  }
}
