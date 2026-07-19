// Sandbox interface — execution boundary for all Tool operations
// Every Tool must pass through a Sandbox for each I/O interaction.
// Policy says WHAT is allowed; Sandbox enforces HOW it's safely executed.

import type { ToolResult } from "../../shared/core-types.js";

/** Risk level for a tool operation. */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Verdict from the policy + sandbox evaluation.
 *
 * "allow"   — safe, proceed without interruption
 * "warn"    — edge case (e.g. rm ./node_modules), proceed but notify
 * "confirm" — requires interactive user approval (e.g. git push --force)
 * "deny"    — hard block (e.g. rm -rf /, SSRF, path traversal)
 */
export type SecurityVerdict = "allow" | "warn" | "confirm" | "deny";

/** Constraints applied by the security decision. */
export interface SecurityConstraints {
  /** Limit operation to within the workspace directory. */
  workspaceOnly: boolean;
  /** Maximum allowed execution time in ms. */
  timeout: number;
  /** Whether network access is permitted. */
  networkAllowed: boolean;
  /** If network is restricted, allowed domains (empty = none). */
  allowedDomains: string[];
  /** Allowed filesystem paths (empty = workspace root only). */
  filesystemScope: string[];
}

/**
 * Structured security error returned to the model when blocked.
 * The model can use `suggestion` to self-correct without re-planning.
 */
export interface SecurityBlock {
  /** Machine-readable reason code. */
  type: "security_denied";
  /** Human-readable explanation. */
  reason: string;
  /** What was blocked (file path, URL, command, etc.). */
  target?: string;
  /** Hint for the model to self-correct (e.g. "Use workspace-relative path"). */
  suggestion: string;
}

/** Complete security decision produced by PolicyEngine + Sandbox evaluation. */
export interface SecurityDecision {
  verdict: SecurityVerdict;
  constraints: SecurityConstraints;
  risk: RiskLevel;
  reason: string;
  /** Input after sandbox normalization. Tool execution must prefer this. */
  sanitizedInput?: Record<string, unknown>;
  /** When verdict is "deny" or "confirm", structured error for the model. */
  block?: SecurityBlock;
}

/**
 * Result of a sandbox validation.
 * If allowed is false, the operation must not proceed.
 */
export interface SandboxResult {
  allowed: boolean;
  reason?: string;
  /** Modified input that is safe to execute. */
  sanitizedInput?: Record<string, unknown>;
}

// ---- Default constraints ----

export const DEFAULT_CONSTRAINTS: SecurityConstraints = {
  workspaceOnly: true,
  timeout: 120_000,
  networkAllowed: false,
  allowedDomains: [],
  filesystemScope: [],
};

// ---- ISandbox interface ----

/**
 * A Sandbox validates and potentially modifies tool input before execution.
 * Implementations handle: filesystem, shell, network, git, and environment.
 */
export interface ISandbox {
  readonly name: string;

  /**
   * Validate and sanitize tool input. Returns a SandboxResult.
   * - If allowed=false, the tool must NOT execute.
   * - If allowed=true, use sanitizedInput (or original input if none provided).
   */
  validate(toolName: string, input: Record<string, unknown>, workingDir: string): SandboxResult;
}
