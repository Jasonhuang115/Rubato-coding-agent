#!/usr/bin/env node
// CLI entry point — parses arguments, loads config, runs the agent

import path from "path";
import * as readline from "readline";
import { loadConfig, loadEnvFiles } from "./config-loader.js";
import { AnsiStreamRenderer } from "./stream-renderer.js";
import { agentLoop } from "../agent/loop.js";
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
import { PlanManager } from "../plan/manager.js";
import { getJournalStore } from "../journal/store.js";
import { getMnemosyneStore } from "../memory/store.js";
import { initCustomDefinitions } from "../agent/agent-defs.js";
import { initEmbeddings } from "../embedding/generate.js";
import { getGitState, getCurrentBranch } from "../git/advisor.js";
import { getBranchHealth } from "../git/branch-health.js";

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

// ---- Argument parsing ----

function parseArgs(): {
  prompt: string;
  workdir: string;
  model?: string;
  provider?: string;
  interactive: boolean;
} {
  const args = process.argv.slice(2);
  let workdir = process.cwd();
  let model: string | undefined;
  let provider: string | undefined;
  let interactive = true;   // default: interactive
  let oneShot = false;
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

  return { prompt, workdir, model, provider, interactive };
}

function getStdinPrompt(): string {
  // Check if there's piped input
  try {
    const { stdin } = process;
    if (!stdin.isTTY) {
      // Synchronous read for piped content
      const fs = require("fs");
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
  -n, --one-shot      Run once and exit (no REPL)
  -h, --help          Show this help

API Keys:
  Set API keys in .env, .env.local (working dir or ~/.rubato/).
  Shell environment variables override .env files.
  Supported: DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY

REPL Commands:
  /exit, /quit         Exit the chat
  /help                Show REPL help
  Ctrl+C               Exit

Config:
  Place .rubato.yml in your project root or ~/.rubato/config.yml
`);
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

const KNOWN_MODELS: Record<string, string[]> = {
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  anthropic: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-5-20251001"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  groq: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
  openrouter: ["openai/gpt-4o", "anthropic/claude-sonnet-4"],
  ollama: ["llama3", "codellama"],
};
// Note: if a model is not listed, /model <name> still works —
// it switches provider to match the known provider pattern, or keeps current provider.

function handleModelCommand(input: string, config: { model: { provider: string; model: string } }): void {
  const args = input.split(/\s+/).slice(1);

  // `/model` — list available models
  if (args.length === 0) {
    console.log(`\n  Current: ${config.model.provider}/${config.model.model}\n`);
    for (const [provider, models] of Object.entries(KNOWN_MODELS)) {
      const marker = provider === config.model.provider ? " ← current" : "";
      console.log(`  ${provider}:`);
      for (const m of models) {
        const mMarker = provider === config.model.provider && m === config.model.model ? " ←" : "";
        console.log(`    ${m}${mMarker}`);
      }
    }
    console.log(`\n  Usage: /model <model-name>  (e.g. /model deepseek-reasoner)`);
    return;
  }

  const target = args[0].toLowerCase();

  // Find which provider has this model
  for (const [provider, models] of Object.entries(KNOWN_MODELS)) {
    const match = models.find((m) => m.toLowerCase() === target);
    if (match) {
      const oldModel = config.model.model;
      const oldProvider = config.model.provider;
      config.model.provider = provider;
      config.model.model = match;
      console.log(`\n  Switched: ${oldProvider}/${oldModel} → ${provider}/${match}`);
      console.log(`  (takes effect on next message)`);
      return;
    }
  }

  // Check if it's a provider name
  if (KNOWN_MODELS[target]) {
    config.model.provider = target;
    config.model.model = KNOWN_MODELS[target][0];
    console.log(`\n  Switched to ${target}/${config.model.model}`);
    return;
  }

  // Not in known list — try to guess provider from model name prefix
  const providerHints: Record<string, string> = {
    deepseek: "deepseek", anthropic: "anthropic",
    claude: "anthropic", gpt: "openai", openai: "openai",
    llama: "groq", mixtral: "groq",
  };
  let guessedProvider = config.model.provider;
  for (const [hint, prov] of Object.entries(providerHints)) {
    if (target.includes(hint)) { guessedProvider = prov; break; }
  }

  config.model.provider = guessedProvider;
  config.model.model = args[0];
  console.log(`\n  Switched to ${guessedProvider}/${args[0]}`);
  console.log(`  (takes effect on next message)`);
}

// ---- Main ----

function createRepl(
  rl: readline.Interface,
  planManager: PlanManager,
  workdir: string,
  config: { model: { provider: string; model: string } },
  loopOptions?: { forceCompaction?: boolean }
): () => Promise<string | null> {
  return () => {
    return new Promise((resolve) => {
      rl.question("\n▸ You: ", (answer) => {
        const trimmed = answer.trim();
        if (trimmed === "/exit" || trimmed === "/quit") {
          resolve(null);
        } else if (trimmed === "/compact") {
          if (loopOptions) { loopOptions.forceCompaction = true; }
          console.log("\n  Compacting on next turn...");
          resolve(createRepl(rl, planManager, workdir, config, loopOptions)());
        } else if (trimmed === "/help") {
          console.log("\n  REPL Commands:");
          console.log("  /exit, /quit      — Exit the chat");
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
          console.log("  /help             — Show this help");
          console.log("  Ctrl+C            — Exit");
          resolve(createRepl(rl, planManager, workdir, config, loopOptions)());
        } else if (trimmed.startsWith("/plan")) {
          handlePlanCommand(trimmed, planManager);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions)());
        } else if (trimmed.startsWith("/grillme")) {
          handleGrillMeCommand(trimmed, planManager);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions)());
        } else if (trimmed.startsWith("/git")) {
          handleGitCommand(trimmed, workdir);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions)());
        } else if (trimmed.startsWith("/journal") || trimmed.startsWith("/remember")) {
          handleJournalCommand(trimmed, workdir);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions)());
        } else if (trimmed.startsWith("/memory")) {
          handleMemoryCommand(trimmed);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions)());
        } else if (trimmed.startsWith("/model")) {
          handleModelCommand(trimmed, config);
          resolve(createRepl(rl, planManager, workdir, config, loopOptions)());
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

async function main(): Promise<void> {
  const { prompt, workdir, model, provider, interactive } = parseArgs();

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

  if (interactive) {
    console.log(`Mode: interactive (type /exit to quit, /help for help)`);
  }

  // Setup REPL if interactive
  const rl = interactive
    ? readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    : null;

  // Show initial prompt in interactive mode
  const initialPrompt = prompt || "Hello! What would you like to work on?";
  renderer.renderUserMessage(initialPrompt);

  const loopOptions: { forceCompaction?: boolean } = {};

  try {
    for await (const event of agentLoop({
      config,
      workingDir: workdir,
      prompt: initialPrompt,
      renderer,
      getNextUserMessage: rl ? createRepl(rl, planManager, workdir, config, loopOptions) : undefined,
      forceCompaction: loopOptions.forceCompaction,
    })) {
      switch (event.type) {
        case "turn_start":
          // Silent progress
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
          // REPL prompt is handled by getNextUserMessage callback
          break;

        case "done":
          console.log(`\n[Session ended: ${event.reason}]`);
          break;

        case "turn_end":
          // Could show token usage here
          break;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    renderer.renderError(`Fatal: ${message}`);
    process.exit(1);
  } finally {
    if (rl) rl.close();
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
