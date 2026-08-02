// Dynamic Prompt Layer — workspace, git, memory, skills
// Session-scoped. Changes with workspace context. Approx ~600 tokens.

import type { AgentContext } from "../shared/core-types.js";
import { getSkillRegistry } from "../skills/registry.js";

export function buildDynamicPrompt(ctx: AgentContext): string {
  return [
    gitPolicy(),
    environment(ctx),
    skillCatalog(),
  ].filter(Boolean).join("\n\n");
}

function gitPolicy(): string {
  return `## Git Policy

- NEVER commit, push, or create a PR unless the user explicitly asks you to.
- You MAY run read-only git commands (status, diff, log, branch) freely to understand repository state.
- You MAY run git add as part of preparing a commit, but only after the user has asked you to commit.
- When committing: use conventional commit messages.
- If you're on the default branch (main/master), create a new branch before committing — ask the user for the branch name.
- Do NOT force-push or run destructive git commands (reset --hard, clean -fd) without explicit user confirmation.`;
}

function environment(ctx: AgentContext): string {
  return `## Environment
- Working directory: ${ctx.workingDir}
- Platform: ${process.platform}
- Shell: ${process.env.SHELL ?? "unknown"}
- OS: ${process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "Linux" : process.platform}
- LLM Provider: ${ctx.config.model.provider} / ${ctx.config.model.model}`;
}

function skillCatalog(): string {
  try {
    const registry = getSkillRegistry();
    const skills = registry.listSkills();
    if (skills.length === 0) return "";

    const lines: string[] = [];
    lines.push("## Available Skills");
    lines.push("Skills are invoked by typing \`/skill-name\` in the REPL (fork mode spawns a subagent, inline mode injects instructions).");
    lines.push("");
    lines.push("| Command | Description | Mode |");
    lines.push("|---------|-------------|------|");
    for (const s of skills) {
      const desc = (s.description ?? "(no description)").slice(0, 60);
      const mode = s.context === "inline" ? "inline" : "fork";
      lines.push(`| \`/${s.name}\` | ${desc} | ${mode} |`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}
