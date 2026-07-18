#!/usr/bin/env node
// CLI entry point — parses arguments, loads config, runs the agent

import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import * as readline from "readline";
import YAML from "yaml";
import type { ConfirmDecision, SessionMeta } from "../core-types.js";
import { loadConfig, loadEnvFiles } from "./config-loader.js";
import { AnsiStreamRenderer } from "./stream-renderer.js";
import { agentLoop, abortCurrentRequest } from "../agent/loop.js";
import {
  register,
  getTool,
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
import { planTool } from "../tools/plan.js";
import { agentTool } from "../tools/agent.js";
import { skillTool } from "../tools/skill.js";
import { PlanManager } from "../plan/manager.js";
import { getJournalStore } from "../journal/store.js";
import { getMnemosyneStore } from "../memory/store.js";
import { initCustomDefinitions } from "../agent/agent-defs.js";
import { initEmbeddings } from "../embedding/generate.js";
import { getGitState, getCurrentBranch } from "../git/advisor.js";
import { getBranchHealth } from "../git/branch-health.js";
import { McpClient } from "../mcp/client.js";
import { connectMcpServer, adaptMcpTool } from "../mcp/adapter.js";
import type { McpServerConfig } from "../mcp/types.js";
import { loadAllSkills } from "../skills/loader.js";
import { getSkillRegistry } from "../skills/registry.js";
import type { SkillDefinition } from "../skills/types.js";
import { spawnSubagent } from "../agent/subagent.js";
import type { AgentConfig, AgentContext } from "../core-types.js";
import { PolicyEngine } from "../permissions/policy.js";
import { SessionManager } from "../session/manager.js";

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
register(planTool);
register(agentTool);
register(skillTool);

// ---- Argument parsing ----

function parseArgs(): {
  prompt: string;
  workdir: string;
  model?: string;
  provider?: string;
  interactive: boolean;
  continueSession: boolean;
  resumeSession?: string;
} {
  const args = process.argv.slice(2);
  let workdir = process.cwd();
  let model: string | undefined;
  let provider: string | undefined;
  let interactive = true;   // default: interactive
  let oneShot = false;
  let continueSession = false;
  let resumeSession: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-d":
      case "--dir":
        workdir = path.resolve(args[++i] ?? workdir);
        break;
      case "-m":
      case "--model":
        model = args[++i];
        break;
      case "-p":
      case "--provider":
        provider = args[++i];
        break;
      case "-n":
      case "--one-shot":
        oneShot = true;
        interactive = false;
        break;
      case "-c":
      case "--continue":
        continueSession = true;
        break;
      case "-r":
      case "--resume":
        resumeSession = args[++i] ?? "";
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        if (!args[i].startsWith("-")) {
          positional.push(args[i]);
        }
    }
  }

  const prompt = positional.join(" ") || getStdinPrompt();

  // Pipe input → one-shot (can't do REPL over pipe)
  if (!process.stdin.isTTY) {
    interactive = false;
  }

  // Explicit -n overrides
  if (oneShot) {
    interactive = false;
  }

  return { prompt, workdir, model, provider, interactive, continueSession, resumeSession };
}

function getStdinPrompt(): string {
  // Check if there's piped input
  try {
    const { stdin } = process;
    if (!stdin.isTTY) {
      // Synchronous read for piped content
      
      const fd = fs.openSync("/dev/stdin", "r");
      const buffer = Buffer.alloc(1024 * 1024); // 1MB max
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      if (bytesRead > 0) {
        return buffer.toString("utf-8", 0, bytesRead).trim();
      }
    }
  } catch {
    // Not available
  }
  return "";
}

function printHelp(): void {
  console.log(`
rubato — elastic tempo for your code

Usage:
  rubato [options] [prompt]       Interactive by default (REPL after answer)
  rubato -n [prompt]              One-shot: answer and exit
  echo "your prompt" | rubato -n [options]

Options:
  -d, --dir <path>    Working directory (default: current directory)
  -m, --model <name>  Model override (e.g. "deepseek-chat", "claude-sonnet-4-20250514")
  -p, --provider <n>  Provider override (e.g. "deepseek", "openai", "anthropic")
  -c, --continue      Resume the most recent session in this project
  -r, --resume [id]   Resume a specific session by ID (or show picker)
  -n, --one-shot      Run once and exit (no REPL)
  -h, --help          Show this help

API Keys:
  Set API keys in .env, .env.local (working dir or ~/.rubato/).
  Shell environment variables override .env files.
  Supported: DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY

REPL Commands:
  /exit, /quit         Exit the chat
  /clear               Start a fresh session (saves current)
  /sessions            List project sessions
  /sessions resume <n> Resume a past session
  /help                Show REPL help
  Ctrl+C               Interrupt output / Exit when idle

Config:
  Place .rubato.yml in your project root or ~/.rubato/config.yml
`);
}

