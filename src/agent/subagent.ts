// Subagent system — recursive agentLoop() with scoped tools
// Built-in types: Explore, General, Verify
// Phase 2: transcript recording, worktree isolation, background execution

import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import type {
  SubagentDefinition,
  SubagentResult,
  AgentContext,
  AgentConfig,
  ToolDefinition,
} from "../shared/core-types.js";
import { getTool, getAllTools } from "../tools/registry.js";
import { agentLoop } from "./loop.js";
import { SessionStore } from "../runtime/session/storage.js";

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
    "- Do NOT edit or write files. You are read-only.",
    "- When done, output a structured summary that the parent agent can merge:",
    "  * Key files found (with paths)",
    "  * Relevant patterns or code snippets",
    "  * Any risks or issues identified",
    "- Be thorough but concise. Take as many steps as you need to be comprehensive.",
  ].join("\n"),
  tools: EXPLORE_TOOLS,
  readonly: true,
  // No maxTurns — subagents run until completion
};

export const GENERAL_DEF: SubagentDefinition = {
  name: "general",
  description:
    "General-purpose subagent for researching complex questions, searching for code, " +
    "and executing multi-step tasks. Can spawn further subagents for deeply nested tasks.",
  systemPrompt: [
    "You are a general-purpose coding subagent. You have access to Read, Write, Edit, Grep, Glob, Bash, and Web tools.",
    "",
    "## Rules",
    "- Complete the assigned task thoroughly and report results concisely.",
    "- Use the Agent tool to spawn subagents for independent subtasks. Max depth: 3 levels (root→child→grandchild).",
    "- Take as many steps as needed — there is no step limit.",
    "- You share the parent agent's working directory. Be careful with writes.",
    "- When done, summarize what you did and what you found.",
  ].join("\n"),
  tools: ["*"],
  readonly: false,
  canSpawn: true,
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

function resolveTools(
  allowlist: string[],
  opts?: { canSpawn?: boolean; depth?: number; hardDepth?: number }
): ToolDefinition[] {
  const hardDepth = opts?.hardDepth ?? 8;
  // Remove AgentTool if: not allowed to spawn OR depth limit reached
  const shouldRemoveAgent = !opts?.canSpawn || (opts?.depth ?? 0) >= hardDepth;

  if (allowlist.includes("*")) {
    let tools = getAllTools();
    if (shouldRemoveAgent) {
      tools = tools.filter((t) => t.name !== "Agent" && t.name !== "Skill");
    }
    return tools;
  }
  let tools = allowlist
    .map((name) => getTool(name))
    .filter((t): t is ToolDefinition => t !== undefined);
  if (shouldRemoveAgent) {
    tools = tools.filter((t) => t.name !== "Agent" && t.name !== "Skill");
  }
  return tools;
}

// ---- Spawn primitive ----

interface TranscriptTurn {
  turn: number; text: string;
  toolCalls: Array<{ name: string; result: string; isError: boolean }>;
  timestamp: number;
}

interface SpawnSubagentOptions {
  agentId?: string;
}

export function getSubagentResultPath(agentId: string): string {
  return `/tmp/rubato-subagent-${agentId}.md`;
}

export function getSubagentTranscriptPath(agentId: string): string {
  return `/tmp/rubato-subagent-${agentId}.transcript.md`;
}

function formatResultArtifact(
  definition: SubagentDefinition,
  task: string,
  result: SubagentResult,
): string {
  return [
    `# Subagent Result: ${definition.name}`,
    `**Agent ID:** ${result.agentId}`,
    `**Status:** ${result.status}`,
    `**Tokens:** ${result.usage.inputTokens} in / ${result.usage.outputTokens} out | **Tool calls:** ${result.usage.toolCalls}`,
    `**Transcript:** ${result.transcriptPath}`,
    "",
    "## Task",
    "",
    task,
    "",
    "## Final Report",
    "",
    result.output || "(no final report)",
    "",
  ].join("\n");
}

function formatTranscriptArtifact(
  definition: SubagentDefinition,
  task: string,
  agentId: string,
  turns: TranscriptTurn[],
): string {
  const sections = turns.map((turn) => {
    const toolCalls = turn.toolCalls.length === 0
      ? "(none)"
      : turn.toolCalls.map((call) => [
          `### ${call.name}${call.isError ? " (error)" : ""}`,
          "",
          "```text",
          call.result,
          "```",
        ].join("\n")).join("\n\n");

    return [
      `## Turn ${turn.turn}`,
      "",
      "### Assistant Text",
      "",
      turn.text || "(none)",
      "",
      "### Tool Results",
      "",
      toolCalls,
    ].join("\n");
  });

  return [
    `# Subagent Transcript: ${definition.name}`,
    `**Agent ID:** ${agentId}`,
    "",
    "## Task",
    "",
    task,
    "",
    ...sections,
    "",
  ].join("\n");
}

function persistSubagentArtifacts(
  definition: SubagentDefinition,
  task: string,
  result: SubagentResult,
  turns: TranscriptTurn[],
): SubagentResult {
  const resultPath = getSubagentResultPath(result.agentId);
  const transcriptPath = getSubagentTranscriptPath(result.agentId);
  const resultWithPaths = { ...result, resultPath, transcriptPath };

  try {
    fs.writeFileSync(transcriptPath, formatTranscriptArtifact(definition, task, result.agentId, turns), "utf-8");
    fs.writeFileSync(resultPath, formatResultArtifact(definition, task, resultWithPaths), "utf-8");
  } catch {
    // Artifact persistence is best-effort; the in-memory result remains usable.
  }

  return resultWithPaths;
}

export async function spawnSubagent(
  definition: SubagentDefinition,
  task: string,
  parentCtx: AgentContext,
  parentConfig: AgentConfig,
  options: SpawnSubagentOptions = {},
): Promise<SubagentResult> {
  const agentId = options.agentId ?? `${parentCtx.sessionId}-sub-${randomUUID().slice(0, 8)}`;
  const depth = (parentCtx.depth ?? 0) + 1;

  // 1. Budget check (deterministic counters only)
  const budgetManager = parentCtx.budgetManager;
  if (budgetManager) {
    const allocation = budgetManager.tryAllocate(depth);
    if (!allocation.allowed) {
      return persistSubagentArtifacts(definition, task, {
        status: "failed",
        agentId,
        output: `Spawn denied: ${allocation.reason}`,
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      }, []);
    }
  }

  // 2. Tool set: conditional AgentTool based on canSpawn + depth
  // hardDepth=3: only root → child → grandchild can spawn; great-grandchild stops
  const tools = resolveTools(definition.tools, {
    canSpawn: definition.canSpawn,
    depth,
    hardDepth: 3,
  });

  const modelConfig = { ...parentConfig.model };
  if (definition.model && definition.model !== "inherit") {
    modelConfig.model = definition.model;
  }

  const subConfig: AgentConfig = { ...parentConfig, model: modelConfig };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;
  let finalStatus: SubagentResult["status"] = "completed";

  // Transcript tracking
  const turns: TranscriptTurn[] = [];
  let currentTurnNum = 0;
  let currentText = "";
  let currentToolCalls: TranscriptTurn["toolCalls"] = [];
  const startedAt = Date.now();

  try {
    for await (const event of agentLoop({
      config: subConfig,
      workingDir: parentCtx.workingDir,
      prompt: `[Subagent: ${definition.name}]\n\n${task}`,
      renderer: new NoopRenderer(),
      sessionId: agentId,
      tools,
      depth,
      budgetManager,
      maxTurns: definition.maxTurns ?? Number.POSITIVE_INFINITY,
    })) {
      switch (event.type) {
        case "turn_start":
          if (currentTurnNum > 0) {
            turns.push({ turn: currentTurnNum, text: currentText, toolCalls: currentToolCalls, timestamp: Date.now() });
          }
          currentTurnNum = event.turn;
          currentText = "";
          currentToolCalls = [];
          break;
        case "text":
          currentText += event.text;
          break;
        case "tool_result":
          toolCallCount++;
          currentToolCalls.push({ name: event.name, result: event.result.slice(0, 200), isError: event.isError });
          break;
        case "turn_end":
          if (event.usage) {
            totalInputTokens += event.usage.input;
            totalOutputTokens += event.usage.output;
          }
          break;
        case "error":
          currentText += `\n[Error] ${event.message}`;
          break;
        case "done":
          if (event.reason !== "end_turn") {
            finalStatus = event.reason === "max_turns" ? "timeout" : "failed";
          }
          break;
      }
    }

    if (currentTurnNum > 0) {
      turns.push({ turn: currentTurnNum, text: currentText, toolCalls: currentToolCalls, timestamp: Date.now() });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    currentText += `${currentText ? "\n" : ""}[Fatal] ${message}`;
    finalStatus = "failed";
  } finally {
    // Always release the parallel slot
    budgetManager?.releaseAgent();
  }

  const endedAt = Date.now();
  const usage = { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, toolCalls: toolCallCount };

  // Persist transcript
  try {
    const sessionStore = new SessionStore(agentId);
    sessionStore.init();
    sessionStore.append({
      type: "session_meta",
      timestamp: startedAt,
      data: { type: "subagent_transcript", agentId, definitionName: definition.name, task, status: finalStatus, turns: turns.map((t) => ({ ...t, text: t.text.slice(0, 500) })), usage, startedAt, endedAt, parentSessionId: parentCtx.sessionId, duration: endedAt - startedAt },
    });
    sessionStore.close();
  } catch { /* best-effort */ }

  // Record memory feedback
  try {
    const { getMnemosyneStore } = await import("../memory/store.js");
    const store = getMnemosyneStore();
    const recentMemories = store.searchWithRelevance(task, 3);

    for (const turn of turns) {
      const successes = turn.toolCalls.filter((tc) => !tc.isError).length;
      const failures = turn.toolCalls.filter((tc) => tc.isError).length;

      for (const { entity } of recentMemories) {
        if (successes > 0) store.recordFeedback(entity.id, parentCtx.sessionId, "tool_success", 0.05, { subagentId: agentId, subagentType: definition.name });
        if (failures > 0) store.recordFeedback(entity.id, parentCtx.sessionId, "tool_failed", -0.03, { subagentId: agentId, subagentType: definition.name });
      }
    }
  } catch { /* best-effort */ }

  const finalTurn = [...turns].reverse().find((turn) => turn.text.trim().length > 0);
  const output = finalTurn?.text.trim() ?? currentText.trim();
  return persistSubagentArtifacts(
    definition,
    task,
    { status: finalStatus, agentId, output, summary: output, usage },
    turns,
  );
}

// ---- Worktree isolation ----

async function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.on("close", (code) => { if (code === 0) resolve(stdout.trim()); else reject(new Error(`git ${args[0]} exited ${code}`)); });
    child.on("error", reject);
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try { await execGit(["rev-parse", "--git-dir"], cwd); return true; } catch { return false; }
}

export async function spawnSubagentInWorktree(
  definition: SubagentDefinition, task: string,
  parentCtx: AgentContext, parentConfig: AgentConfig
): Promise<SubagentResult> {
  const agentId = `${parentCtx.sessionId}-sub-${randomUUID().slice(0, 8)}`;
  let worktreePath: string;
  let branchName: string;

  try {
    if (!(await isGitRepo(parentCtx.workingDir))) return spawnSubagent(definition, task, parentCtx, parentConfig);

    const worktreesDir = path.join(parentCtx.workingDir, ".claude", "worktrees");
    fs.mkdirSync(worktreesDir, { recursive: true });
    branchName = `subagent-${agentId.slice(0, 8)}`;
    worktreePath = path.join(worktreesDir, branchName);

    try {
      await execGit(["checkout", "-b", branchName], parentCtx.workingDir);
      await execGit(["worktree", "add", worktreePath, branchName], parentCtx.workingDir);
    } catch {
      try { await execGit(["worktree", "add", "--detach", worktreePath, "HEAD"], parentCtx.workingDir); branchName = "detached"; }
      catch (err) { return spawnSubagent(definition, task, parentCtx, parentConfig); }
    }
  } catch {
    return spawnSubagent(definition, task, parentCtx, parentConfig);
  }

  const isolatedCtx: AgentContext = { ...parentCtx, workingDir: worktreePath };

  try {
    const result = await spawnSubagent(definition, `${task}\n\n[Isolated worktree: ${worktreePath}]`, isolatedCtx, parentConfig);
    try { await execGit(["worktree", "remove", worktreePath, "--force"], parentCtx.workingDir); if (branchName !== "detached") await execGit(["branch", "-D", branchName], parentCtx.workingDir).catch(() => {}); } catch { try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ } }
    return result;
  } catch (err) {
    try { await execGit(["worktree", "remove", worktreePath, "--force"], parentCtx.workingDir); } catch { /* best-effort */ }
    throw err;
  }
}

