// ApprovalManager — interactive user confirmation for "confirm" verdict tools.
// Called by ToolRuntime when the security decision requires user input.
// Tracks session-level decisions (allow_always / deny_always).

import type { ConfirmDecision } from "../shared/core-types.js";

export type { ConfirmDecision };

export interface ApprovalPrompt {
  toolName: string;
  input: Record<string, unknown>;
  risk: string;
  reason: string;
}

/**
 * Callback-based approval handler.
 *
 * When a tool gets a "confirm" verdict, the ApprovalManager is invoked.
 * It delegates to the provided onConfirm callback (from the CLI layer)
 * and tracks session-level decisions.
 */
export class ApprovalManager {
  private alwaysAllowed: Set<string> = new Set();
  private alwaysDenied: Set<string> = new Set();
  private onConfirm?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmDecision>;

  constructor(onConfirm?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmDecision>) {
    this.onConfirm = onConfirm;
  }

  /**
   * Set the confirmation callback (e.g., after reconnecting to a session).
   */
  setCallback(onConfirm: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmDecision>): void {
    this.onConfirm = onConfirm;
  }

  /**
   * Check if this tool was already decided this session.
   */
  private checkCached(toolName: string): ConfirmDecision | null {
    if (this.alwaysAllowed.has(toolName)) return "allow_always";
    if (this.alwaysDenied.has(toolName)) return "deny_always";
    return null;
  }

  /**
   * Request user approval for a tool call.
   * Returns the user's decision or auto-approves when no callback is available.
   */
  async requestApproval(prompt: ApprovalPrompt): Promise<ConfirmDecision> {
    // Check cached decision first
    const cached = this.checkCached(prompt.toolName);
    if (cached) return cached;

    // No callback → auto-approve (subagent / non-interactive mode)
    if (!this.onConfirm) {
      return "allow_once";
    }

    const decision = await this.onConfirm(prompt.toolName, prompt.input);

    // Track session-level decisions
    switch (decision) {
      case "allow_always":
        this.alwaysAllowed.add(prompt.toolName);
        break;
      case "deny_always":
        this.alwaysDenied.add(prompt.toolName);
        break;
    }

    return decision;
  }

  /**
   * Reset all session-level decisions.
   */
  reset(): void {
    this.alwaysAllowed.clear();
    this.alwaysDenied.clear();
  }
}
