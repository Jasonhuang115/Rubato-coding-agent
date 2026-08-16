#!/usr/bin/env node
// CLI entry point — parses arguments, loads config, runs the agent

import { randomUUID } from "crypto";
import * as readline from "readline";
import type { ConfirmDecision } from "../shared/core-types.js";
import { loadConfig, loadEnvFiles } from "./config-loader.js";
import { parseArgs, loadMcpConfigs } from "./options.js";
import {
  handleGitCommand,
  handleJournalCommand,
  handleModelCommand,
  handleSessionsCommand,
  handleSkillCommand,
  handleTasksCommand,
  handleTraceCommand,
  handleScrubCommand,
} from "./command-handlers.js";
import {
  handleFileMemoryCommand,
  handleProfileCommand,
} from "./file-memory-commands.js";
import { AnsiStreamRenderer } from "./stream-renderer.js";
import { agentLoop, abortCurrentRequest } from "../agent/loop.js";
import {
  register,
  unregister,
  getAllTools,
} from "../tools/registry.js";
import { bashTool } from "../tools/bash.js";
import { readTool } from "../tools/read.js";
import { writeTool } from "../tools/write.js";
import { editTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { webFetchTool, webSearchTool } from "../tools/web.js";
import { todoWriteTool } from "../tools/todo.js";
import { submitPlanTool } from "../tools/submit-plan.js";
import { subagentTool } from "../tools/subagent.js";
import { skillTool } from "../tools/skill.js";
import { taskTool } from "../tools/task.js";
import { memoryFeedbackTool } from "../tools/memory-feedback.js";
import { memoryProposeTool } from "../tools/memory-propose.js";
import { AgentModeController } from "../agent/mode.js";
import { handlePlanModeCommand } from "./plan-mode-command.js";
import { initCustomDefinitions } from "../agent/agent-defs.js";
import { McpClient } from "../tools/mcp/client.js";
import { readMultiLineInput } from "./multiline-input.js";
import { readClipboardPrompt } from "./clipboard-input.js";
import { connectMcpServer, disconnectMcpServer } from "../tools/mcp/adapter.js";
import { loadAllSkills } from "../skills/loader.js";
import { getSkillRegistry } from "../skills/registry.js";
import type { AgentConfig } from "../shared/core-types.js";
import { warnRecoverable } from "../shared/diagnostics.js";
import { SessionManager } from "../runtime/session/manager.js";
import { processSubagentRegistry } from "../agent/subagents/registry.js";
import { startMemoryMaintenance } from "./memory-maintenance.js";

// Register all tools
register(readTool);
register(writeTool);
register(editTool);
register(bashTool);
register(grepTool);
register(globTool);
register(webFetchTool);
register(webSearchTool);
register(todoWriteTool);
register(submitPlanTool);
register(subagentTool);
register(taskTool);
register(skillTool);
register(memoryFeedbackTool);
register(memoryProposeTool);

// ---- Tab completion & / menu ----

function getSlashCompletions(): string[] {
  const builtin = [
    "/exit", "/quit", "/compact", "/clear", "/help", "/paste",
    "/plan", "/plan on", "/plan off", "/plan status",
    "/git", "/git health",
    "/journal", "/journal recent", "/journal search", "/journal stats",
    "/remember",
    "/memory", "/memory stats", "/memory search", "/memory list", "/memory dream",
    "/profile", "/profile show", "/profile why", "/profile export",
    "/profile pause-learning", "/profile resume-learning",
    "/model",
    "/sessions", "/sessions list", "/sessions resume",
    "/tasks", "/tasks cancel", "/tasks cleanup",
    "/tasks pin", "/tasks unpin", "/tasks stats", "/tasks prune", "/trace",
    "/scrub", "/scrub --dry-run",
  ];

  // Add skill commands
  const skillCmds = getSkillRegistry()
    .listSkills()
    .map((s) => `/${s.name}`);

  return [...builtin, ...skillCmds];
}

function createSlashCompleter(): readline.Completer {
  const commands = getSlashCompletions();
  return (line: string) => {
    if (!line.startsWith("/")) {
      return [[], line];
    }

    const hits = commands.filter((cmd) => cmd.startsWith(line));
    // If only one hit, complete it with trailing space
    if (hits.length === 1 && hits[0] === line) {
      return [[], line];
    }
    return [hits.length > 0 ? hits : [], line];
  };
}

function showSlashMenu(): void {
  const skills = getSkillRegistry().listSkills();

  console.log("\n  ── Commands ──");
  console.log("  /exit, /quit       Exit");
  console.log("  /paste             Send the full text currently in the clipboard");
  console.log("  /clear              Start a fresh session");
  console.log("  /compact            Compact context");
  console.log("  /plan               Show Plan mode status | /plan on | /plan off");
  console.log("  /git                Git status | /git health");
  console.log("  /journal            Legacy alias for file-memory list/search");
  console.log("  /remember <text>    Send a traceable explicit memory statement");
  console.log("  /memory             File-memory stats/search/list/dream");
  console.log("  /profile            Show/why/export/pause/resume user profile");
  console.log("  /model              Switch model | /model <name>");
  console.log("  /sessions           List sessions | /sessions resume <#>");
  console.log("  /tasks              List/inspect/wait/cancel/cleanup subagent tasks");
  console.log("  /trace [task-id]    Show root trace or task transcript path");
  console.log("  /scrub [path]       Redact secrets in persisted traces/sessions/artifacts");
  console.log("  /help               Full help");

  if (skills.length > 0) {
    console.log("\n  ── Skills ──");
    for (const s of skills) {
      const mode = s.context === "fork" ? "⚡fork" : "📋inline";
      console.log(`  /${s.name.padEnd(18)} ${mode}  ${s.description ?? ""}`);
    }
  }

  console.log(`\n  Tab → autocomplete. Type /name for details.`);
}

// ---- Loop state (for session restart signaling) ----

interface LoopState {
  shouldRestart: boolean;
  newSessionId?: string;
  resumeSummary?: string;
}

// ---- First message handler (with slash command support) ----

async function getFirstMessage(
  rl: readline.Interface,
  modeController: AgentModeController,
  workdir: string,
  config: AgentConfig,
): Promise<string> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const trimmed = await readMultiLineInput(rl, modeController.mode === "plan" ? "\n▸ Plan: " : "\n▸ You: ");
    if (!trimmed) return "/exit";

    // Handle slash commands locally, loop back for real message
    if (trimmed === "/exit" || trimmed === "/quit") return "/exit";
    if (trimmed === "/paste") {
      try {
        const pasted = readClipboardPrompt();
        console.log(`  ✓ Clipboard prompt loaded (${pasted.length} chars, ${pasted.split("\n").length} lines)`);
        return pasted;
      } catch (error) {
        console.log(`  ✖ Unable to read clipboard: ${error instanceof Error ? error.message : error}`);
        continue;
      }
    }
    if (trimmed === "/help") { showHelp(); continue; }
    if (trimmed.startsWith("/plan")) { handlePlanModeCommand(trimmed, modeController); continue; }
    if (trimmed.startsWith("/git")) { handleGitCommand(trimmed, workdir); continue; }
    if (trimmed.startsWith("/remember")) {
      const remembered = rememberCommandAsMessage(trimmed);
      if (remembered) return remembered;
      continue;
    }
    if (trimmed.startsWith("/journal")) { await handleJournalCommand(trimmed, workdir, config); continue; }
    if (trimmed.startsWith("/memory")) { await handleFileMemoryCommand(trimmed, workdir, config); continue; }
    if (trimmed.startsWith("/profile")) { await handleProfileCommand(trimmed, workdir, config); continue; }
    if (trimmed.startsWith("/model")) { handleModelCommand(trimmed, config); continue; }

    // Not a slash command — send to agent
    return trimmed;
  }
}

