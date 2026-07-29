import path from "path";
import fs from "fs";
import YAML from "yaml";
import type { AgentConfig, AgentContext } from "../shared/core-types.js";
import { getMnemosyneStore } from "../memory/store.js";
import { getGitState } from "../tools/git/advisor.js";
import { getBranchHealth } from "../tools/git/branch-health.js";
import { getSkillRegistry } from "../skills/registry.js";
import { spawnSubagent } from "../agent/subagent.js";
import { PolicyEngine } from "../permissions/policy.js";
import { PlanManager } from "../agent/planner/manager.js";
import { SessionManager } from "../runtime/session/manager.js";
import { processSubagentRegistry } from "../agent/subagents/registry.js";
import { scrubPersistedData } from "../security/scrub.js";

export async function handleGitCommand(input: string, workdir: string): Promise<void> {
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
    for (const branch of health.branches.slice(0, 5)) {
      const icon = branch.status === "healthy" ? "✅" : branch.status === "stale" ? "⏰" : "⚠️";
      console.log(`  ${icon} ${branch.branch} — ${branch.recommendation}`);
    }
    return;
  }

  console.log("\n  用法：/git、/git status、/git health");
}

export async function handleJournalCommand(input: string, workdir: string): Promise<void> {
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
    console.log("\n  📓 统一记忆图谱统计：");
    console.log(`  总实体：${stats.entities} | 关系：${stats.relations} | 手动知识：${stats.manualMemories}`);
    return;
  }

  console.log("\n  用法：/journal、/journal search <q>、/journal stats、/journal recent");
}

const MEMORY_TYPE_ICONS: Record<string, string> = {
  file: "📄", function: "🔧", class: "🏗️", concept: "💡", config: "⚙️",
  error: "🐛", deploy: "🚀", api: "🔌", dependency: "📦", test: "✅", note: "📝",
};