// ---- MCP Config Loader ----

function loadMcpConfigs(workingDir: string): McpServerConfig[] {
  const configs: McpServerConfig[] = [];
  const paths = [
    path.join(workingDir, ".agent", "mcp.json"),
    path.join(process.env.HOME ?? "/tmp", ".rubato", "mcp.json"),
  ];

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
        const servers = (raw.servers ?? raw) as McpServerConfig[] | Record<string, Omit<McpServerConfig, "name">>;
        if (Array.isArray(servers)) {
          configs.push(...servers);
        } else {
          for (const [name, cfg] of Object.entries(servers)) {
            configs.push({ name, ...cfg });
          }
        }
      }
    } catch {
      // Invalid JSON or missing file — skip
    }
  }

  return configs;
}

// ---- Git command handler ----

async function handleGitCommand(input: string, workdir: string): Promise<void> {
  const args = input.split(/\s+/).slice(1);

  if (args.length === 0 || args[0] === "status") {
    const state = await getGitState(workdir);
    if (!state) {
      console.log("\n  当前目录不是 Git 仓库。");
      return;
    }
    console.log(`\n  🌿 分支：${state.branch}`);
    console.log(`  远程：领先 ${state.aheadOfRemote} | 落后 ${state.behindRemote}`);
    console.log(`  变更文件：${state.changedFiles.length > 0 ? state.changedFiles.join(", ") : "(干净)"}`);
    if (state.recentCommits.length > 0) {
      console.log(`  最近提交：${state.recentCommits[0].hash} ${state.recentCommits[0].message}`);
    }
    return;
  }

  if (args[0] === "health") {
    const health = await getBranchHealth(workdir);
    if (!health) {
      console.log("\n  无法获取分支健康状态。");
      return;
    }
    console.log(`\n  🌿 默认分支：${health.defaultBranch} | 当前：${health.currentBranch}`);
    console.log(`  总体状态：${health.overallStatus}`);
    for (const b of health.branches.slice(0, 5)) {
      const icon = b.status === "healthy" ? "✅" : b.status === "stale" ? "⏰" : "⚠️";
      console.log(`  ${icon} ${b.branch} — ${b.recommendation}`);
    }
    return;
  }

  console.log("\n  用法：/git、/git status、/git health");
}

// ---- Journal command handler (now backed by unified Mnemosyne) ----

async function handleJournalCommand(input: string, workdir: string): Promise<void> {
  const args = input.split(/\s+/).slice(1);
  const store = getMnemosyneStore();

  if (input.startsWith("/remember")) {
    const title = args.join(" ") || "Untitled";
    store.addManualMemory(title, `Manual save from session at ${workdir}.`, [], "manual", "note");
    console.log(`\n  📓 已保存到统一记忆图谱：「${title}」(protected)`);
    return;
  }

  if (args.length === 0 || args[0] === "recent") {
    const recent = store.getManualMemories(10);
    if (recent.length === 0) {
      console.log("\n  📓 知识库为空。用 /remember <标题> 保存第一条知识！");
      return;
    }
    console.log("\n  📓 个人知识（统一记忆图谱）：");
    for (const entry of recent) {
      const icon = entry.type === "error" ? "🔧" : entry.type === "concept" ? "💡" : "📝";
      const tags = entry.tags ? entry.tags.split(",").filter(Boolean) : [];
      console.log(`  ${icon} ${entry.name} (${tags.join(", ") || "无标签"}) [protected]`);
    }
    return;
  }

  if (args[0] === "search") {
    const query = args.slice(1).join(" ");
    if (!query) { console.log("\n  用法：/journal search <关键词>"); return; }
    const results = store.searchWithRelevance(query, 5);
    if (results.length === 0) { console.log(`\n  未找到与「${query}」相关的记忆。`); return; }
    console.log(`\n  搜索「${query}」结果：`);
    for (const { entity, relevance } of results) {
      const sourceLabel = entity.source === "manual" ? "[手动]" : entity.source === "memories_md" ? "[MD]" : "[自动]";
      console.log(`  - ${sourceLabel} [${entity.type}] ${entity.name} (相关度: ${relevance.toFixed(2)})`);
      if (entity.content) console.log(`    ${entity.content.slice(0, 100)}...`);
    }
    return;
  }

  if (args[0] === "stats") {
    const stats = store.getStats();
    console.log(`\n  📓 统一记忆图谱统计：`);
    console.log(`  总实体：${stats.entities} | 关系：${stats.relations} | 手动知识：${stats.manualMemories}`);
    return;
  }

  console.log("\n  用法：/journal、/journal search <q>、/journal stats、/journal recent");
}

