// Permission manager — enforces tool access policies

import type {
  PermissionManager,
  PermissionResult,
  AgentConfig,
} from "../core-types.js";
import { HARD_BLACKLIST } from "./config.js";
import type { PermissionRule } from "./config.js";

export class PolicyEngine implements PermissionManager {
  private config: AgentConfig["permissions"];
  private allowedTools: Set<string> = new Set();
  private deniedTools: Set<string> = new Set();

  constructor(config: AgentConfig["permissions"]) {
    this.config = config;
  }

  check(toolName: string, input: Record<string, unknown>): PermissionResult {
    // 1. Check hard blacklist first (always enforced)
    const blacklistResult = this.checkBlacklist(toolName, input);
    if (blacklistResult) return blacklistResult;

    // 2. Check if this tool was previously allowed/denied this session
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

    // 3. Check custom rules
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
        // "confirm" mode — ask the user (handled by the CLI layer)
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

  private checkBlacklist(
    toolName: string,
    input: Record<string, unknown>
  ): PermissionResult | null {
    const command =
      (input.command as string) ??
      (input.file_path as string) ??
      JSON.stringify(input);

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

  private checkRules(
    toolName: string,
    input: Record<string, unknown>
  ): PermissionResult | null {
    if (!this.config.rules) return null;

    const command =
      (input.command as string) ??
      (input.file_path as string) ??
      JSON.stringify(input);

    for (const rule of this.config.rules) {
      if (rule.tool !== toolName && rule.tool !== "*") continue;

      // Simple substring match (Phase 1), Phase 2 adds regex support
      if (command.includes(rule.pattern)) {
        if (rule.action === "deny") {
          return {
            allowed: false,
            reason: `Blocked by custom rule: "${rule.pattern}"`,
            mode: "manual",
          };
        }
      }
    }
    return null;
  }

  private getToolMode(toolName: string): string {
    const key = toolName.toLowerCase();
    switch (key) {
      case "bash":
        return this.config.bash;
      case "read":
        return this.config.read;
      case "write":
        return this.config.write;
      case "edit":
        return this.config.edit;
      case "webfetch":
      case "websearch":
        return this.config.web;
      default:
        return "confirm";
    }
  }
}