// ---- Background subagent ----

export interface BackgroundSubagentHandle {
  agentId: string; status: "running" | "completed" | "failed";
  wait: () => Promise<SubagentResult>;
  cancel: () => void;
}

export function spawnSubagentInBackground(
  definition: SubagentDefinition, task: string,
  parentCtx: AgentContext, parentConfig: AgentConfig
): BackgroundSubagentHandle {
  const agentId = `${parentCtx.sessionId}-sub-${randomUUID().slice(0, 8)}`;
  let status: BackgroundSubagentHandle["status"] = "running";
  let cancelled = false;

  const resultPromise = (async (): Promise<SubagentResult> => {
    try {
      const result = await spawnSubagent(definition, task, parentCtx, parentConfig, { agentId });
      if (cancelled) {
        return persistSubagentArtifacts(definition, task, {
          status: "failed",
          agentId,
          output: "Cancelled",
          usage: result.usage,
        }, []);
      }
      status = result.status === "completed" ? "completed" : "failed";
      return result;
    } catch (err) {
      status = "failed";
      return persistSubagentArtifacts(definition, task, {
        status: "failed",
        agentId,
        output: err instanceof Error ? err.message : String(err),
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      }, []);
    }
  })();

  return {
    agentId,
    get status() { return status; },
    wait: () => resultPromise,
    cancel: () => { cancelled = true; },
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