// ---- Memory command handler ----

async function handleMemoryCommand(input: string): Promise<void> {
  const args = input.split(/\s+/).slice(1);
  try {
    const store = getMnemosyneStore();
    const stats = store.getStats();

    if (args[0] === "stats" || args.length === 0) {
      console.log(`\n  🧠 Mnemosyne 统一记忆图谱：`);
      console.log(`  实体：${stats.entities} | 关系：${stats.relations} | 访问记录：${stats.accessLogs}`);
      console.log(`  手动知识：${stats.manualMemories} (protected)`);
      console.log(`  存储路径：~/.rubato/mnemosyne/memory.db`);
      return;
    }

    if (args[0] === "search") {
      const query = args.slice(1).join(" ");
      if (!query) { console.log("\n  用法：/memory search <关键词>"); return; }
      const results = store.searchWithRelevance(query, 5);
      if (results.length === 0) { console.log(`\n  未找到与「${query}」相关的实体。`); return; }
      console.log(`\n  搜索「${query}」结果：`);
      for (const { entity, relevance } of results) {
        console.log(`  - [${entity.type}] ${entity.name} (相关度: ${relevance.toFixed(2)})`);
      }
      return;
    }
  } catch {
    console.log("\n  记忆系统未初始化或不可用。");
    return;
  }
  console.log("\n  用法：/memory、/memory stats、/memory search <q>");
}

// ---- Model command handler ----

function saveModelPreference(provider: string, model: string): void {
  const dir = path.join(process.env.HOME ?? "/tmp", ".rubato");
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, "config.yml");
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      existing = YAML.parse(fs.readFileSync(configPath, "utf-8")) ?? {};
    }
  } catch { /* overwrite if corrupt */ }
  existing.model = { ...(existing.model as Record<string, unknown> ?? {}), provider, model };
  fs.writeFileSync(configPath, YAML.stringify(existing), "utf-8");
}

function handleModelCommand(
  input: string,
  config: { model: { provider: string; model: string } }
): void {
  const args = input.split(/\s+/).slice(1);

  if (args.length === 0) {
    console.log(`\n  Current: ${config.model.provider}/${config.model.model}`);
    console.log(`  Type /model <name> to switch  (e.g. /model deepseek-chat)`);
    return;
  }

  const target = args[0];
  const targetLower = target.toLowerCase();

  // Try to guess provider from model name
  let provider = config.model.provider; // keep current by default
  if (targetLower.includes("claude") || targetLower.includes("anthropic")) provider = "anthropic";
  else if (targetLower.includes("gpt") || targetLower.includes("openai")) provider = "openai";
  else if (targetLower.includes("deepseek")) provider = "deepseek";
  else if (targetLower.includes("llama") || targetLower.includes("mixtral")) provider = "groq";

  config.model.provider = provider;
  config.model.model = target;
  saveModelPreference(provider, target);
  console.log(`\n  Switched to ${provider}/${target}  (takes effect on next message)`);
}

// ---- Sessions command handler ----

interface SessionsCommandResult {
  restartLoop: boolean;
  resumeId?: string;
}