function showHelp(): void {
  console.log("\n  REPL Commands:");
  console.log("  /plan on|off|status Switch or inspect Plan mode");
  console.log("  /git                Show current git status");
  console.log("  /git health         Show branch health summary");
  console.log("  /journal search <q> Legacy alias for file-memory search");
  console.log("  /remember <text>    Record an explicit, traceable user memory");
  console.log("  /memory             File-memory stats/search/list/dream");
  console.log("  /profile            Show/why/export/pause/resume profile");
  console.log("  /model              List / switch models");
  console.log("  /help               Show this help");
  console.log("  /paste              Send the full clipboard as one prompt");
  console.log("  /exit, /quit        Exit");
  console.log("  Ctrl+C              Exit");
}

function rememberCommandAsMessage(input: string): string | null {
  const content = input.replace(/^\/remember\b/u, "").trim();
  if (!content) {
    console.log("\n  Usage: /remember <what you want the agent to remember>");
    return null;
  }
  return `请记住：${content}`;
}

// ---- Main ----

function createRepl(
  rl: readline.Interface,
  modeController: AgentModeController,
  workdir: string,
  config: AgentConfig,
  loopOptions: { forceCompaction?: boolean },
  sessionManager: SessionManager,
  loopState: LoopState,
  currentSessionId: () => string,
  onSessionFinalize: () => void,
): (signal?: AbortSignal) => Promise<string | null> {
  return async (signal?: AbortSignal) => {
    const promptAgain = () => createRepl(
      rl,
      modeController,
      workdir,
      config,
      loopOptions,
      sessionManager,
      loopState,
      currentSessionId,
      onSessionFinalize,
    )(signal);
    const prompt = modeController.mode === "plan" ? "\n▸ Plan: " : "\n▸ You: ";
    const trimmed = await readMultiLineInput(rl, prompt, signal);
    if (trimmed === null) return null;
    if (trimmed === "/") {
      showSlashMenu();
      return promptAgain();
    } else if (trimmed === "/exit" || trimmed === "/quit") {
          onSessionFinalize();
          return null;
        } else if (trimmed === "/paste") {
          try {
            const pasted = readClipboardPrompt();
            console.log(`  ✓ Clipboard prompt loaded (${pasted.length} chars, ${pasted.split("\n").length} lines)`);
            return pasted;
          } catch (error) {
            console.log(`  ✖ Unable to read clipboard: ${error instanceof Error ? error.message : error}`);
            return promptAgain();
          }
        } else if (trimmed === "/clear") {
          // Finalize current session and restart
          onSessionFinalize();
          loopState.shouldRestart = true;
          loopState.newSessionId = randomUUID();
          modeController.clearPending();
          console.log("\n  ✨ Session saved. Starting fresh...");
          return null;
        } else if (trimmed === "/compact") {
          if (loopOptions) { loopOptions.forceCompaction = true; }
          console.log("\n  Compacting on next turn...");
          return promptAgain();
        } else if (trimmed.startsWith("/sessions")) {
          const result = handleSessionsCommand(trimmed, sessionManager);
          if (result.restartLoop && result.resumeId) {
            onSessionFinalize();
            try {
              const { summary } = sessionManager.resumeSession(result.resumeId);
              loopState.shouldRestart = true;
              loopState.newSessionId = randomUUID();
              loopState.resumeSummary = summary;
              console.log(`\n  📋 Resuming session ${result.resumeId.slice(0, 8)}...`);
            } catch (err) {
              console.log(`\n  ✖ Failed to resume: ${err instanceof Error ? err.message : err}`);
              loopState.shouldRestart = false;
            }
            return null;
          } else {
            return promptAgain();
          }
        } else if (trimmed === "/help") {
          console.log("\n  REPL Commands:");
          console.log("  /exit, /quit      — Exit the chat");
          console.log("  /paste            — Send the full clipboard as one prompt");
          console.log("  /clear             — Start a fresh session (saves current)");
          console.log("  /compact           — Summarize earlier context to free space");
          console.log("  /plan on          — Enter read-only Plan mode");
          console.log("  /plan off         — Exit Plan mode without executing a plan");
          console.log("  /plan status      — Show mode, phase, and latest plan path");
          console.log("  /git              — Show current git status");
          console.log("  /git health       — Show branch health summary");
          console.log("  /journal search <q> — Legacy file-memory search alias");
          console.log("  /remember <text>  — Record an explicit user memory");
          console.log("  /memory stats     — Show file-memory status (no RAG)");
          console.log("  /profile show     — Show verified user profile");
          console.log("  /model            — List / switch models");
          console.log("  /sessions         — List project sessions | /sessions resume <#>");
          console.log("  /tasks            — Inspect background Subagent state and report paths");
          console.log("  /scrub --dry-run [path] — Audit persisted data without changing files");
          console.log("  /scrub [path]     — Redact persisted trace/session/artifact files in place");
          console.log("  /help             — Show this help");
          console.log("  Ctrl+C            — Interrupt / Exit when idle");
          // List loaded skills
          const skills = getSkillRegistry().listSkills();
          if (skills.length > 0) {
            console.log("\n  Skills (/<name>):");
            for (const s of skills) {
              const mode = s.context === "inline" ? "inline" : "fork";
              console.log(`  /${s.name.padEnd(18)} — ${s.description ?? "(no description)"} [${mode}]`);
            }
          }
          return promptAgain();
        } else if (trimmed.startsWith("/plan")) {
          handlePlanModeCommand(trimmed, modeController);
          return promptAgain();
        } else if (trimmed.startsWith("/git")) {
          handleGitCommand(trimmed, workdir);
          return promptAgain();
        } else if (trimmed.startsWith("/remember")) {
          const remembered = rememberCommandAsMessage(trimmed);
          return remembered ?? promptAgain();
        } else if (trimmed.startsWith("/journal")) {
          await handleJournalCommand(trimmed, workdir, config);
          return promptAgain();
        } else if (trimmed.startsWith("/memory")) {
          await handleFileMemoryCommand(trimmed, workdir, config);
          return promptAgain();
        } else if (trimmed.startsWith("/profile")) {
          await handleProfileCommand(trimmed, workdir, config);
          return promptAgain();
        } else if (trimmed.startsWith("/model")) {
          handleModelCommand(trimmed, config);
          return promptAgain();
        } else if (trimmed.startsWith("/tasks")) {
          await handleTasksCommand(trimmed, currentSessionId());
          return promptAgain();
        } else if (trimmed.startsWith("/trace")) {
          handleTraceCommand(trimmed, currentSessionId());
          return promptAgain();
        } else if (trimmed.startsWith("/scrub")) {
          handleScrubCommand(trimmed);
          return promptAgain();
        } else if (trimmed.startsWith("/") && getSkillRegistry().getSkill(trimmed.split(/\s+/)[0].slice(1))) {
          if (modeController.mode === "plan") {
            console.log("\n  Skills are unavailable in Plan mode. Use /plan off first.");
            return promptAgain();
          }
          const passthrough = await handleSkillCommand(trimmed, workdir, config);
          if (typeof passthrough === "string") {
            // Inline skill: pass through to the model
            return passthrough;
          } else {
            // Fork skill or unknown: already handled, next REPL prompt
            return promptAgain();
          }
        } else {
          return trimmed || null;
        }
  };
}