export async function handleMemoryCommand(input: string): Promise<void> {
  const args = input.split(/\s+/).slice(1);
  try {
    const store = getMnemosyneStore();
    const stats = store.getStats();

    if (args[0] === "stats" || args.length === 0) {
      console.log("\n  🧠 Mnemosyne 统一记忆图谱：");
      console.log(`  实体：${stats.entities} | 关系：${stats.relations} | 访问记录：${stats.accessLogs}`);
      console.log(`  手动知识：${stats.manualMemories} (protected)`);
      console.log("  存储路径：~/.rubato/mnemosyne/memory.db");
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
        if (entity.content) console.log(`    ${entity.content.slice(0, 120)}`);
      }
      return;
    }

    if (args[0] === "list") {
      const showAll = args[1] === "all";
      const recent = store.getRecentEntities(50);
      const filtered = showAll ? recent : recent.filter((entity) =>
        !entity.name.includes("/languages") && !entity.name.includes("/structure") &&
        entity.source !== "seeder" && entity.type !== "concept"
      );
      if (filtered.length === 0) {
        console.log("\n  📭 暂无对话中积累的记忆。用 /memory list all 查看全部（含自动扫描）。");
        return;
      }
      console.log(`\n  🧠 ${showAll ? "全部记忆" : "对话记忆（不含自动扫描）"}：`);
      for (const entity of filtered.slice(0, 20)) {
        const icon = MEMORY_TYPE_ICONS[entity.type] ?? "📝";
        const source = entity.source === "manual" ? " [手动]" : entity.source === "extractor" ? " [对话提取]" : entity.source === "seeder" ? " [自动扫描]" : "";
        console.log(`  ${icon} [${entity.type}] ${entity.name}${source}`);
        if (entity.content) console.log(`     ${entity.content.slice(0, 120)}`);
      }
      return;
    }
  } catch (error) {
    console.warn(`\n  记忆系统不可用：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  console.log("\n  用法：/memory、/memory stats、/memory search <q>、/memory list");
}

export function saveModelPreference(provider: string, model: string): void {
  const dir = path.join(process.env.HOME ?? "/tmp", ".rubato");
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, "config.yml");
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) existing = YAML.parse(fs.readFileSync(configPath, "utf-8")) ?? {};
  } catch (error) {
    console.warn(`Warning: unable to read existing model config; overwriting it: ${error instanceof Error ? error.message : String(error)}`);
  }
  existing.model = { ...(existing.model as Record<string, unknown> ?? {}), provider, model };
  fs.writeFileSync(configPath, YAML.stringify(existing), "utf-8");
}

export function handleModelCommand(input: string, config: { model: { provider: string; model: string } }): void {
  const args = input.split(/\s+/).slice(1);
  if (args.length === 0) {
    console.log(`\n  Current: ${config.model.provider}/${config.model.model}`);
    console.log("  Type /model <name> to switch  (e.g. /model deepseek-chat)");
    return;
  }

  const target = args[0];
  const targetLower = target.toLowerCase();
  let provider = config.model.provider;
  if (targetLower.includes("claude") || targetLower.includes("anthropic")) provider = "anthropic";
  else if (targetLower.includes("gpt") || targetLower.includes("openai")) provider = "openai";
  else if (targetLower.includes("deepseek")) provider = "deepseek";
  else if (targetLower.includes("llama") || targetLower.includes("mixtral")) provider = "groq";

  config.model.provider = provider;
  config.model.model = target;
  saveModelPreference(provider, target);
  console.log(`\n  Switched to ${provider}/${target}  (takes effect on next message)`);
}

export interface SessionsCommandResult { restartLoop: boolean; resumeId?: string; }

export function handleSessionsCommand(input: string, sessionManager: SessionManager): SessionsCommandResult {
  const args = input.split(/\s+/).slice(1);
  if (args.length === 0 || args[0] === "list") {
    const sessions = sessionManager.listSessions();
    if (sessions.length === 0) { console.log("\n  No sessions found for this project."); return { restartLoop: false }; }
    console.log("\n  ── Sessions ──");
    console.log("  #   | When                | Status  | Model         | First message");
    console.log("  ----|---------------------|---------|---------------|--------------");
    sessions.forEach((session, index) => {
      const when = new Date(session.createdAt).toLocaleString().slice(0, 19);
      const status = session.status === "active" ? "\x1b[32mactive\x1b[0m" : "\x1b[90mended\x1b[0m";
      const model = session.model.slice(0, 13).padEnd(13);
      const msg = (session.firstMessage ?? "").slice(0, 50);
      const tokenStr = session.tokenCount > 0 ? `\x1b[90m${Math.round(session.tokenCount / 1000)}k\x1b[0m` : "";
      console.log(`  ${String(index).padEnd(3)} | ${when} | ${status}   | ${model} | ${msg} ${tokenStr}`);
    });
    console.log("\n  /sessions resume <#> or <id-prefix> to resume");
    return { restartLoop: false };
  }

  if (args[0] === "resume") {
    const target = args[1];
    if (!target) { console.log("\n  Usage: /sessions resume <#> or /sessions resume <id-prefix>"); return { restartLoop: false }; }
    const sessions = sessionManager.listSessions();
    const index = Number.parseInt(target, 10);
    if (!Number.isNaN(index) && index >= 0 && index < sessions.length) return { restartLoop: true, resumeId: sessions[index].id };
    const matches = sessions.filter((session) => session.id.startsWith(target));
    if (matches.length === 1) return { restartLoop: true, resumeId: matches[0].id };
    if (matches.length > 1) {
      console.log("\n  Multiple sessions match. Be more specific:");
      matches.forEach((session) => console.log(`    ${session.id} — ${session.firstMessage?.slice(0, 60)}`));
      return { restartLoop: false };
    }
    console.log(`\n  No session found matching "${target}".`);
  }
  return { restartLoop: false };
}

export async function handleTasksCommand(input: string, rootSessionId: string): Promise<void> {
  const runtime = processSubagentRegistry.get(rootSessionId);
  if (!runtime) {
    console.log("\n  No subagent tasks in this session.");
    return;
  }
  const args = input.trim().split(/\s+/).slice(1);
  if (args.length === 0 || args[0] === "list") {
    const tasks = runtime.list();
    if (tasks.length === 0) {
      console.log("\n  No subagent tasks in this session.");
      return;
    }
    console.log("\n  Task ID                                Status       Type       Elapsed  Activity");
    for (const task of tasks) {
      const elapsed = (task.endedAt ?? Date.now()) - (task.startedAt ?? task.createdAt);
      console.log(
        `  ${task.taskId.padEnd(38)} ${task.status.padEnd(12)} ` +
        `${task.subagentType.padEnd(10)} ${formatTaskDuration(elapsed).padEnd(8)} ` +
        `${task.currentActivity ?? ""}` +
        `${task.workspace ? ` [${task.workspace.branch}]` : ""}`,
      );
    }
    return;
  }

  if (args[0] === "stats") {
    console.log(JSON.stringify(runtime.artifactStats(), null, 2));
    return;
  }
  if (args[0] === "prune") {
    console.log(JSON.stringify(runtime.pruneArtifacts(), null, 2));
    return;
  }
  if (args[0] === "watch") {
    const taskId = args[1];
    const targets = taskId
      ? [runtime.get(taskId)].filter((task): task is NonNullable<typeof task> => Boolean(task))
      : runtime.list().filter((task) =>
          task.status === "queued" || task.status === "running" || task.status === "waiting_child",
        );
    if (targets.length === 0) {
      console.log(taskId ? `\n  Unknown or terminal task: ${taskId}` : "\n  No running tasks.");
      return;
    }
    const targetIds = new Set(targets.map((task) => task.taskId));
    const unsubscribe = runtime.subscribe((task) => {
      if (targetIds.has(task.taskId)) {
        console.log(
          `  ${task.taskId} ${task.status} ${task.currentActivity ?? ""} ` +
          `${task.currentTool ?? ""}`,
        );
      }
    });
    try {
      await Promise.all(targets.map((task) => runtime.wait(task.taskId)));
    } finally {
      unsubscribe();
    }
    return;
  }
  const action = ["wait", "cancel", "cleanup", "pin", "unpin"].includes(args[0])
    ? args[0]
    : "get";
  const taskId = action === "get" ? args[0] : args[1];
  if (!taskId) {
    console.log("\n  Usage: /tasks [<id> | wait/watch/cancel/cleanup/pin/unpin <id> | stats | prune]");
    return;
  }
  try {
    if (action === "wait") {
      console.log(JSON.stringify(await runtime.wait(taskId), null, 2));
    } else if (action === "cancel") {
      await runtime.cancel(taskId, true);
      console.log(`\n  Cancellation requested for ${taskId}.`);
    } else if (action === "cleanup") {
      await runtime.cleanup(taskId);
      console.log(`\n  Cleaned ${taskId}.`);
    } else if (action === "pin" || action === "unpin") {
      runtime.pin(taskId, action === "pin");
      console.log(`\n  ${action === "pin" ? "Pinned" : "Unpinned"} ${taskId}.`);
    } else {
      const task = runtime.get(taskId);
      console.log(task ? JSON.stringify(task, null, 2) : `\n  Unknown task: ${taskId}`);
    }
  } catch (error) {
    console.log(`\n  ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function handleTraceCommand(input: string, rootSessionId: string): void {
  const runtime = processSubagentRegistry.get(rootSessionId);
  if (!runtime) {
    console.log("\n  No trace exists for this session.");
    return;
  }
  const taskId = input.trim().split(/\s+/)[1];
  if (!taskId) {
    console.log(`\n  Trace: ${runtime.artifacts.tracePath}`);
    return;
  }
  const task = runtime.get(taskId);
  console.log(task
    ? `\n  Task transcript: ${task.artifacts.transcript}\n  Root trace: ${runtime.artifacts.tracePath}`
    : `\n  Unknown task: ${taskId}`);
}

export function handleScrubCommand(input: string): void {
  let remainder = input.replace(/^\/scrub\b/, "").trim();
  const dryRun = /(?:^|\s)--dry-run(?:\s|$)/.test(remainder);
  remainder = remainder.replace(/(?:^|\s)--dry-run(?=\s|$)/g, " ").trim();
  let target = remainder || undefined;
  if (
    target &&
    ((target.startsWith("\"") && target.endsWith("\"")) ||
      (target.startsWith("'") && target.endsWith("'")))
  ) {
    target = target.slice(1, -1);
  }
  if (target) target = target.replace(/\\ /g, " ");

  try {
    const report = scrubPersistedData({ target, dryRun });
    const action = dryRun ? "would redact" : "redacted";
    console.log(
      `\n  Security scrub ${action} ${report.filesChanged} of ` +
      `${report.filesScanned} eligible files (${report.bytesScanned} bytes scanned).`,
    );
    if (report.skippedSymlinks > 0) {
      console.log(`  Skipped ${report.skippedSymlinks} symbolic link(s).`);
    }
    if (report.errors.length > 0) {
      console.log(`  ${report.errors.length} file(s) could not be scrubbed; no secret values were printed.`);
    }
  } catch (error) {
    console.log(`\n  Security scrub failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatTaskDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export async function handleSkillCommand(input: string, workdir: string, config: AgentConfig): Promise<string | null> {
  const parts = input.split(/\s+/);
  const cmdName = parts[0].slice(1);
  const args = parts.slice(1).join(" ");
  const skill = getSkillRegistry().getSkill(cmdName);
  if (!skill) { console.log(`\n  Unknown skill: /${cmdName}`); return null; }
  if ((skill.context ?? "inline") === "inline") {
    if (args) console.log(`\n  📋 Skill "${skill.name}" — passing to model...`);
    return args || skill.name;
  }

  console.log(`\n  🔧 Running skill "${skill.name}"...`);
  const subagentDef = {
    name: skill.name,
    description: skill.description ?? `Run the "${skill.name}" skill`,
    systemPrompt: skill.systemPrompt ?? `You are the "${skill.name}" skill. ${skill.description ?? ""}`,
    tools: skill.tools ?? ["Read", "Grep", "Glob", "Bash"],
    model: skill.model ?? "inherit",
    readonly: true,
    maxTurns: skill.maxTurns ?? 15,
  };
  const permissions = { ...config.permissions };
  if (skill.allowedTools?.length) {
    permissions.rules = [
      ...(permissions.rules ?? []),
      ...skill.allowedTools.map((pattern) => ({ tool: "*" as const, pattern, action: "allow" as const, reason: `Skill "${skill.name}" pre-authorization` })),
    ];
  }
  const minimalCtx: AgentContext = {
    workingDir: workdir,
    sessionId: `skill-${cmdName}-${Date.now()}`,
    readGuard: { hasRead: () => false, markAsRead: () => {}, serialize: () => ({ files: {} }) },
    permissionManager: new PolicyEngine(permissions),
    config: { ...config, permissions },
    depth: 0,
  };
  try {
    const result = await spawnSubagent(subagentDef, args || `Run the "${skill.name}" skill`, minimalCtx, { ...config, permissions });
    console.log(`\n  ── ${skill.name} output ──`);
    console.log(result.output || "(no output)");
    if (result.usage.toolCalls > 0) console.log(`  [${result.status}] ${result.usage.inputTokens} in / ${result.usage.outputTokens} out / ${result.usage.toolCalls} tools`);
  } catch (error) {
    console.warn(`\n  ✖ Skill "${skill.name}" failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

export function handlePlanCommand(input: string, pm: PlanManager): void {
  const args = input.split(/\s+/).slice(1);
  if (args.length === 0 || args[0] === "show") { console.log("\n" + pm.showPlan()); return; }
  if (args[0] === "list") {
    const plans = pm.listPlans();
    console.log(plans.length ? `\n  已保存的计划：\n${plans.map((plan) => `    - ${plan}`).join("\n")}` : "\n  没有保存的计划。");
    return;
  }
  if (args[0] === "new") {
    const desc = args.slice(1).join(" ");
    if (!desc) { console.log("\n  用法：/plan new <任务描述>"); return; }
    pm.startRequirementsGathering(desc);
    console.log(`\n  🔍 需求澄清模式：对「${desc}」开始收集信息。`);
    return;
  }
  if (args[0] === "done") {
    const plan = pm.getActivePlan();
    if (!plan) { console.log("\n  没有活跃计划。"); return; }
    plan.status = "done";
    pm.savePlan();
    console.log(`\n  ✅ 计划「${plan.title}」已标记为完成。`);
    return;
  }
  console.log("\n  未知的 plan 子命令。试试 /plan、/plan new、/plan list、/plan done");
}

export function handleGrillMeCommand(input: string, pm: PlanManager): void {
  const arg = input.split(/\s+/)[1];
  if (!arg || arg === "status") {
    const config = pm.getGrillMeConfig();
    console.log(`\n  Grill Me: ${config.enabled ? "🟢 ON" : "🔴 OFF"} | 灵敏度: ${config.sensitivity}`);
  } else if (arg === "on") { pm.setGrillMeSensitivity("normal"); console.log("\n  🟢 Grill Me 已开启（灵敏度：normal）");
  } else if (arg === "off") { pm.toggleGrillMe(); console.log("\n  🔴 Grill Me 已关闭");
  } else if (["strict", "normal", "loose"].includes(arg)) { pm.setGrillMeSensitivity(arg as "strict" | "normal" | "loose"); console.log(`\n  Grill Me 灵敏度已设为：${arg}`);
  } else console.log("\n  用法：/grillme on|off|strict|normal|loose|status");
}