function handleSessionsCommand(
  input: string,
  sessionManager: SessionManager,
): SessionsCommandResult {
  const args = input.split(/\s+/).slice(1);

  if (args.length === 0 || args[0] === "list") {
    const sessions = sessionManager.listSessions();
    if (sessions.length === 0) {
      console.log("\n  No sessions found for this project.");
      return { restartLoop: false };
    }
    console.log("\n  ── Sessions ──");
    console.log("  #   | When                | Status  | Model         | First message");
    console.log("  ----|---------------------|---------|---------------|--------------");
    sessions.forEach((s, i) => {
      const when = new Date(s.createdAt).toLocaleString().slice(0, 19);
      const status = s.status === "active" ? "\x1b[32mactive\x1b[0m" : "\x1b[90mended\x1b[0m";
      const model = s.model.slice(0, 13).padEnd(13);
      const msg = (s.firstMessage ?? "").slice(0, 50);
      const idx = String(i).padEnd(3);
      const tokenStr = s.tokenCount > 0 ? `\x1b[90m${Math.round(s.tokenCount / 1000)}k\x1b[0m` : "";
      console.log(`  ${idx} | ${when} | ${status}   | ${model} | ${msg} ${tokenStr}`);
    });
    console.log(`\n  /sessions resume <#> or <id-prefix> to resume`);
    return { restartLoop: false };
  }

  if (args[0] === "resume") {
    const target = args[1];
    if (!target) {
      console.log("\n  Usage: /sessions resume <#> or /sessions resume <id-prefix>");
      return { restartLoop: false };
    }

    const sessions = sessionManager.listSessions();

    // Try numeric index first
    const numIndex = parseInt(target, 10);
    if (!isNaN(numIndex) && numIndex >= 0 && numIndex < sessions.length) {
      return { restartLoop: true, resumeId: sessions[numIndex].id };
    }

    // Try ID prefix match
    const matches = sessions.filter((s) => s.id.startsWith(target));
    if (matches.length === 1) {
      return { restartLoop: true, resumeId: matches[0].id };
    } else if (matches.length > 1) {
      console.log("\n  Multiple sessions match. Be more specific:");
      matches.forEach((s) => console.log(`    ${s.id} — ${s.firstMessage?.slice(0, 60)}`));
      return { restartLoop: false };
    }

    console.log(`\n  No session found matching "${target}".`);
    return { restartLoop: false };
  }

  console.log("\n  Usage: /sessions, /sessions resume <#|id-prefix>");
  return { restartLoop: false };
}

// ---- Skill command handler ----

/**
 * Handle a /skill-name command from the REPL.
 * Returns:
 *   - string: pass this as user input to the model (inline mode, or passthrough)
 *   - null/undefined: already handled, recurse REPL (fork mode)
 */
async function handleSkillCommand(
  input: string,
  workdir: string,
  config: AgentConfig
): Promise<string | null> {
  const parts = input.split(/\s+/);
  const cmdName = parts[0].slice(1); // strip leading "/"
  const args = parts.slice(1).join(" ");

  const registry = getSkillRegistry();
  const skill = registry.getSkill(cmdName);

  if (!skill) {
    console.log(`\n  Unknown skill: /${cmdName}`);
    return null; // recurse REPL
  }

  const context = skill.context ?? "inline";

  if (context === "inline") {
    // Inline skills: pass through to the model.
    // The skill's instructions are already in the system prompt catalog.
    // We just forward the user's message so the model can apply the skill.
    if (args) {
      console.log(`\n  📋 Skill "${skill.name}" — passing to model...`);
    }
    // Return the input without the leading slash prefix, so the model sees
    // the intent naturally: "/code-review src/auth.ts" → "code-review src/auth.ts"
    return args || skill.name;
  }

  // Fork mode: spawn a subagent directly from the REPL
  console.log(`\n  🔧 Running skill "${skill.name}"...`);

  // Build a minimal subagent definition from the skill
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

  // Build permissions with allowed-tools pre-authorized
  const permissions = { ...config.permissions };
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    const allowRules = skill.allowedTools.map((pattern) => ({
      tool: "*" as const,
      pattern,
      action: "allow" as const,
      reason: `Skill "${skill.name}" pre-authorization`,
    }));
    permissions.rules = [...(permissions.rules ?? []), ...allowRules];
  }

  // Build a minimal agent context with allowed-tools permissions
  const minimalCtx: AgentContext = {
    workingDir: workdir,
    sessionId: `skill-${cmdName}-${Date.now()}`,
    readGuard: {
      hasRead: () => false,
      markAsRead: () => {},
      serialize: () => ({ files: {} }),
    },
    permissionManager: new PolicyEngine(permissions),
    config: { ...config, permissions },
  };

  try {
    const result = await spawnSubagent(
      subagentDef,
      args || `Run the "${skill.name}" skill`,
      minimalCtx,
      { ...config, permissions }
    );

    console.log(`\n  ── ${skill.name} output ──`);
    console.log(result.output || "(no output)");
    if (result.usage.toolCalls > 0) {
      console.log(
        `  [${result.status}] ${result.usage.inputTokens} in / ${result.usage.outputTokens} out / ${result.usage.toolCalls} tools`
      );
    }
  } catch (err) {
    console.log(
      `\n  ✖ Skill "${skill.name}" failed: ${err instanceof Error ? err.message : err}`
    );
  }

  return null; // recurse REPL after fork-mode skill completes
}

