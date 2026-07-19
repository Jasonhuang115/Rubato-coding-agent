// Agent tool — spawn a subagent to handle independent subtasks
// Supports: built-in types, custom definitions, worktree isolation, background execution

import fs from "fs";
import type { ToolDefinition, AgentContext } from "../shared/core-types.js";
import { getBuiltinDefinition, spawnSubagent, spawnSubagentInWorktree, spawnSubagentInBackground } from "../agent/subagent.js";
import { findDefinition, getAllDefinitions } from "../agent/agent-defs.js";

async function getAvailableTypes(): Promise<string> {
  const defs = await getAllDefinitions();
  return defs.map((d) => `"${d.name}"`).join(" | ");
}

export const agentTool: ToolDefinition = {
  name: "Agent",
  description:
    "Launch a subagent to handle complex, multi-step tasks autonomously. " +
    "Subagents have scoped tools and run independently. " +
    "Use for: parallel exploration, codebase research, verification, or any task " +
    "that can be delegated without the full tool set." +
    "\n\n**Background subagents:** When you spawn a subagent with `run_in_background: true`, " +
    "continue working on other aspects of the task. In a later turn, Read the results file " +
    "and merge the subagent's findings into your final answer. " +
    "Do NOT give your final conclusion until you have incorporated background subagent results." +
    "\n\nAvailable subagent types: explore | general | verify (plus custom from .rubato/agents/*.md)" +
    "\n\nOptions:" +
    "\n- isolation: \"worktree\" runs the subagent in a git worktree for safe writes." +
    "\n- run_in_background: true to run asynchronously.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "A short (3-5 word) description of the task" },
      prompt: { type: "string", description: "The task for the subagent to perform" },
      subagent_type: { type: "string", description: "Type: 'explore', 'general', 'verify', or custom name from .rubato/agents/*.md" },
      model: { type: "string", description: "Optional model override. Use 'inherit' (default) or a specific model ID." },
      isolation: { type: "string", enum: ["none", "worktree"], description: "Isolation mode. 'worktree' creates a git worktree. Default: 'none'." },
      run_in_background: { type: "boolean", description: "Run subagent in background. Default: false." },
    },
    required: ["description", "prompt"],
  },
  type: "write",
  requiresApproval: false,
  async handler(input, ctx: AgentContext) {
    const subagentType = (input.subagent_type as string) ?? "general";
    const prompt = input.prompt as string;
    const model = input.model as string | undefined;
    const isolation = (input.isolation as string) ?? "none";
    const runInBackground = input.run_in_background === true;

    let definition;
    try {
      definition = getBuiltinDefinition(subagentType);
    } catch {
      const customDef = await findDefinition(subagentType);
      if (!customDef) {
        const defs = await getAllDefinitions();
        return { content: `Unknown subagent type "${subagentType}". Available: ${defs.map((d) => d.name).join(", ")}.`, isError: true };
      }
      definition = customDef;
    }

    if (model) definition.model = model;

    // Background execution — write results to a file the agent can Read later
    if (runInBackground) {
      const handle = spawnSubagentInBackground(definition, prompt, ctx, ctx.config);
      const resultsPath = `/tmp/rubato-subagent-${handle.agentId}.md`;

      // Fire-and-forget: wait for result, ALWAYS write to file
      handle.wait().then((r) => {
        try {
          const content = `# Subagent Result: ${definition.name}\n**Agent ID:** ${handle.agentId}\n**Status:** ${r.status}\n**Tokens:** ${r.usage.inputTokens} in / ${r.usage.outputTokens} out | **Tool calls:** ${r.usage.toolCalls}\n\n---\n\n${r.output || "(no output)"}`;
          fs.writeFileSync(resultsPath, content, "utf-8");
        } catch {
          // Last-resort: write even if everything above failed
          try { fs.writeFileSync(resultsPath, `# Subagent Result: ${definition.name}\n**Status:** failed to produce output`, "utf-8"); } catch {}
        }
      }).catch((err) => {
        // Subagent itself crashed — still write a file so agent knows it's done
        try {
          fs.writeFileSync(resultsPath, `# Subagent Result: ${definition.name}\n**Agent ID:** ${handle.agentId}\n**Status:** failed\n**Error:** ${err instanceof Error ? err.message : String(err)}`, "utf-8");
        } catch {}
      });

      return {
        content:
          `## Background Subagent Spawned\n` +
          `**Agent ID:** ${handle.agentId}\n` +
          `**Type:** ${definition.name}\n` +
          `**Status:** running in background\n\n` +
          `The subagent is working independently. ` +
          `When it finishes, results will be written to \`${resultsPath}\`. ` +
          `You can continue with other tasks and Read \`${resultsPath}\` ` +
          `in a later turn to merge its findings. ` +
          `If the file doesn't exist yet, the subagent is still running — ` +
          `check again in the next turn.`,
      };
    }

    // Worktree isolation
    let result;
    if (isolation === "worktree") {
      result = await spawnSubagentInWorktree(definition, prompt, ctx, ctx.config);
    } else {
      result = await spawnSubagent(definition, prompt, ctx, ctx.config);
    }

    const isolationNote = isolation === "worktree" ? " [isolated worktree]" : "";
    const header = `## Subagent: ${definition.name}${isolationNote} (${result.status})\n**Agent ID:** ${result.agentId}\n**Tokens:** ${result.usage.inputTokens} in / ${result.usage.outputTokens} out | **Tool calls:** ${result.usage.toolCalls}\n\n---\n\n`;

    return { content: header + result.output, isError: result.status === "failed" };
  },
};
