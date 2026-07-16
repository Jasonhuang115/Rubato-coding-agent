// Agent tool — spawn a subagent to handle independent subtasks
// Subagents run with scoped tools and return results to the parent

import type { ToolDefinition, AgentContext } from "../core-types.js";
import { getBuiltinDefinition, spawnSubagent } from "../agent/subagent.js";

export const agentTool: ToolDefinition = {
  name: "Agent",
  description:
    "Launch a subagent to handle complex, multi-step tasks. " +
    "Subagents have scoped tools (no Agent tool access by default) and run independently. " +
    "Use for: parallel exploration, codebase research, verification, or any task " +
    "that can be delegated without the full tool set." +
    "\n\nAvailable subagent types:" +
    "\n- explore: Read-only search agent with Read, Grep, Glob, Bash. Use for broad codebase exploration." +
    "\n- general: Full tool access (except Agent). Use for multi-step implementation tasks." +
    "\n- verify: Read-only verification agent. Use to check correctness of code or claims.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A short (3-5 word) description of the task",
      },
      prompt: {
        type: "string",
        description: "The task for the subagent to perform",
      },
      subagent_type: {
        type: "string",
        description: "Type of subagent: 'explore' (read-only search), 'general' (full access), 'verify' (adversarial check)",
        enum: ["explore", "general", "verify"],
      },
      model: {
        type: "string",
        description: "Optional model override for this subagent. Use 'inherit' (default) or a specific model ID.",
      },
    },
    required: ["description", "prompt"],
  },
  type: "write",
  requiresApproval: false,
  async handler(input, ctx: AgentContext) {
    const subagentType = (input.subagent_type as string) ?? "general";
    const description = input.description as string;
    const prompt = input.prompt as string;
    const model = input.model as string | undefined;

    let definition;
    try {
      definition = getBuiltinDefinition(subagentType);
    } catch {
      return {
        content: `Unknown subagent type "${subagentType}". Available: explore, general, verify.`,
        isError: true,
      };
    }

    if (model) {
      definition.model = model;
    }

    const result = await spawnSubagent(definition, prompt, ctx, ctx.config);

    const header =
      `## Subagent: ${definition.name} (${result.status})\n` +
      `**Agent ID:** ${result.agentId}\n` +
      `**Tokens:** ${result.usage.inputTokens} in / ${result.usage.outputTokens} out | ` +
      `**Tool calls:** ${result.usage.toolCalls}\n\n` +
      `---\n\n`;

    return {
      content: header + result.output,
      isError: result.status === "failed",
    };
  },
};
