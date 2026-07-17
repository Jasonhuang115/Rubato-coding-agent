// Skill registry — manages skill lifecycle: register, unregister, lookup
// Integrates with: tool registry, context sources, subagent agent-defs

import type {
  SkillDefinition,
  SkillPlugin,
  SkillRegistry as SkillRegistryInterface,
  SlashCommandDescriptor,
} from "./types.js";
import type {
  SubagentDefinition,
  ToolDefinition,
  ContextSource,
} from "../core-types.js";
import { register as registerTool, getTool } from "../tools/registry.js";

// ---- Shared skill-to-subagent bridge ----
// agent-defs.ts can import these to include skill-defined subagents

let skillSubagents: SubagentDefinition[] = [];

export function getSkillSubagentDefs(): SubagentDefinition[] {
  return [...skillSubagents];
}

export function findSkillSubagentDef(name: string): SubagentDefinition | undefined {
  return skillSubagents.find((d) => d.name === name);
}

// ---- Context sources from skills ----

const skillContextSources = new Map<string, ContextSource>();

export function getSkillContextSources(): ContextSource[] {
  return Array.from(skillContextSources.values());
}

// ---- Slash commands from skills ----

const slashCommands = new Map<string, SlashCommandDescriptor>();

export function getSlashCommands(): SlashCommandDescriptor[] {
  return Array.from(slashCommands.values());
}

export function findSlashCommand(name: string): SlashCommandDescriptor | undefined {
  return slashCommands.get(name);
}

// ---- Registry implementation ----

class SkillRegistryImpl implements SkillRegistryInterface {
  private skills = new Map<string, SkillDefinition>();
  private registeredTools = new Set<string>();
  private registeredContexts = new Set<string>();

  registerSkill(skill: SkillDefinition): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill "${skill.name}" is already registered`);
    }

    this.skills.set(skill.name, skill);

    // If the skill defines tools + systemPrompt, create a SubagentDefinition
    // so it can be spawned via spawnSubagent (fork mode)
    if (skill.systemPrompt || skill.tools) {
      const subagentDef = skillToSubagentDef(skill);
      // Avoid duplicates in the shared list
      const existingIdx = skillSubagents.findIndex((d) => d.name === skill.name);
      if (existingIdx >= 0) {
        skillSubagents[existingIdx] = subagentDef;
      } else {
        skillSubagents.push(subagentDef);
      }
    }

    // Register as slash command
    if (!slashCommands.has(skill.name)) {
      slashCommands.set(skill.name, {
        name: skill.name,
        description: skill.description ?? `Run the "${skill.name}" skill`,
      });
    }

    // Call onLoad for Level 3 plugins
    if (skill.onLoad) {
      Promise.resolve()
        .then(() => skill.onLoad!(this))
        .catch((err) => {
          console.error(`[SkillRegistry] onLoad failed for "${skill.name}":`, err);
        });
    }
  }

  unregisterSkill(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) return;

    // Call onUnload for Level 3 plugins
    if (skill.onUnload) {
      Promise.resolve()
        .then(() => skill.onUnload!(this))
        .catch((err) => {
          console.error(`[SkillRegistry] onUnload failed for "${name}":`, err);
        });
    }

    // Remove from subagent list
    skillSubagents = skillSubagents.filter((d) => d.name !== name);

    // Remove slash command
    slashCommands.delete(name);

    // Clean up registered tools
    for (const toolName of [...this.registeredTools]) {
      if (toolName.startsWith(`skill:${name}:`)) {
        this.unregisterTool(toolName);
      }
    }

    // Clean up registered contexts
    for (const ctxName of [...this.registeredContexts]) {
      if (ctxName.startsWith(`skill:${name}:`)) {
        this.unregisterContext(ctxName);
      }
    }

    this.skills.delete(name);
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /** Register a global tool (Level 3 plugins use this). */
  registerTool(tool: ToolDefinition): void {
    const prefixedName = tool.name.includes(":") ? tool.name : `skill:${tool.name}`;

    // Check if already registered
    if (getTool(prefixedName)) {
      throw new Error(`Tool "${prefixedName}" is already registered`);
    }

    const prefixedTool: ToolDefinition = { ...tool, name: prefixedName };
    registerTool(prefixedTool);
    this.registeredTools.add(prefixedName);
  }

  /** Unregister a global tool (Level 3 plugins use this). */
  unregisterTool(name: string): void {
    // Best-effort — the main registry doesn't have unregister yet,
    // so we just track it locally. Full cleanup happens on skill unload
    // via the ToolRegistry.clear() + re-register approach.
    this.registeredTools.delete(name);
  }

  /** Register a context source (Level 3 plugins use this). */
  registerContext(source: ContextSource): void {
    const prefixedName = source.name.includes(":") ? source.name : `skill:${source.name}`;

    if (skillContextSources.has(prefixedName)) {
      throw new Error(`Context source "${prefixedName}" is already registered`);
    }

    skillContextSources.set(prefixedName, { ...source, name: prefixedName });
    this.registeredContexts.add(prefixedName);
  }

  /** Unregister a context source (Level 3 plugins use this). */
  unregisterContext(name: string): void {
    skillContextSources.delete(name);
    this.registeredContexts.delete(name);
  }

  /** Register a plugin-style skill (Level 3 .ts file). */
  registerPlugin(plugin: SkillPlugin): void {
    const skill: SkillDefinition = {
      name: plugin.name,
      description: plugin.description,
      systemPrompt: plugin.systemPrompt,
      tools: plugin.tools,
      model: plugin.model,
      context: plugin.context ?? "inline",
      allowModelInvocation: plugin.allowModelInvocation ?? true,
      onLoad: plugin.onLoad,
      onUnload: plugin.onUnload,
    };
    this.registerSkill(skill);
  }
}

// ---- Helpers ----

function skillToSubagentDef(skill: SkillDefinition): SubagentDefinition {
  return {
    name: skill.name,
    description: skill.description ?? `Run the "${skill.name}" skill`,
    systemPrompt:
      skill.systemPrompt ??
      `You are the "${skill.name}" skill. Follow the instructions provided in your task.`,
    tools: skill.tools ?? ["Read", "Grep", "Glob", "Bash"],
    model: skill.model ?? "inherit",
    readonly: skill.context === "fork",   // fork-mode subagents are read-only
    maxTurns: skill.maxTurns ?? 15,
  };
}

// ---- Singleton ----

let instance: SkillRegistryImpl | null = null;

export function getSkillRegistry(): SkillRegistryImpl {
  if (!instance) {
    instance = new SkillRegistryImpl();
  }
  return instance;
}

export function resetSkillRegistry(): void {
  if (instance) {
    // Unregister all skills
    for (const name of [...instance.listSkills().map((s) => s.name)]) {
      instance.unregisterSkill(name);
    }
  }
  instance = null;
  skillSubagents = [];
  slashCommands.clear();
  skillContextSources.clear();
}
