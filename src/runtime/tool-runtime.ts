// ToolRuntime — sandboxed tool dispatcher
//
// Sits between the agent loop and dispatch(), enforcing security policy
// before any tool handler runs. Future policies (audit, telemetry, retry,
// timeout, cache) attach here — dispatch() stays a pure tool router.
//
// Architecture:
//
//   Loop → ToolRuntime.execute()
//              ├── SecurityRuntime.evaluate()
//              │       ├── PolicyEngine.check()
//              │       └── CompositeSandbox.validate()
//              ├── onConfirmTool (for "confirm" verdicts)
//              └── dispatch()

import { SecurityRuntime } from "../security/runtime.js";
import type { SecurityDecision } from "../security/sandbox/sandbox.js";
import { dispatch } from "../tools/registry.js";
import type {
  AgentContext,
  ConfirmDecision,
  TaskCompletionControl,
  ToolDefinition,
  ToolResult,
} from "../shared/core-types.js";

// ---- Types ----

export interface ToolRuntimeResult {
  content: string;
  isError: boolean;
  /** True when the user explicitly denied a "confirm" tool. */
  denied: boolean;
  control?: TaskCompletionControl;
  /** Security metadata attached to every execution (for audit / logging). */
  security?: {
    verdict: SecurityDecision["verdict"];
    risk: SecurityDecision["risk"];
    reason: string;
  };
}

export interface ToolRuntimeOptions {
  securityRuntime: SecurityRuntime;
  workingDir: string;
  /** The exact per-agent tool set. Prevents dispatching tools outside it. */
  tools?: ToolDefinition[];
  /**
   * Interactive confirmation callback. Called when the security verdict is
   * "confirm". If not provided, confirm-mode tools are denied in non-interactive
   * sessions (subagents, one-shot mode).
   */
  onConfirmTool?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<ConfirmDecision>;
}

// ---- ToolRuntime ----

export class ToolRuntime {
  private securityRuntime: SecurityRuntime;
  private workingDir: string;
  private onConfirmTool?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<ConfirmDecision>;
  private tools?: Map<string, ToolDefinition>;

  constructor(options: ToolRuntimeOptions) {
    this.securityRuntime = options.securityRuntime;
    this.workingDir = options.workingDir;
    this.onConfirmTool = options.onConfirmTool;
    this.tools = options.tools
      ? new Map(options.tools.map((tool) => [tool.name, tool]))
      : undefined;
  }

  /**
   * Execute a tool call through the security policy layer.
   *
   * Flow:
   * 1. SecurityRuntime.evaluate() → SecurityDecision
   * 2. "deny"   → structured error with suggestion (model can self-correct)
   * 3. "confirm" → interactive approval via onConfirmTool callback
   * 4. "warn"   → proceed but attach warning metadata
   * 5. "allow"  → dispatch to tool handler
   */
  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: AgentContext,
  ): Promise<ToolRuntimeResult> {
    const scopedTool = this.tools?.get(toolName);
    if (this.tools && !scopedTool) {
      return {
        content: `Tool "${toolName}" is not available in this agent's scoped tool set.`,
        isError: true,
        denied: false,
      };
    }

    // CompleteTask is a runtime control protocol, not a project action. It
    // bypasses ordinary permission policy but remains scoped to subagents.
    if (toolName === "CompleteTask" && scopedTool) {
      return this.fromToolResult(await scopedTool.handler(input, ctx));
    }

    // 1. Security evaluation (PolicyEngine + CompositeSandbox)
    const decision = this.securityRuntime.evaluate(toolName, input, this.workingDir);
    const executableInput = decision.sanitizedInput ?? input;

    // 2. Handle verdicts
    switch (decision.verdict) {
      case "deny":
        return this.denyResult(decision);

      case "confirm":
        return this.handleConfirm(toolName, executableInput, decision, ctx);

      case "warn":
        // Fall through to dispatch — warn is logged but doesn't block
        break;

      case "allow":
        // Safe, fall through to dispatch
        break;
    }

    // 3. Dispatch to tool handler
    const result = await this.dispatchScoped(toolName, executableInput, ctx);

    return {
      ...this.fromToolResult(result),
      security: {
        verdict: decision.verdict,
        risk: decision.risk,
        reason: decision.reason,
      },
    };
  }

  // ---- Private helpers ----

  /** Build a structured denial message the model can learn from. */
  private denyResult(decision: SecurityDecision): ToolRuntimeResult {
    const block = decision.block;
    const lines = [`⛔ Security blocked`];
    if (block) {
      lines.push(`Reason: ${block.reason}`);
      if (block.target) lines.push(`Target: ${block.target}`);
      lines.push(`Suggestion: ${block.suggestion}`);
    } else {
      lines.push(`Reason: ${decision.reason}`);
    }

    return {
      content: lines.join("\n"),
      isError: true,
      denied: false, // not a user denial — a security block
      security: {
        verdict: "deny",
        risk: decision.risk,
        reason: decision.reason,
      },
    };
  }

  /** Handle interactive confirmation flow. */
  private async handleConfirm(
    toolName: string,
    input: Record<string, unknown>,
    decision: SecurityDecision,
    ctx: AgentContext,
  ): Promise<ToolRuntimeResult> {
    if (!this.onConfirmTool) {
      // Non-interactive session (subagent, one-shot): auto-approve confirm tools.
      // Policy check + sandbox validation already passed; no user available to ask.
    } else {
      const userDecision = await this.onConfirmTool(toolName, input);

      switch (userDecision) {
        case "allow_once":
          break; // proceed to dispatch

        case "allow_always":
          this.securityRuntime.policyEngine.allowTool(toolName);
          break; // proceed + remember

        case "deny_once":
          return {
            content: `User denied: ${toolName}`,
            isError: true,
            denied: true,
            security: {
              verdict: "confirm",
              risk: decision.risk,
              reason: "User denied",
            },
          };

        case "deny_always":
          this.securityRuntime.policyEngine.denyTool(toolName);
          return {
            content: `User denied (all future ${toolName} blocked this session)`,
            isError: true,
            denied: true,
            security: {
              verdict: "confirm",
              risk: decision.risk,
              reason: "User denied permanently",
            },
          };
      }
    }

    // allow_once, allow_always, or auto-approve: proceed to dispatch
    const result = await this.dispatchScoped(toolName, input, ctx);

    return {
      ...this.fromToolResult(result),
      security: {
        verdict: decision.verdict,
        risk: decision.risk,
        reason: decision.reason,
      },
    };
  }

  private async dispatchScoped(
    toolName: string,
    input: Record<string, unknown>,
    ctx: AgentContext,
  ): Promise<ToolResult> {
    const scopedTool = this.tools?.get(toolName);
    if (scopedTool) {
      try {
        return await scopedTool.handler(input, ctx);
      } catch (error) {
        return {
          content: `Tool error (${toolName}): ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    }
    return dispatch(toolName, input, ctx);
  }

  private fromToolResult(result: ToolResult): ToolRuntimeResult {
    return {
      content: result.content,
      isError: result.isError ?? false,
      denied: false,
      control: result.control,
    };
  }
}