// ---- Tab completion & / menu ----

function getSlashCompletions(): string[] {
  const builtin = [
    "/exit", "/quit", "/compact", "/clear", "/help",
    "/plan", "/plan new", "/plan list", "/plan done", "/plan show",
    "/grillme", "/grillme on", "/grillme off", "/grillme strict", "/grillme normal", "/grillme loose",
    "/git", "/git health",
    "/journal", "/journal recent", "/journal search", "/journal stats",
    "/remember",
    "/memory", "/memory stats", "/memory search",
    "/model",
    "/sessions", "/sessions list", "/sessions resume",
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
  console.log("  /clear              Start a fresh session");
  console.log("  /compact            Compact context");
  console.log("  /plan               Show plan | /plan new <desc> | /plan done");
  console.log("  /grillme            Toggle plan tracking | /grillme on/off/strict/normal/loose");
  console.log("  /git                Git status | /git health");
  console.log("  /journal            Search journal | /journal search <q>");
  console.log("  /remember <title>   Save to journal");
  console.log("  /memory             Memory stats | /memory search <q>");
  console.log("  /model              Switch model | /model <name>");
  console.log("  /sessions           List sessions | /sessions resume <#>");
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

// ---- Main ----

function createRepl(
  rl: readline.Interface,
  planManager: PlanManager,
  workdir: string,
  config: AgentConfig,
  loopOptions: { forceCompaction?: boolean },
  sessionManager: SessionManager,
  loopState: LoopState,
  currentSessionId: () => string,
  onSessionFinalize: () => void,
): () => Promise<string | null> {
  return () => {
    return new Promise((resolve) => {
      rl.question("\n▸ You: ", (answer) => {
        const trimmed = answer.trim();
        if (trimmed === "/") {
          showSlashMenu();
          resolve(createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, currentSessionId, onSessionFinalize)());
        } else if (trimmed === "/exit" || trimmed === "/quit") {
          onSessionFinalize();
          resolve(null);
        } else if (trimmed === "/clear") {
          // Finalize current session and restart
          onSessionFinalize();
          loopState.shouldRestart = true;
          loopState.newSessionId = randomUUID();
          console.log("\n  ✨ Session saved. Starting fresh...");
          resolve(null);
        } else if (trimmed === "/compact") {
          if (loopOptions) { loopOptions.forceCompaction = true; }
          console.log("\n  Compacting on next turn...");
          resolve(createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, currentSessionId, onSessionFinalize)());
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
            resolve(null);
          } else {
            resolve(createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, currentSessionId, onSessionFinalize)());
          }
        } else if (trimmed === "/help") {
          console.log("\n  REPL Commands:");
          console.log("  /exit, /quit      — Exit the chat");
          console.log("  /clear             — Start a fresh session (saves current)");
          console.log("  /compact           — Summarize earlier context to free space");
          console.log("  /plan             — Show current plan");
          console.log("  /plan new <desc>  — Start a new plan (gathering mode)");
          console.log("  /plan done        — Mark plan as completed");
          console.log("  /grillme on/off   — Toggle Grill Me tracking");
          console.log("  /grillme strict|normal|loose — Set sensitivity");
          console.log("  /git              — Show current git status");
          console.log("  /git health       — Show branch health summary");
          console.log("  /journal search <q> — Search personal knowledge base");
          console.log("  /remember <title> — Save current context to journal");
          console.log("  /memory stats     — Show Mnemosyne memory stats");
          console.log("  /model            — List / switch models");
          console.log("  /sessions         — List project sessions | /sessions resume <#>");
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
          resolve(createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, currentSessionId, onSessionFinalize)());
        } else if (trimmed.startsWith("/plan")) {
          handlePlanCommand(trimmed, planManager);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, currentSessionId, onSessionFinalize)());
        } else if (trimmed.startsWith("/grillme")) {
          handleGrillMeCommand(trimmed, planManager);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, currentSessionId, onSessionFinalize)());
        } else if (trimmed.startsWith("/git")) {
          handleGitCommand(trimmed, workdir);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, currentSessionId, onSessionFinalize)());
        } else if (trimmed.startsWith("/journal") || trimmed.startsWith("/remember")) {
          handleJournalCommand(trimmed, workdir);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, currentSessionId, onSessionFinalize)());
        } else if (trimmed.startsWith("/memory")) {
          handleMemoryCommand(trimmed);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, currentSessionId, onSessionFinalize)());
        } else if (trimmed.startsWith("/model")) {
          handleModelCommand(trimmed, config);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, currentSessionId, onSessionFinalize)());
        } else if (trimmed.startsWith("/") && getSkillRegistry().getSkill(trimmed.split(/\s+/)[0].slice(1))) {
          handleSkillCommand(trimmed, workdir, config).then((passthrough) => {
            if (typeof passthrough === "string") {
              // Inline skill: pass through to the model
              resolve(passthrough);
            } else {
              // Fork skill or unknown: already handled, next REPL prompt
              resolve(createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, currentSessionId, onSessionFinalize)());
            }
          });
        } else {
          resolve(trimmed || null);
        }
      });
    });
  };
}

