import path from "path";
import fs from "fs";
import YAML from "yaml";
import type { AgentConfig, AgentContext } from "../shared/core-types.js";
import { handleFileMemoryCommand } from "./file-memory-commands.js";
import { getGitState } from "../tools/git/advisor.js";
import { getBranchHealth } from "../tools/git/branch-health.js";
import { getSkillRegistry } from "../skills/registry.js";
import { spawnSubagent } from "../agent/subagent.js";
import { PolicyEngine } from "../security/policy/engine.js";
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

export async function handleJournalCommand(
  input: string,
  workdir: string,
  config?: AgentConfig,
): Promise<void> {
  const args = input.split(/\s+/).slice(1);

  if (input.startsWith("/remember")) {
    const content = args.join(" ").trim();
    console.log(
      content
        ? "\n  /remember 需要作为当前会话的用户消息进入证据链。请直接发送：" +
          `\n  请记住：${content}`
        : "\n  用法：/remember <内容>；CLI 会把它转成可追溯的“请记住”用户消息。",
    );
    return;
  }

  if (args[0] === "search") {
    await handleFileMemoryCommand(
      `/memory search ${args.slice(1).join(" ")}`,
      workdir,
      config,
    );
    return;
  }

  if (args[0] === "stats") {
    await handleFileMemoryCommand("/memory stats", workdir, config);
    return;
  }

  // `recent` was advertised by tab completion but never handled. The file-memory
  // list is already ordered, so this is the honest equivalent of the old alias.
  await handleFileMemoryCommand("/memory list", workdir, config);
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
    mode: "default",
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