// ---- Permission confirmation prompt ----

/**
 * Format tool input for display in the confirmation prompt.
 * Shows the most relevant parameter (command for Bash, file_path for Read/Write/Edit).
 */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" && input.command) {
    return String(input.command);
  }
  if (input.file_path) {
    return `${toolName}: ${input.file_path}`;
  }
  // Fallback: show first key-value pair
  const entries = Object.entries(input).slice(0, 2);
  return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
}

const CONFIRM_BOX_WIDTH = 54;

function createConfirmPrompt(
  rl: readline.Interface,
): (toolName: string, input: Record<string, unknown>) => Promise<ConfirmDecision> {
  return (toolName: string, input: Record<string, unknown>): Promise<ConfirmDecision> => {
    return new Promise((resolve) => {
      const detail = formatToolInput(toolName, input);
      const truncated = detail.length > CONFIRM_BOX_WIDTH - 6
        ? detail.slice(0, CONFIRM_BOX_WIDTH - 9) + "..."
        : detail;

      // Box drawing with ANSI
      const top = `\n  ╔══ \x1b[33m🔧 ${toolName}\x1b[0m ${"═".repeat(Math.max(0, CONFIRM_BOX_WIDTH - toolName.length - 12))}╗`;
      const mid = `  ║  \x1b[36m${truncated}\x1b[0m${" ".repeat(Math.max(0, CONFIRM_BOX_WIDTH - truncated.length - 6))}║`;
      const sep = `  ║  ${" ".repeat(CONFIRM_BOX_WIDTH - 6)}║`;
      const opt = `  ║  \x1b[32m[y]\x1b[0m Yes   \x1b[32m[a]\x1b[0m Always   \x1b[31m[n]\x1b[0m No   \x1b[31m[d]\x1b[0m Deny all  ║`;
      const bot = `  ╚${"═".repeat(CONFIRM_BOX_WIDTH - 2)}╝`;

      console.log(top);
      console.log(mid);
      console.log(sep);
      console.log(opt);
      console.log(bot);

      rl.question("  ▸ ", (answer) => {
        const trimmed = answer.trim().toLowerCase();
        switch (trimmed) {
          case "y": case "yes": resolve("allow_once"); break;
          case "a": case "always": resolve("allow_always"); break;
          case "d": case "deny all": resolve("deny_always"); break;
          case "n": case "no": default: resolve("deny_once"); break;
        }
      });
    });
  };
}