function handlePlanCommand(input: string, pm: PlanManager): void {
  const args = input.split(/\s+/).slice(1);

  if (args.length === 0 || args[0] === "show") {
    console.log("\n" + pm.showPlan());
    return;
  }

  if (args[0] === "list") {
    const plans = pm.listPlans();
    if (plans.length === 0) {
      console.log("\n  没有保存的计划。");
    } else {
      console.log("\n  已保存的计划：");
      plans.forEach((p) => console.log(`    - ${p}`));
    }
    return;
  }

  if (args[0] === "new") {
    const desc = args.slice(1).join(" ");
    if (!desc) {
      console.log("\n  用法：/plan new <任务描述>");
      return;
    }
    pm.startRequirementsGathering(desc);
    console.log(`\n  🔍 需求澄清模式：对「${desc}」开始收集信息。`);
    console.log("  请直接向 AI 描述你的需求，AI 会逐步追问。");
    console.log("  输入 '你先按默认方案来' 可跳过剩余问题。");
    return;
  }

  if (args[0] === "done") {
    const plan = pm.getActivePlan();
    if (!plan) {
      console.log("\n  没有活跃计划。");
      return;
    }
    // Mark plan as done
    plan.status = "done";
    pm.savePlan();
    console.log(`\n  ✅ 计划「${plan.title}」已标记为完成。`);
    return;
  }

  console.log("\n  未知的 plan 子命令。试试 /plan、/plan new、/plan list、/plan done");
}

