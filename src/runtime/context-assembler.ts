// ContextAssembler — builds the full system prompt from context sources
// Extracted from loop.ts. Handles:
//   - ContextChain setup (Soul, ClaudeMd, MemoryMd, Mnemosyne, GitStatus)
//   - Journal recall
//   - Git health / conflict checks
//   - System prompt assembly (PromptAssembler + context text + journal + git)
//   - Resume summary injection

import type { AgentContext, ToolDefinition } from "../shared/core-types.js";
import { ContextChain } from "../context/sources.js";
import { ClaudeMdSource } from "../context/claude-md.js";
import { MemoryMdSource } from "../context/memory-md.js";
import { GitStatusSource } from "../context/git-status.js";
import { SoulSource } from "../context/soul.js";
import { MnemosyneSource } from "../context/mnemosyne-source.js";
import { sessionStartRecall } from "../memory/journal/recall.js";
import { sessionStartHook, conflictCheckHook } from "../tools/git/hooks.js";
import { getPromptAssembler } from "../prompt/assembler.js";

export interface AssembledContext {
  systemPrompt: string;
  systemTokens: number;
}

export interface ContextAssemblerOptions {
  workingDir: string;
  prompt: string;
  ctx: AgentContext;
  tools: ToolDefinition[];
  providerName?: string;
  resumeSummary?: string;
}

/**
 * Build the complete system prompt for a session.
 * Chains: Static + Capability prompts (via PromptAssembler)
 *        + Context sources (CLAUDE.md, memory, git, etc.)
 *        + Journal recall
 *        + Git health
 *        + Previous session resume
 */
export async function assembleContext(
  options: ContextAssemblerOptions,
): Promise<AssembledContext> {
  const { workingDir, prompt, ctx, tools, providerName, resumeSummary } = options;

  // 1. Build prompt layers via PromptAssembler
  const assembler = getPromptAssembler(providerName);
  const layeredSystem = assembler.assembleFlat(ctx, tools);

  // 2. Build context chain
  const contextChain = new ContextChain();
  contextChain.register(new SoulSource());
  contextChain.register(new ClaudeMdSource());
  contextChain.register(new MemoryMdSource());
  contextChain.register(new MnemosyneSource());
  contextChain.register(new GitStatusSource());

  const contextBlocks = await contextChain.fetchAll(prompt, ctx);
  const contextText = contextBlocks.map((b) => b.content).join("\n\n");

  // 3. Journal recall
  const journalRecall = sessionStartRecall(workingDir);

  // 4. Git health
  const gitHealth = await sessionStartHook(workingDir).catch(() => null);

  // 5. Conflict check
  const conflictWarning = await conflictCheckHook(workingDir).catch(() => null);

  // 6. Assemble final system prompt
  let systemPrompt = layeredSystem +
    (contextText ? `\n\n## Project Context\n${contextText}` : "") +
    (journalRecall ? `\n\n${journalRecall}` : "") +
    (gitHealth ? `\n\n${gitHealth}` : "") +
    (conflictWarning ? `\n\n${conflictWarning}` : "");

  // 7. Resume summary (from previous session)
  if (resumeSummary) {
    systemPrompt += `\n\n## Previous Session Context\nThe following is a summary of a previous session in this project. Use this context to understand what was previously discussed:\n\n${resumeSummary}`;
  }

  // 8. Estimate tokens
  const systemTokens = roughTokenEstimate(systemPrompt);

  return { systemPrompt, systemTokens };
}

// ---- Token estimation (inline to avoid circular deps) ----

function roughTokenEstimate(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      tokens += 1.5;
    } else {
      tokens += 0.25;
    }
  }
  return tokens;
}
