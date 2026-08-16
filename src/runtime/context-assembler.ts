// ContextAssembler — builds the full system prompt from context sources
// Extracted from loop.ts. Handles:
//   - ContextChain setup (Soul, ClaudeMd, project/user Memory, GitStatus)
//   - Git health / conflict checks
//   - System prompt assembly (PromptAssembler + verified file memory + git)
//   - Resume summary injection

import type { AgentContext, ToolDefinition } from "../shared/core-types.js";
import { ContextChain } from "../context/sources.js";
import { ClaudeMdSource } from "../context/claude-md.js";
import { GitStatusSource } from "../context/git-status.js";
import { SoulSource } from "../context/soul.js";
import {
  ProjectMemorySource,
  UserMemorySource,
} from "../context/agent-memory.js";
import { sessionStartHook, conflictCheckHook } from "../tools/git/hooks.js";
import { getPromptAssembler } from "../prompt/assembler.js";
import { buildSubagentStaticPrompt } from "../prompt/static.js";
import { buildCapabilityPrompt } from "../prompt/capability.js";
import { roughTokenEstimate } from "../shared/tokens.js";

export interface AssembledContext {
  systemPrompt: string;
  systemTokens: number;
}

export interface ContextAssemblerOptions {
  workingDir: string;
  prompt: string;
  ctx: AgentContext;
  tools: ToolDefinition[];
  resumeSummary?: string;
  roleSystemPrompt?: string;
  contextProfile?: "root" | "subagent" | "compact";
}

/**
 * Build the complete system prompt for a session.
 * Chains: Static + Capability prompts (via PromptAssembler)
 *        + Context sources (CLAUDE.md, memory, git, etc.)
 *        + bounded project and user memory indexes
 *        + Git health
 *        + Previous session resume
 */
export async function assembleContext(
  options: ContextAssemblerOptions,
): Promise<AssembledContext> {
  const {
    workingDir,
    prompt,
    ctx,
    tools,
    resumeSummary,
    roleSystemPrompt,
    contextProfile = "root",
  } = options;

  if (contextProfile === "compact") {
    const systemPrompt = roleSystemPrompt?.trim() || "You are a concise text summarizer.";
    return { systemPrompt, systemTokens: roughTokenEstimate(systemPrompt) };
  }

  // 1. Build prompt layers via PromptAssembler
  const layeredSystem = contextProfile === "subagent"
    ? [
        buildSubagentStaticPrompt(
          roleSystemPrompt || "You are a read-only analysis subagent.",
          tools.some((tool) => tool.type === "write"),
        ),
        buildCapabilityPrompt(tools),
      ].join("\n\n")
    : getPromptAssembler().assembleFlat(ctx, tools);

  // 2. Build context chain
  const contextChain = new ContextChain();
  if (contextProfile === "subagent") {
    // Project rules are useful; parent history, memory, identity and Git session
    // state are intentionally excluded from the fresh subagent context.
    contextChain.register(new ClaudeMdSource());
  } else {
    contextChain.register(new SoulSource());
    contextChain.register(new ClaudeMdSource());
    contextChain.register(new UserMemorySource());
    contextChain.register(new ProjectMemorySource());
    contextChain.register(new GitStatusSource());
  }

  const contextBlocks = await contextChain.fetchAll(prompt, ctx);
  const contextText = contextBlocks.map((b) => b.content).join("\n\n");

  // 3. Git health
  const gitHealth = contextProfile === "root"
    ? await sessionStartHook(workingDir).catch(() => null)
    : null;

  // 4. Conflict check
  const conflictWarning = contextProfile === "root"
    ? await conflictCheckHook(workingDir).catch(() => null)
    : null;

  // 5. Assemble final system prompt
  let systemPrompt = layeredSystem +
    (contextText ? `\n\n## Project Context\n${contextText}` : "") +
    (gitHealth ? `\n\n${gitHealth}` : "") +
    (conflictWarning ? `\n\n${conflictWarning}` : "");

  // 6. Resume summary (from previous session)
  if (resumeSummary && contextProfile === "root") {
    systemPrompt += `\n\n## Previous Session Context\nThe following is a summary of a previous session in this project. Use this context to understand what was previously discussed:\n\n${resumeSummary}`;
  }

  // 7. Estimate tokens
  const systemTokens = roughTokenEstimate(systemPrompt);

  return { systemPrompt, systemTokens };
}