function handleGrillMeCommand(input: string, pm: PlanManager): void {
  const args = input.split(/\s+/).slice(1);

  if (args.length === 0 || args[0] === "status") {
    const cfg = pm.getGrillMeConfig();
    console.log(`\n  Grill Me: ${cfg.enabled ? "🟢 ON" : "🔴 OFF"} | 灵敏度: ${cfg.sensitivity}`);
    return;
  }

  if (args[0] === "on") {
    pm.setGrillMeSensitivity("normal");
    console.log("\n  🟢 Grill Me 已开启（灵敏度：normal）");
    return;
  }

  if (args[0] === "off") {
    pm.toggleGrillMe();
    console.log("\n  🔴 Grill Me 已关闭");
    return;
  }

  if (["strict", "normal", "loose"].includes(args[0])) {
    pm.setGrillMeSensitivity(args[0] as "strict" | "normal" | "loose");
    console.log(`\n  Grill Me 灵敏度已设为：${args[0]}`);
    return;
  }

  console.log("\n  用法：/grillme on|off|strict|normal|loose|status");
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

  // Migrate old Journal entries into unified Mnemosyne (one-time, best-effort)
  try {
    const store = getMnemosyneStore();
    const journalDbPath = path.join(process.env.HOME ?? "/tmp", ".rubato", "journal", "journal.db");
    const migrated = store.migrateJournalEntries(journalDbPath);
    if (migrated > 0) {
      console.log(`📓 已将 ${migrated} 条旧知识迁移到统一记忆图谱。`);
    }
  } catch { /* Migration is best-effort */ }

  // Initialize custom agent definitions
  try { initCustomDefinitions(workdir); } catch { /* optional */ }
  // Load skills from .rubato/skills/
  try { loadAllSkills(workdir); } catch { /* optional */ }
  // Initialize embedding infrastructure (lazy download)
  initEmbeddings().catch(() => {});

  // Bootstrap memory seeder on first project open
  if (config.mnemosyne.bootstrap_on_first_open) {
    try {
      const { bootstrapMemories } = await import("../memory/seeder.js");
      const seedResult = await bootstrapMemories(workdir, config.mnemosyne.bootstrap_max_files);
      if (seedResult.totalSeeded > 0) {
        console.log(`🌱 Seeded ${seedResult.totalSeeded} initial memories from project scan.`);
      }
    } catch { /* best-effort */ }
  }

  // Load and display active plan
  const planManager = new PlanManager(workdir);
  const planSummary = planManager.getPlanSummary();
  if (planSummary) {
    console.log(`\n${planSummary}`);
  }

  // ---- MCP Server Startup ----
  const mcpConfigs = loadMcpConfigs(workdir);
  for (const cfg of mcpConfigs) {
    try {
      const client = new McpClient(cfg);
      const toolNames = await connectMcpServer(client, cfg.name);
      for (const name of toolNames) {
        const toolDef = adaptMcpTool(
          { name: name.replace(`mcp:${cfg.name}:`, ""), description: `MCP tool from ${cfg.name}`, inputSchema: { type: "object", properties: {} } },
          client
        );
        register({ ...toolDef, name: `mcp:${cfg.name}:${name.replace(`mcp:${cfg.name}:`, "")}` });
      }
      console.log(`MCP: ${cfg.name} connected (${toolNames.length} tools)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`MCP: ${cfg.name} failed — ${msg}`);
    }
  }

  if (interactive) {
    console.log(`Mode: interactive (type /exit to quit, /help for help)`);
  }

  // ---- Handle --continue / --resume ----
  let effectivePrompt = prompt || "Hello! What would you like to work on?";
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
      } catch { /* best-effort */ }
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
        console.log(`  ${i}: ${s.id.slice(0, 8)}... — ${s.firstMessage?.slice(0, 60)} (${s.status})`);
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
      } catch { /* best-effort */ }
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
    // Don't render a fake user message — get real input from user first
    effectivePrompt = await new Promise<string>((resolve) => {
      rl!.question("\n▸ You: ", (answer) => {
        const trimmed = answer.trim();
        if (!trimmed) {
          resolve("/exit"); // empty input → exit
        } else {
          resolve(trimmed);
        }
      });
    });
    if (effectivePrompt === "/exit") {
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
      console.log("\n  ⏹ Interrupted — returning to prompt...");
    } else {
      console.log("\n  Exiting...");
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
    if (activeSessionId && sessionManager) {
      sessionManager.updateSession(activeSessionId, {
        tokenCount: sessionTokens,
        status: "ended",
      });
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
          ? createRepl(rl, planManager, workdir, config, loopOptions, sessionManager, loopState, getSessionId, onSessionFinalize)
          : undefined,
        forceCompaction: loopOptions.forceCompaction,
        onConfirmTool: rl ? createConfirmPrompt(rl) : undefined,
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
            renderer.renderToolResult(
              `${event.name}: ${event.isError ? "✖" : "✓"} ${event.result.substring(0, 200)}`
            );
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
    }

    // Finalize session if it was active
    if (activeSessionId) {
      onSessionFinalize();
    }

    // If restarting, reset prompt for the new session
    if (loopState.shouldRestart) {
      effectivePrompt = "Hello! What would you like to work on?";
      loopOptions.forceCompaction = false;
    }
  } while (loopState.shouldRestart);

  process.off("SIGINT", onSigInt);
  if (rl) rl.close();
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
