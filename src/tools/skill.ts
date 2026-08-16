// Skill tool — lets the model invoke fork-mode skills directly
// Inline skills live in the system prompt; fork skills are callable via this tool.

import type { ToolDefinition, AgentContext } from "../shared/core-types.js";
import { getSkillRegistry } from "../skills/registry.js";
import { resolveSubagentTools } from "../agent/subagent.js";
import { processSubagentRegistry } from "../agent/subagents/registry.js";

export const skillTool: ToolDefinition = {
  name: "Skill",
  description:
    "Invoke a skill. Skills are packaged instructions for specific tasks. " +
    "Only fork-mode skills are callable via this tool — inline skills are already in context. " +
    "Call with the skill name and optional arguments.",
  inputSchema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "The name of the skill to invoke (e.g., 'code-review', 'test-runner')",
      },
      args: {
        type: "string",
        description: "Optional arguments to pass to the skill (e.g., a file path or task description)",
      },
      timeout_ms: {
        type: "number",
        description: "Generous safety ceiling in milliseconds; not a work budget.",
      },
    },
    required: ["skill", "timeout_ms"],
  },
  type: "write",
  requiresApproval: false, // skill is pre-authorized by definition
  isConcurrencySafe: false,

  handler: async (
    input: Record<string, unknown>,
    ctx: AgentContext
  ) => {
    const skillName = input.skill as string;
    const args = (input.args as string) ?? "";
    const timeoutMs = input.timeout_ms;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { content: "Fork-mode Skill requires a positive timeout_ms safety ceiling.", isError: true };
    }
    if (ctx.taskRuntime) {
      return { content: "Only the root agent can dispatch fork-mode Skills.", isError: true };
    }

    const registry = getSkillRegistry();
    const skill = registry.getSkill(skillName);

    if (!skill) {
      const available = registry
        .listSkills()
        .filter((s) => s.context === "fork")
        .map((s) => s.name)
        .join(", ");
      return {
        content: `Unknown skill "${skillName}". Available fork-mode skills: ${available || "(none)"}`,
        isError: true,
      };
    }

    if (skill.context === "inline") {
      return {
        content:
          `Skill "${skillName}" is an inline skill. Its instructions are already ` +
          `injected into the system prompt — just follow them directly. ` +
          `Fork-mode skills (callable via this tool): ${registry.listSkills().filter((s) => s.context === "fork").map((s) => s.name).join(", ") || "(none)"}`,
        isError: true,
      };
    }

    // Build subagent definition
    const subagentDef = {
      name: skill.name,
      description: skill.description ?? `Run the "${skill.name}" skill`,
      systemPrompt:
        skill.systemPrompt ??
        `You are the "${skill.name}" skill. ${skill.description ?? ""}`,
      tools: skill.tools ?? ["Read", "Grep", "Glob", "Bash"],
      model: skill.model ?? "inherit",
      readonly: true,
    };

    const task = args || `Run the "${skill.name}" skill`;
    try {
      const runtime = processSubagentRegistry.getOrCreate(ctx.sessionId, ctx.workingDir, ctx.config);
      const submitted = runtime.submit({
        description: `${skill.name} skill`,
        prompt: task,
        subagent_type: skill.name,
        model: skill.model,
        timeout_ms: timeoutMs,
      }, ctx, subagentDef, resolveSubagentTools(subagentDef));
      return {
        content: [
          `Background Skill queued: ${submitted.task.taskId}`,
          `Status: ${submitted.task.status}`,
          `Report: ${submitted.task.artifacts.report}`,
        ].join("\n"),
      };
    } catch (err) {
      return {
        content: `Skill "${skillName}" failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
