// Skill tool — lets the model invoke fork-mode skills directly
// Inline skills live in the system prompt; fork skills are callable via this tool.

import type { ToolDefinition, AgentContext } from "../core-types.js";
import { getSkillRegistry } from "../skills/registry.js";
import { spawnSubagent } from "../agent/subagent.js";
import { PolicyEngine } from "../permissions/policy.js";

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
    },
    required: ["skill"],
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
      maxTurns: skill.maxTurns ?? 15,
    };

    // Apply allowed-tools
    let permissions = ctx.config.permissions;
    if (skill.allowedTools && skill.allowedTools.length > 0) {
      const allowRules = skill.allowedTools.map((pattern) => ({
        tool: "*" as const,
        pattern,
        action: "allow" as const,
        reason: `Skill "${skill.name}" pre-authorization`,
      }));
      permissions = {
        ...permissions,
        rules: [...(permissions.rules ?? []), ...allowRules],
      };
    }

    const subCtx: AgentContext = {
      ...ctx,
      sessionId: `${ctx.sessionId}-skill-${skillName}`,
      permissionManager: new PolicyEngine(permissions),
      config: { ...ctx.config, permissions },
    };

    const task = args || `Run the "${skill.name}" skill`;

    try {
      const result = await spawnSubagent(subagentDef, task, subCtx, {
        ...ctx.config,
        permissions,
      });

      return {
        content: result.output || `Skill "${skillName}" completed with no output.`,
        isError: result.status !== "completed",
      };
    } catch (err) {
      return {
        content: `Skill "${skillName}" failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
