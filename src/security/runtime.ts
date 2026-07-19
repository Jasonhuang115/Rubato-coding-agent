// Security Runtime — unified entry point for policy evaluation + sandbox enforcement
// Policy says WHAT is allowed; Sandbox enforces HOW it's safely executed.

import { PolicyEngine } from "../permissions/policy.js";
import type { AgentConfig } from "../shared/core-types.js";
import type { SecurityDecision, SecurityVerdict, RiskLevel } from "./sandbox/sandbox.js";
import type { SandboxResult } from "./sandbox/sandbox.js";
import { CompositeSandbox } from "./sandbox/composite.js";
import { FsSandbox } from "./sandbox/fs-sandbox.js";
import { ShellSandbox } from "./sandbox/shell-sandbox.js";
import { NetworkSandbox } from "./sandbox/network-sandbox.js";
import { GitSandbox } from "./sandbox/git-sandbox.js";
import { EnvSandbox } from "./sandbox/env-sandbox.js";

export { EnvSandbox } from "./sandbox/env-sandbox.js";
export type { SecurityDecision, SecurityVerdict, RiskLevel, SandboxResult } from "./sandbox/sandbox.js";
export type { ISandbox } from "./sandbox/sandbox.js";

/**
 * SecurityRuntime combines the PolicyEngine with sandbox enforcement.
 * It's the single entry point for all tool safety checks.
 */
export class SecurityRuntime {
  readonly policyEngine: PolicyEngine;
  readonly sandbox: CompositeSandbox;
  readonly envSandbox: EnvSandbox;

  constructor(permissions: AgentConfig["permissions"]) {
    this.policyEngine = new PolicyEngine(permissions);
    this.envSandbox = new EnvSandbox();
    this.sandbox = new CompositeSandbox([
      new FsSandbox(),
      new ShellSandbox(),
      new NetworkSandbox(),
      new GitSandbox(),
      this.envSandbox,
    ]);
  }

  /**
   * Full security check: policy evaluation + sandbox validation.
   * Returns a SecurityDecision that tells the caller what to do.
   */
  evaluate(toolName: string, input: Record<string, unknown>, workingDir: string): SecurityDecision {
    // 1. Policy check (is this allowed?)
    const policyResult = this.policyEngine.check(toolName, input);

    if (!policyResult.allowed) {
      const mode = "mode" in policyResult ? policyResult.mode : "manual";
      const reason = "reason" in policyResult ? policyResult.reason : "Blocked by policy";

      // Map policy mode to security verdict
      if (mode === "manual") {
        return {
          verdict: "deny",
          risk: "critical",
          reason,
          block: {
            type: "security_denied",
            reason,
            suggestion: `The tool "${toolName}" is blocked by policy. Consider an alternative approach.`,
          },
          constraints: this.defaultConstraints(),
        };
      }

      // mode === "confirm" — needs user approval
      return {
        verdict: "confirm",
        risk: "medium",
        reason,
        block: {
          type: "security_denied",
          reason,
          target: toolName,
          suggestion: `This operation requires user approval. Await confirmation before proceeding.`,
        },
        constraints: this.defaultConstraints(),
      };
    }

    // 2. Sandbox validation (how to safely execute?)
    const sandboxResult = this.sandbox.validate(toolName, input, workingDir);

    if (!sandboxResult.allowed) {
      const sandboxReason = sandboxResult.reason ?? "Blocked by sandbox";
      return {
        verdict: "deny",
        risk: "high",
        reason: sandboxReason,
        block: {
          type: "security_denied",
          reason: sandboxReason,
          target: this.extractTarget(toolName, input),
          suggestion: this.buildSuggestion(toolName, sandboxReason),
        },
        constraints: this.defaultConstraints(),
      };
    }

    // 3. Assess risk beyond binary allow/deny
    const risk = this.assessRisk(toolName, input);

    // Edge-case commands get a "warn" verdict (model sees it but can proceed)
    if (this.shouldWarn(toolName, input)) {
      return {
        verdict: "warn",
        risk,
        reason: `This ${toolName} operation is allowed but potentially risky.`,
        constraints: {
          workspaceOnly: true,
          timeout: toolName === "Bash" ? 600_000 : 120_000,
          networkAllowed: toolName === "WebFetch" || toolName === "WebSearch",
          allowedDomains: [],
          filesystemScope: [],
        },
      };
    }

    // 4. Allowed
    return {
      verdict: "allow",
      risk,
      reason: "Approved",
      constraints: {
        workspaceOnly: true,
        timeout: toolName === "Bash" ? 600_000 : 120_000,
        networkAllowed: toolName === "WebFetch" || toolName === "WebSearch",
        allowedDomains: [],
        filesystemScope: [],
      },
    };
  }