async function main(): Promise<void> {
  const { prompt, workdir, model, provider, interactive, continueSession, resumeSession } = parseArgs();

  // Load API keys from .env files (shell env takes priority)
  loadEnvFiles(workdir);

  const config = loadConfig(workdir);

  const recoveredOrphans = processSubagentRegistry.recoverProjectOrphans(workdir);
  if (recoveredOrphans.length > 0) {
    console.warn(
      `Recovered ${recoveredOrphans.length} interrupted subagent task(s) as orphaned. ` +
      "Use /trace or inspect their result.json files for details.",
    );
    for (const result of recoveredOrphans) {
      console.warn(
        result.workspace
          ? `  ${result.taskId}: branch=${result.workspace.branch} ` +
            `worktree=${result.workspace.path} dirty=${result.workspace.dirty} ` +
            `result=${result.resultPath}`
          : `  ${result.taskId}: result=${result.resultPath}`,
      );
    }
  }

  // CLI overrides
  if (model) config.model.model = model;
  if (provider) config.model.provider = provider;

  const renderer = new AnsiStreamRenderer();

  console.log(`rubato v0.2.0`);
  console.log(`Provider: ${config.model.provider} | Model: ${config.model.model}`);
  console.log(`Working dir: ${workdir}`);
  console.log(`Tools: ${getAllTools().length} registered`);

  // ---- Session manager ----
  const sessionManager = new SessionManager(workdir);

  // Initialize custom agent definitions
  try { initCustomDefinitions(workdir); } catch (error) { warnRecoverable(`agents:${workdir}:load`, error); }
  // Load skills from .rubato/skills/
  try { loadAllSkills(workdir); } catch (error) { warnRecoverable(`skills:${workdir}:load`, error); }

  const modeController = new AgentModeController();

  // Repository facts and queued Dreams are refreshed in the background so the
  // first turn is never delayed by a project scan or a model-backed Dream.
  const memoryMaintenance = startMemoryMaintenance({ workingDir: workdir, config });

  // ---- MCP Server Startup ----
  const mcpConfigs = loadMcpConfigs(workdir);
  for (const cfg of mcpConfigs) {
    try {
      const client = new McpClient(cfg);
      const tools = await connectMcpServer(client, cfg.name);
      for (const tool of tools) register(tool);
      console.log(`MCP: ${cfg.name} connected (${tools.length} tools)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`MCP: ${cfg.name} failed — ${msg}`);
    }
  }

  if (interactive) {
    console.log(`Mode: default (interactive; type /exit to quit, /help for help)`);
  }

  // ---- Handle --continue / --resume ----
  let effectivePrompt = prompt || (interactive ? "" : "Hello! What would you like to work on?");
  let initialResumeSummary: string | undefined;

  if (continueSession) {
    const recent = SessionManager.findMostRecent(workdir);
    if (recent) {
      try {
        const { summary } = sessionManager.resumeSession(recent.id);
        initialResumeSummary = summary;
        console.log(`\n  📋 Resuming session: ${recent.id.slice(0, 8)}...`);
        if (recent.firstMessage) {
          console.log(`  "${recent.firstMessage.slice(0, 80)}"`);
        }
      } catch (error) { warnRecoverable(`session:${recent.id}:resume`, error); }
    } else {
      console.log("\n  No previous sessions found for this project.");
    }
  }

  if (resumeSession !== undefined) {
    if (resumeSession === "") {
      // Show interactive picker
      const sessions = sessionManager.listSessions();
      if (sessions.length === 0) {
        console.log("\n  No sessions found for this project.");
        process.exit(1);
      }
      console.log("\n  Select a session to resume:");
      sessions.forEach((s, i) => {
        const when = new Date(s.createdAt).toLocaleString();
          console.log(`  ${i}: ${s.id.slice(0, 8)}... — ${s.firstMessage?.slice(0, 60)} (${s.status}, ${when})`);
      });
      // Use readline to get selection
      const selection = await new Promise<string>((resolve) => {
        const selRl = readline.createInterface({ input: process.stdin, output: process.stdout });
        selRl.question("\n  Enter #: ", (answer) => {
          selRl.close();
          resolve(answer.trim());
        });
      });
      const idx = parseInt(selection, 10);
      if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
        console.log("\n  Invalid selection.");
        process.exit(1);
      }
      const { summary } = sessionManager.resumeSession(sessions[idx].id);
      initialResumeSummary = summary;
    } else {
      // Resume specific session by ID/prefix
      const sessions = sessionManager.listSessions();
      const matches = sessions.filter((s) => s.id.startsWith(resumeSession));
      if (matches.length === 0) {
        console.log(`\n  No session found matching "${resumeSession}".`);
        process.exit(1);
      }
      if (matches.length > 1) {
        console.log("\n  Multiple matches. Be more specific:");
        matches.forEach((s) => console.log(`    ${s.id}`));
        process.exit(1);
      }
      try {
        const { summary } = sessionManager.resumeSession(matches[0].id);
        initialResumeSummary = summary;
        console.log(`\n  📋 Resuming session: ${matches[0].id.slice(0, 8)}...`);
      } catch (error) { warnRecoverable(`session:${matches[0].id}:resume`, error); }
    }
  }

  // Setup REPL if interactive
  const rl = interactive
    ? readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: createSlashCompleter(),
      })
    : null;

  // In interactive mode with no initial prompt, wait for the user's first real message
  if (interactive && !prompt && !continueSession && !resumeSession) {
    effectivePrompt = await getFirstMessage(rl!, modeController, workdir, config);
    if (effectivePrompt === "/exit") {
      console.log("Exiting...");
      if (rl) rl.close();
      process.exit(0);
    }
    if (!effectivePrompt) {
      console.log("Exiting...");
      if (rl) rl.close();
      process.exit(0);
    }
    // Don't renderUserMessage here — readline already echoes what the user typed
  } else if (effectivePrompt) {
    renderer.renderUserMessage(effectivePrompt);
  }

  const loopOptions: { forceCompaction?: boolean } = {};

  // Track whether we're processing a turn (so Ctrl+C knows to abort vs exit)
  let processing = true;

  // Ctrl+C handling: abort current request when processing, exit when idle
  const onSigInt = () => {
    if (processing) {
      abortCurrentRequest();
      console.log("\n  ⏹ Interrupted current root run — background Subagents continue...");
    } else {
      const runtime = processSubagentRegistry.get(activeSessionId);
      if (runtime?.hasPendingTasks()) {
        console.log("\n  Background Subagents are still active. Use /tasks to inspect or /exit to stop the process.");
        return;
      }
      console.log("\n  Exiting...");
      memoryMaintenance.cancel();
      for (const runtime of processSubagentRegistry.list()) {
        for (const task of runtime.list()) {
          if (task.status === "queued" || task.status === "running") {
            void runtime.cancel(task.taskId);
          }
        }
      }
      if (rl) rl.close();
      process.exit(0);
    }
  };
  process.on("SIGINT", onSigInt);

  // ---- Outer restart loop ----
  let loopState: LoopState = { shouldRestart: false };
  let sessionTokens = 0;
  let activeSessionId = "";

  // Mutable getter for current session ID (for REPL handlers)
  const getSessionId = () => activeSessionId;

  // Called by REPL before restarting/exiting to save session state
  const onSessionFinalize = () => {
    const finalizedSessionId = activeSessionId;
    if (finalizedSessionId && sessionManager) {
      sessionManager.updateSession(finalizedSessionId, {
        tokenCount: sessionTokens,
        status: "ended",
      });
    }
    const runtime = processSubagentRegistry.get(finalizedSessionId);
    if (runtime) {
      const pending = runtime.list().filter((task) =>
        task.status === "queued" || task.status === "running",
      );
      void Promise.all(pending.map((task) => runtime.cancel(task.taskId)))
        .finally(() => processSubagentRegistry.remove(finalizedSessionId));
    }
  };

  do {
    loopState = { shouldRestart: false };
    activeSessionId = loopState.newSessionId ?? randomUUID();
    sessionTokens = 0;

    const resumeSummary = loopState.resumeSummary ?? initialResumeSummary;
    initialResumeSummary = undefined; // only inject on first iteration
    try {
      for await (const event of agentLoop({
        config,
        workingDir: workdir,
        prompt: effectivePrompt,
        renderer,
        sessionId: activeSessionId,
        sessionManager,
        resumeSummary,
        getNextUserMessage: rl
          ? createRepl(rl, modeController, workdir, config, loopOptions, sessionManager, loopState, getSessionId, onSessionFinalize)
          : undefined,
        forceCompaction: loopOptions.forceCompaction,
        onConfirmTool: rl ? createConfirmPrompt(rl) : undefined,
        modeController,
      })) {
        switch (event.type) {
          case "turn_start":
            processing = true;
            break;

          case "text":
            // Already rendered by stream
            break;

          case "thinking":
            break;

          case "tool_result":
            if (event.name !== "SubmitPlan") {
              renderer.renderToolResult(
                `${event.name}: ${event.isError ? "✖" : "✓"} ${event.result.substring(0, 200)}`
              );
            }
            break;

          case "error":
            renderer.renderError(event.message);
            break;

          case "warning":
            renderer.renderWarning(event.message);
            break;

          case "compacting":
            renderer.renderSystemMessage(`Compacting context: ${event.reason}`);
            break;

          case "waiting_for_input":
            processing = false; // idle — Ctrl+C will exit
            break;

          case "plan_ready":
            console.log(`\n${event.plan.markdown}`);
            console.log(`\n  Saved: ${event.plan.path}`);
            console.log("\n  执行这个计划？输入 y 执行，或直接说明需要修改的地方：");
            break;

          case "done":
            console.log(`\n[Session ended: ${event.reason}]`);
            processing = false;
            break;

          case "turn_end":
            if (event.usage) {
              sessionTokens += event.usage.input + event.usage.output;
            }
            break;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      renderer.renderError(`Fatal: ${message}`);
      process.exit(1);
    } finally {
      processing = false;
    }

    // Finalize session if it was active
    if (activeSessionId) {
      onSessionFinalize();
    }

    // If restarting, wait for user input instead of auto-sending a prompt
    if (loopState.shouldRestart) {
      effectivePrompt = await readMultiLineInput(
        rl!,
        modeController.mode === "plan" ? "\n▸ Plan: " : "\n▸ You: ",
      ) || "/exit";
      if (effectivePrompt === "/exit") {
        console.log("Exiting...");
        break;
      }
      loopOptions.forceCompaction = false;
    }
  } while (loopState.shouldRestart);

  process.off("SIGINT", onSigInt);
  memoryMaintenance.cancel();
  for (const runtime of processSubagentRegistry.list()) {
    for (const task of runtime.list()) {
      if (task.status === "queued" || task.status === "running") {
        await runtime.cancel(task.taskId);
      }
    }
  }
  if (rl) rl.close();
  for (const cfg of mcpConfigs) {
    for (const toolName of disconnectMcpServer(cfg.name)) unregister(toolName);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
