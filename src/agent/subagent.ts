// Subagent system — recursive agentLoop() with scoped tools
// Built-in types: Explore, General, Verify

import { randomUUID } from "crypto";
import type {
  SubagentDefinition,
  SubagentResult,
  AgentContext,
  AgentConfig,
  ToolDefinition,
} from "../core-types.js";
import { getTool, getAllTools } from "../tools/registry.js";
import { agentLoop } from "./loop.js";

// ---- Built-in subagent definitions ----

const EXPLORE_TOOLS = ["Read", "Grep", "Glob", "Bash"];

export const EXPLORE_DEF: SubagentDefinition = {
  name: "explore",
  description:
    "Read-only search agent for broad fan-out searches. " +
    "Use when answering means sweeping many files, directories, or naming conventions. " +
    "Reads excerpts rather than whole files — locates code, doesn't review it.",
  systemPrompt: [
    "You are a code exploration agent. Your job is to search the codebase and report findings.",
    "",
    "## Rules",
    "- You have Read, Grep, Glob, and Bash (read-only) tools.",
    "- Search broadly — check multiple directories, naming conventions, and patterns.",
    "- Return a structured summary of what you found: file paths, relevant code snippets, patterns.",
    "- Be thorough but concise. The parent agent needs actionable information, not narration.",
    "- Do NOT edit or write files. You are read-only.",
    "- When done, output your findings and stop.",
  ].join("\n"),
  tools: EXPLORE_TOOLS,
  readonly: true,
  maxTurns: 15,
};

export const GENERAL_DEF: SubagentDefinition = {
  name: "general",
  description:
    "General-purpose subagent for researching complex questions, searching for code, " +
    "and executing multi-step tasks. Has access to all tools except spawning sub-agents.",
  systemPrompt: [
    "You are a general-purpose coding subagent. You have access to Read, Write, Edit, Grep, Glob, Bash, and Web tools.",
    "",
    "## Rules",
    "- Complete the assigned task and report results concisely.",
    "- Do NOT spawn other subagents (you don't have the Agent tool).",
    "- You share the parent agent's working directory. Be careful with writes.",
    "- When done, summarize what you did and what you found.",
  ].join("\n"),
  tools: ["*"],
  readonly: false,
  maxTurns: 15,
};

export const VERIFY_DEF: SubagentDefinition = {
  name: "verify",
  description:
    "Verification subagent for adversarial review. Read-only — checks correctness, " +
    "identifies edge cases, and validates claims made by other agents.",
  systemPrompt: [
    "You are a verification agent. Your job is to critically examine claims, code, or findings.",
    "",
    "## Rules",
    "- You have Read, Grep, Glob, and Bash (read-only) tools.",
    "- Be skeptical. Assume there might be errors and look for them.",
    "- Check: does the code compile? Are edge cases handled? Are claims supported by evidence?",
    "- Report issues found with specific file paths and line numbers.",
    "- If you find nothing wrong, say so clearly — don't invent issues.",
    "- Do NOT edit or write files. You are read-only.",
  ].join("\n"),
  tools: EXPLORE_TOOLS,
  readonly: true,
  maxTurns: 10,
};

const BUILTIN_DEFS: Record<string, SubagentDefinition> = {
  explore: EXPLORE_DEF,
  general: GENERAL_DEF,
  verify: VERIFY_DEF,
};

export function getBuiltinDefinition(name: string): SubagentDefinition {
  const def = BUILTIN_DEFS[name];
  if (!def) {
    throw new Error(
      `Unknown subagent type "${name}". Available: ${Object.keys(BUILTIN_DEFS).join(", ")}`
    );
  }
  return { ...def };
}

// ---- Tool set resolution ----

function resolveTools(allowlist: string[]): ToolDefinition[] {
  if (allowlist.includes("*")) {
    return getAllTools().filter((t) => t.name !== "Agent");
  }
  return allowlist
    .map((name) => getTool(name))
    .filter((t): t is ToolDefinition => t !== undefined && t.name !== "Agent");
}

// ---- Spawn primitive ----

export async function spawnSubagent(
  definition: SubagentDefinition,
  task: string,
  parentCtx: AgentContext,
  parentConfig: AgentConfig
): Promise<SubagentResult> {
  const agentId = `${parentCtx.sessionId}-sub-${randomUUID().slice(0, 8)}`;
  const tools = resolveTools(definition.tools);

  const modelConfig = { ...parentConfig.model };
  if (definition.model && definition.model !== "inherit") {
    modelConfig.model = definition.model;
  }

  const subConfig: AgentConfig = {
    ...parentConfig,
    model: modelConfig,
  };

  const outputParts: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;
  let finalStatus: SubagentResult["status"] = "completed";

  try {
    for await (const event of agentLoop({
      config: subConfig,
      workingDir: parentCtx.workingDir,
      prompt: `[Subagent: ${definition.name}]\n\n${task}`,
      renderer: new NoopRenderer(),
      sessionId: agentId,
      tools,
    })) {
      switch (event.type) {
        case "text":
          outputParts.push(event.text);
          break;
        case "tool_result":
          toolCallCount++;
          break;
        case "turn_end":
          if (event.usage) {
            totalInputTokens += event.usage.input;
            totalOutputTokens += event.usage.output;
          }
          break;
        case "error":
          outputParts.push(`[Error] ${event.message}`);
          break;
        case "done":
          if (event.reason !== "end_turn") {
            finalStatus = event.reason === "max_turns" ? "timeout" : "failed";
          }
          break;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    outputParts.push(`[Fatal] ${message}`);
    finalStatus = "failed";
  }

  return {
    status: finalStatus,
    agentId,
    output: outputParts.join("\n"),
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolCalls: toolCallCount,
    },
  };
}

// ---- No-op renderer ----

class NoopRenderer {
  renderUserMessage(_text: string): void {}
  renderAssistantMessage(_text: string): void {}
  renderThinking(_text: string): void {}
  renderSystemMessage(_text: string): void {}
  renderToolUse(_tool: string, _input: unknown): void {}
  renderToolResult(_result: string): void {}
  renderError(_error: string): void {}
  renderWarning(_warning: string): void {}
  clear(): void {}
  flush(): void {}
}