  /**
   * Quick sandbox-only validation (skip policy, for tools already approved by policy).
   */
  validateSandbox(toolName: string, input: Record<string, unknown>, workingDir: string): SandboxResult {
    return this.sandbox.validate(toolName, input, workingDir);
  }

  /**
   * Get sanitized environment variables for child processes.
   */
  filterEnv(): Record<string, string | undefined> {
    return this.envSandbox.filterEnv();
  }

  // ---- Private ----

  private defaultConstraints() {
    return {
      workspaceOnly: true,
      timeout: 120_000,
      networkAllowed: false,
      allowedDomains: [] as string[],
      filesystemScope: [] as string[],
    };
  }

  /** Extract a human-readable target identifier from tool input. */
  private extractTarget(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "Read":
      case "Write":
      case "Edit":
        return (input.file_path as string) ?? "(unknown)";
      case "Bash":
        return (input.command as string)?.slice(0, 80) ?? "(unknown)";
      case "WebFetch":
      case "WebSearch":
        return (input.url as string) ?? (input.query as string) ?? "(unknown)";
      default:
        return toolName;
    }
  }

  /** Build a helpful suggestion based on the tool and the denial reason. */
  private buildSuggestion(toolName: string, reason: string): string {
    if (reason.includes("outside workspace") || reason.includes("path traversal")) {
      return "Use workspace-relative paths. The tool can only access files within the project directory.";
    }
    if (reason.includes("metacharacter") || reason.includes("command injection")) {
      return "Avoid shell metacharacters (` ; | $()). Use a direct command without chaining.";
    }
    if (reason.includes("Sensitive path") || reason.includes("secret")) {
      return "This file contains sensitive data. Use configuration files or environment variables instead.";
    }
    if (reason.includes("private IP") || reason.includes("SSRF") || reason.includes("internal network")) {
      return "This URL targets an internal network. Use public URLs only.";
    }
    if (reason.includes("Network command") || reason.includes("blocked")) {
      return `This ${toolName} command is blocked for safety. Consider using a dedicated tool instead.`;
    }
    if (reason.includes("destructive") || reason.includes("force-push") || reason.includes("reset --hard")) {
      return "This git operation is destructive. Use safer alternatives (e.g., git revert, new branch).";
    }
    return "Consider an alternative approach that doesn't require this operation.";
  }

  /** Check if this command warrants a "warn" (not deny) verdict. */
  private shouldWarn(toolName: string, input: Record<string, unknown>): boolean {
    if (toolName === "Bash") {
      const cmd = ((input.command as string) ?? "").toLowerCase();
      // rm against a relative path (like rm -rf ./node_modules) — warn, not deny
      if (/\brm\s+(-[^\s]*\s+)*\.\//.test(cmd)) return true;
      // chmod/chown in workspace — warn
      if (/\bch(mod|own)\s/.test(cmd)) return true;
    }
    return false;
  }

  private assessRisk(toolName: string, input: Record<string, unknown>): RiskLevel {
    // High risk: write tools
    if (["Write", "Edit"].includes(toolName)) return "medium";
    // Critical: shell execution
    if (toolName === "Bash") {
      const cmd = (input.command as string) ?? "";
      if (cmd.includes("sudo ")) return "critical";
      if (cmd.includes("rm ") || cmd.includes("mv /")) return "high";
      return "medium";
    }
    // Medium: network
    if (toolName === "WebFetch" || toolName === "WebSearch") return "medium";
    // Low: everything else
    return "low";
  }
}
