// Skill type definitions — superset of SubagentDefinition
// Supports three format levels:
//   Level 1: single .md file (frontmatter + body)
//   Level 2: directory with SKILL.md + resources
//   Level 3: TypeScript plugin with onLoad/onUnload hooks

import type { SubagentDefinition, ToolDefinition, ContextSource } from "../core-types.js";

// ---- Skill definition (superset of SubagentDefinition) ----

export interface SkillDefinition {
  /** Unique identifier — used as /command name and subagent type */
  name: string;

  /** One-line description. If empty, skill won't auto-invoke but can still be called via /name */
  description?: string;

  /** System prompt injected into the subagent (fork mode) or main agent (inline mode) */
  systemPrompt?: string;

  /** Tool allowlist. Default: ["Read", "Grep", "Glob"]. ["*"] for all tools. */
  tools?: string[];

  /** Model override. "inherit" (default) uses parent model. */
  model?: string;

  /** Invocation mode:
   *  - "inline" (default): inject systemPrompt into main agent — lightweight, shares context
   *  - "fork": spawn independent subagent — isolated context, scoped tools */
  context?: "inline" | "fork";

  /** Whether the model can auto-invoke this skill without explicit /command (default true).
   *  Set `disable-model-invocation: true` in frontmatter to hide from auto-invoke.
   *  Fork-mode skills are exposed as a callable tool; inline skills live in system prompt. */
  allowModelInvocation?: boolean;

  /** Max turns for fork-mode subagent (default 15) */
  maxTurns?: number;

  /** Tools to pre-authorize during this skill's execution (fork mode).
   *  Format: ["Bash(git add *)", "Bash(git commit *)"] or "Bash(git add *), Bash(git commit *)"
   *  Grant clears after the skill's turn completes. */
  allowedTools?: string[];

  /** File path this skill was loaded from (set by loader) */
  sourcePath?: string;

  /** Directory containing this skill's resources (set by loader for Level 2) */
  resourceDir?: string;

  // ---- Level 3 plugin extensions ----

  /** Called when the skill is loaded. Use to register custom tools/context sources. */
  onLoad?: (registry: SkillRegistry) => Promise<void>;

  /** Called when the skill is unloaded. Use to clean up custom tools/context sources. */
  onUnload?: (registry: SkillRegistry) => Promise<void>;
}

// ---- Level 3 plugin interface (for .ts skill files) ----

export interface SkillPlugin {
  name: string;
  description?: string;
  systemPrompt?: string;
  tools?: string[];
  model?: string;
  context?: "inline" | "fork";
  allowModelInvocation?: boolean;

  onLoad?: (registry: SkillRegistry) => Promise<void>;
  onUnload?: (registry: SkillRegistry) => Promise<void>;
}

// ---- Skill registry interface (passed to Level 3 plugins) ----

export interface SkillRegistry {
  /** Register a tool into the global tool registry */
  registerTool(tool: ToolDefinition): void;

  /** Remove a tool from the global tool registry */
  unregisterTool(name: string): void;

  /** Register a context source into the context chain */
  registerContext(source: ContextSource): void;

  /** Remove a context source from the context chain */
  unregisterContext(name: string): void;

  /** Register a sub-skill (skill can define nested skills) */
  registerSkill(skill: SkillDefinition): void;

  /** Remove a previously registered skill */
  unregisterSkill(name: string): void;
}

// ---- Slash command descriptor (used by CLI to auto-discover commands) ----

export interface SlashCommandDescriptor {
  /** e.g. "review" → invoked as /review */
  name: string;

  /** Brief help text for /help output */
  description: string;

  /** Handler for direct CLI invocation (return null to let fall through to model) */
  handler?: (args: string[], ctx: SlashCommandContext) => Promise<string | null>;
}

export interface SlashCommandContext {
  workingDir: string;
  config: unknown;
  planManager: unknown;
  /** Spawn a subagent for fork-mode skill invocation */
  spawnSkillAgent: (skill: SkillDefinition, task: string) => Promise<string>;
}
