import path from "path";
import type { AgentConfig } from "../shared/core-types.js";
import { createProvider } from "../model/router.js";
import {
  auditProjectFacts,
  bootstrapProjectMemory,
  looksLikeProject,
} from "../memory-files/bootstrap.js";
import {
  appendMemoryControlEvent,
  listMemoryControlEvents,
  type MemoryControlEvent,
} from "../memory-files/control-events.js";
import {
  listDreamRuns,
  queueDream,
  type DreamRun,
} from "../memory-files/dream.js";
import {
  pendingDreamSummary,
  runQueuedDreams,
} from "../memory-files/dream-runner.js";
import { memoryUtilityScores } from "../memory-files/outcome.js";
import {
  findMemorySafetyIssues,
  loadMemoryPolicy,
  setMemoryLearningEnabled,
} from "../memory-files/policy.js";
import {
  hardPurgeMemories,
  previewHardPurge,
  type HardPurgeOptions,
  type HardPurgePlan,
} from "../memory-files/hard-purge.js";
import {
  publishMemoryRelease,
  readCurrentRelease,
  readMemoryRelease,
  rollbackMemoryRelease,
  searchCurrentCatalog,
} from "../memory-files/release.js";
import {
  FileMemoryRepository,
} from "../memory-files/repository.js";
import type {
  CatalogEntry,
  MemoryCard,
  MemoryReleaseSnapshot,
  MemoryScopePaths,
} from "../memory-files/types.js";
import type { UserObservation } from "../memory-files/observation.js";

interface LoadedScope {
  label: "global" | "project";
  paths: MemoryScopePaths;
  snapshot: MemoryReleaseSnapshot | null;
  error?: string;
}

type CardSelection =
  | { ok: true; scope: LoadedScope; cards: MemoryCard[] }
  | { ok: false; message: string };

/**
 * User-facing controls for the compiled profile. Mutations call the same
 * immutable-release/CAS APIs as the deterministic reducer; this module never
 * edits CURRENT, releases, cards, or purge artifacts directly.
 */
export async function handleProfileCommand(
  input: string,
  workdir: string,
  config?: AgentConfig,
): Promise<void> {
  const args = commandArgs(input);
  const action = args[0] ?? "show";
  const repository = new FileMemoryRepository({ projectDir: workdir });

  if (action === "pause-learning") {
    updateLearningState(false, repository, workdir, config);
    return;
  }

  if (action === "resume-learning") {
    updateLearningState(true, repository, workdir, config);
    return;
  }

  if (action === "correct") {
    correctProfile(args, repository, workdir);
    return;
  }

  if (action === "forget") {
    await forgetProfile(args, repository, workdir);
    return;
  }

  if (action === "retire" || action === "undo") {
    console.log(`\n  请使用 /memory ${action}${action === "retire" ? " <id-or-key>" : " [release-id]"}。`);
    return;
  }

  const scopes = loadScopes(repository);

  if (action === "show") {
    printProfile(scopes);
    return;
  }

  if (action === "why") {
    const logicalKey = args.slice(1).join(" ").trim();
    if (!logicalKey) {
      console.log("\n  用法：/profile why <logical-key>");
      return;
    }
    let controlEvents: MemoryControlEvent[] = [];
    let controlError: string | undefined;
    try {
      controlEvents = listMemoryControlEvents(repository.globalPaths.rootDir);
    } catch (error) {
      controlError = error instanceof Error ? error.message : String(error);
    }
    printWhy(
      logicalKey,
      scopes,
      repository.listObservations(),
      controlEvents,
      controlError,
    );
    return;
  }

  if (action === "export") {
    exportProfile(args.slice(1), workdir, repository, scopes);
    return;
  }

  printProfileUsage();
}

/**
 * Grep-first file-memory inspection, bootstrap, and Dream commands.
 *
 * `/memory dream` still only queues. Draining the queue spends model calls, so
 * it requires the explicit `--run` flag (or the background pass at startup) and
 * a config to build a provider from.
 */
export async function handleFileMemoryCommand(
  input: string,
  workdir: string,
  config?: AgentConfig,
): Promise<void> {
  const args = commandArgs(input);
  const action = args[0] ?? "stats";
  const repository = new FileMemoryRepository({ projectDir: workdir });

  if (action === "retire") {
    retireMemory(args, repository, workdir);
    return;
  }

  if (action === "undo") {
    undoMemory(args, repository, workdir);
    return;
  }

  if (action === "correct" || action === "forget") {
    console.log(
      `\n  请使用 /profile ${action} <logical-key>` +
      `${action === "correct" ? " <value>" : " [--dry-run]"}。`,
    );
    return;
  }


  if (action === "dream") {
    queueManualDreams(repository);
    if (args.includes("--run") || args[1] === "run") {
      await drainDreamQueue(workdir, config);
    }
    return;
  }

  if (action === "bootstrap") {
    await runBootstrapCommand(args, workdir, config);
    return;
  }

  const scopes = loadScopes(repository);

  if (action === "stats") {
    printStats(scopes, repository, config);
    return;
  }

  if (action === "search") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      console.log("\n  用法：/memory search <关键词>");
      return;
    }
    printSearch(query, scopes, config);
    return;
  }

  if (action === "list") {
    printMemoryList(scopes);
    return;
  }

  printMemoryUsage();
}

function commandArgs(input: string): string[] {
  return input.trim().split(/\s+/).slice(1);
}

function loadScopes(repository: FileMemoryRepository): LoadedScope[] {
  return [
    loadScope("global", repository.globalPaths),
    loadScope("project", repository.projectPaths),
  ];
}

function loadScope(
  label: LoadedScope["label"],
  paths: MemoryScopePaths,
): LoadedScope {
  try {
    return {
      label,
      paths,
      snapshot: readCurrentRelease(paths),
    };
  } catch (error) {
    return {
      label,
      paths,
      snapshot: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function correctProfile(
  args: string[],
  repository: FileMemoryRepository,
  workdir: string,
): void {
  const logicalKey = args[1]?.trim() ?? "";
  const value = args.slice(2).join(" ").trim();
  if (!logicalKey || !value) {
    console.log("\n  用法：/profile correct <logical-key> <new-value>");
    return;
  }
  const safetyIssues = findMemorySafetyIssues(value);
  if (safetyIssues.length > 0) {
    console.log(
      `\n  修正被安全策略拒绝：${safetyIssues.join(", ")}。` +
      "认证信息、密钥和工具执行指令不能写入记忆。",
    );
    return;
  }

  const scopes = loadScopes(repository);
  const selected = selectExactCards(scopes, logicalKey);
  if (!selected.ok) {
    console.log(`\n  ${selected.message}`);
    return;
  }
  const { scope, cards } = selected;
  if (cards.every((card) => normalizeValue(card.body) === normalizeValue(value))) {
    console.log(`\n  ${logicalKey} 已经是该值；没有创建新 release。`);
    return;
  }

  const base = [...cards].sort((left, right) => left.id.localeCompare(right.id))[0];
  const now = new Date().toISOString();
  let controlEvent: ReturnType<typeof appendMemoryControlEvent>;
  try {
    controlEvent = appendMemoryControlEvent({
      action: "correct",
      workingDir: workdir,
      rootDir: scope.paths.rootDir,
      target: logicalKey,
      value,
      occurredAt: now,
    });
  } catch (error) {
    printMutationError("无法记录可验证的用户控制事件，未执行修正", error);
    return;
  }
  const correctionId = `correction_${controlEvent.hash.slice(0, 24)}`;
  const correctionWeight = 12;
  const corrected: MemoryCard = {
    ...base,
    id: correctionId,
    revision: 1,
    logicalKey: base.logicalKey,
    status: "confirmed",
    origin: "explicit",
    application: "automatic",
    authority: "user_explicit",
    confidence: (1 + correctionWeight) / (2 + correctionWeight),
    supportScore: correctionWeight,
    oppositionScore: 0,
    body: value,
    aliases: [...new Set([...base.aliases, value.slice(0, 80)])],
    createdAt: now,
    updatedAt: now,
    firstSeenAt: now,
    lastSeenAt: now,
    lastConfirmedAt: now,
    // A correction is fresh confirmation, so the review clock restarts from now
    // rather than being dropped.
    reviewAfter: base.halfLifeDays === null
      ? undefined
      : new Date(Date.parse(now) + base.halfLifeDays * 86_400_000).toISOString(),
    evidence: [{
      sessionId: `control:${controlEvent.project_id}`,
      eventSeq: controlEvent.seq,
      eventHash: controlEvent.hash,
      actor: "user",
      signal: "correction",
      excerpt: "Explicit profile correction control event.",
    }],
    supersedes: cards.map((card) => `${card.id}@${card.revision}`),
    conflicts: [],
  };

  try {
    const release = publishMemoryRelease(scope.paths, {
      baseReleaseId: scope.snapshot!.id,
      changes: [{
        type: "supersede",
        ...(cards.length === 1
          ? { expectedRevision: cards[0].revision }
          : {}),
        card: corrected,
      }],
      reason: `Explicit CLI correction for ${logicalKey}`,
    });
    console.log(
      `\n  ✅ 已修正 ${logicalKey}，发布 verified release ${release.id}。` +
      `旧值保留在不可变历史中；若要隐私清除，请使用 /profile forget ${logicalKey}。`,
    );
  } catch (error) {
    printMutationError("修正失败", error);
  }
}

async function forgetProfile(
  args: string[],
  repository: FileMemoryRepository,
  workdir: string,
): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const unsupported = args.slice(1).filter((item) =>
    item.startsWith("--") && item !== "--dry-run");
  const keys = args.slice(1).filter((item) => !item.startsWith("--"));
  if (keys.length !== 1 || unsupported.length > 0) {
    console.log("\n  用法：/profile forget <logical-key> [--dry-run]");
    return;
  }

  const logicalKey = keys[0];
  await runHardPurgeAdapter({
    repository,
    workdir,
    logicalKey,
    dryRun,
  });
}

function exportProfile(
  args: string[],
  workdir: string,
  repository: FileMemoryRepository,
  scopes: LoadedScope[],
): void {
  const includeSecrets = args.includes("--include-secret");
  if (args.some((item) => item !== "--include-secret")) {
    console.log("\n  用法：/profile export [--include-secret]");
    return;
  }
  const policy = loadMemoryPolicy();
  const secretIds = new Set<string>();
  const secretKeys = new Set<string>();
  const exportableKeys = new Set<string>();
  for (const scope of scopes) {
    for (const card of scope.snapshot?.cards ?? []) {
      if (card.sensitivity === "secret") {
        secretIds.add(card.id);
        secretKeys.add(card.logicalKey);
      } else {
        exportableKeys.add(card.logicalKey);
      }
    }
  }
  const allObservations = repository.listObservations();
  const observations = allObservations.filter((observation) =>
    includeSecrets || (
      exportableKeys.has(observation.logicalKey) &&
      !secretKeys.has(observation.logicalKey) &&
      findMemorySafetyIssues(observation.value).length === 0
    ));
  const payload = {
    schema: "rubato.memory.profile-export/v1",
    exported_at: new Date().toISOString(),
    project: {
      workdir: path.resolve(workdir),
      project_id: repository.projectId,
    },
    learning_enabled: policy.learning_enabled,
    includes_secret: includeSecrets,
    omitted_secret_cards: includeSecrets ? 0 : secretIds.size,
    omitted_unclassified_or_secret_observations:
      includeSecrets ? 0 : allObservations.length - observations.length,
    scopes: scopes.map((scope) => {
      const cards = (scope.snapshot?.cards ?? [])
        .filter((card) => includeSecrets || card.sensitivity !== "secret");
      return {
        scope: scope.label,
        release_id: scope.snapshot?.id ?? null,
        verification_error: scope.error,
        release: scope.snapshot
          ? {
              parent_release_id: scope.snapshot.manifest.parentReleaseId,
              scope: scope.snapshot.manifest.scope,
              project_id: scope.snapshot.manifest.projectId,
              created_at: scope.snapshot.manifest.createdAt,
              purge_epoch: scope.snapshot.manifest.purgeEpoch,
              change_summary: includeSecrets
                ? scope.snapshot.manifest.changes
                : summarizeChangeTypes(scope.snapshot.manifest.changes),
            }
          : null,
        profile: scope.snapshot?.profile ?? null,
        cards,
      };
    }),
    observations,
  };
  console.log(JSON.stringify(payload, null, 2));
}

function retireMemory(
  args: string[],
  repository: FileMemoryRepository,
  workdir: string,
): void {
  const target = args[1]?.trim() ?? "";
  if (!target || args.length !== 2) {
    console.log("\n  用法：/memory retire <id-or-logical-key>");
    return;
  }
  const scopes = loadScopes(repository);
  const selected = selectExactCards(scopes, target, true);
  if (!selected.ok) {
    console.log(`\n  ${selected.message}`);
    return;
  }
  const { scope } = selected;
  const logicalKeys = [...new Set(selected.cards.map((card) => card.logicalKey))];
  if (logicalKeys.length !== 1) {
    console.log(
      `\n  ${target} 同时匹配多个 logical key；请使用明确的 logical key 重试。`,
    );
    return;
  }
  const cards = scope.snapshot!.cards.filter((card) =>
    card.logicalKey === logicalKeys[0]);

  try {
    appendMemoryControlEvent({
      action: "retire",
      workingDir: workdir,
      rootDir: scope.paths.rootDir,
      target,
    });
  } catch (error) {
    printMutationError("无法记录可验证的用户控制事件，未执行停用", error);
    return;
  }

  try {
    const release = publishMemoryRelease(scope.paths, {
      baseReleaseId: scope.snapshot!.id,
      changes: [{
        type: "retire",
        logicalKey: logicalKeys[0],
        ...(cards.length === 1
          ? { expectedRevision: cards[0].revision }
          : {}),
      }],
      reason: `Explicit CLI retirement for ${logicalKeys[0]}`,
    });
    console.log(
      `\n  ✅ 已停用 ${logicalKeys[0]}，发布 verified release ${release.id}。` +
      "这是可回滚的生命周期操作，不是隐私删除；彻底清除请使用 /profile forget。",
    );
  } catch (error) {
    printMutationError("停用失败", error);
  }
}

function undoMemory(
  args: string[],
  repository: FileMemoryRepository,
  workdir: string,
): void {
  if (args.length > 2) {
    console.log("\n  用法：/memory undo [target-release-id]");
    return;
  }
  const explicitTarget = args[1]?.trim();
  const scopes = loadScopes(repository);
  const invalid = scopes.filter((scope) => scope.error);
  if (invalid.length > 0) {
    console.log(
      "\n  至少一个 CURRENT release 无法验证，已拒绝回滚：" +
      invalid.map((scope) => `${scopeLabel(scope)} (${scope.error})`).join("; "),
    );
    return;
  }

  let selectedScope: LoadedScope | undefined;
  let targetReleaseId: string | undefined;
  if (explicitTarget) {
    const matches: LoadedScope[] = [];
    for (const scope of scopes) {
      if (!scope.snapshot) continue;
      try {
        readMemoryRelease(scope.paths, explicitTarget);
        matches.push(scope);
      } catch {
        // A release id belongs to exactly one scope in normal operation.
      }
    }
    if (matches.length === 0) {
      console.log(`\n  找不到通过验证的目标 release：${explicitTarget}。`);
      return;
    }
    if (matches.length > 1) {
      console.log(
        `\n  release ${explicitTarget} 在多个 scope 中存在，无法安全判断；请检查 release ID。`,
      );
      return;
    }
    selectedScope = matches[0];
    targetReleaseId = explicitTarget;
    if (selectedScope.snapshot!.id === targetReleaseId) {
      console.log(`\n  ${targetReleaseId} 已经是当前 release；没有执行回滚。`);
      return;
    }
  } else {
    const candidates = scopes.filter((scope) =>
      scope.snapshot?.manifest.parentReleaseId);
    if (candidates.length === 0) {
      console.log("\n  当前没有可撤销的 release。");
      return;
    }
    candidates.sort((left, right) =>
      right.snapshot!.manifest.createdAt.localeCompare(
        left.snapshot!.manifest.createdAt,
      ));
    if (
      candidates.length > 1 &&
      candidates[0].snapshot!.manifest.createdAt ===
        candidates[1].snapshot!.manifest.createdAt
    ) {
      console.log(
        "\n  global/project 的最新 release 时间相同，无法安全判断要撤销哪一个；" +
        "请使用 /memory undo <target-release-id>。",
      );
      return;
    }
    selectedScope = candidates[0];
    targetReleaseId = selectedScope.snapshot!.manifest.parentReleaseId!;
  }

  try {
    appendMemoryControlEvent({
      action: "undo",
      workingDir: workdir,
      rootDir: selectedScope.paths.rootDir,
      target: targetReleaseId,
    });
    const release = rollbackMemoryRelease(selectedScope.paths, {
      baseReleaseId: selectedScope.snapshot!.id,
      targetReleaseId,
      reason: `Explicit CLI undo to ${targetReleaseId}`,
    });
    console.log(
      `\n  ↩️ 已将 ${scopeLabel(selectedScope)} 回滚到 ${targetReleaseId}，` +
      `新 current release 为 ${release.id}。隐私 purge ledger 不会被回滚。`,
    );
  } catch (error) {
    printMutationError("回滚失败", error);
  }
}

function updateLearningState(
  enabled: boolean,
  repository: FileMemoryRepository,
  workdir: string,
  config?: AgentConfig,
): void {
  try {
    appendMemoryControlEvent({
      action: enabled ? "resume_learning" : "pause_learning",
      workingDir: workdir,
      rootDir: repository.globalPaths.rootDir,
    });
    setMemoryLearningEnabled(enabled);
    console.log(enabled
      ? "\n  ▶️ 记忆学习已恢复；后续观察仍需经过候选、验证和 release 发布。"
      : "\n  ⏸️ 记忆学习已暂停。已有 verified release 仍可读取，但不会继续排队新的学习结果。");
    // Learning requires both switches. Resuming only POLICY.yml while config
    // still disables it would silently do nothing, so say so.
    if (enabled && config?.memory?.learningEnabled === false) {
      console.log(
        "  ⚠️ 配置里 memory.learningEnabled 仍为 false，学习不会真正恢复。" +
        "请同时修改 .rubato.yml 或 ~/.rubato/config.yml。",
      );
    }
    if (enabled && config?.memory?.enabled === false) {
      console.log(
        "  ⚠️ 配置里 memory.enabled 仍为 false，文件记忆整体处于关闭状态。",
      );
    }
  } catch (error) {
    printMutationError(
      enabled ? "恢复学习失败" : "暂停学习失败",
      error,
    );
  }
}

interface HardPurgeAdapterInput {
  repository: FileMemoryRepository;
  workdir: string;
  logicalKey: string;
  dryRun: boolean;
}

async function runHardPurgeAdapter(
  input: HardPurgeAdapterInput,
): Promise<void> {
  const scopes = loadScopes(input.repository);
  const invalid = scopes.filter((scope) => scope.error);
  if (invalid.length > 0) {
    console.log(
      "\n  至少一个 CURRENT release 无法验证，拒绝在不完整状态下执行隐私清除：" +
      invalid.map((scope) => `${scopeLabel(scope)} (${scope.error})`).join("; "),
    );
    return;
  }

  const planned: Array<{
    scope: LoadedScope;
    options: HardPurgeOptions;
    plan: HardPurgePlan;
  }> = [];
  try {
    for (const scope of scopes) {
      const cards = (scope.snapshot?.cards ?? []).filter((card) =>
        card.logicalKey.toLocaleLowerCase() ===
          input.logicalKey.toLocaleLowerCase());
      const observations = input.repository
        .listObservations(scope.label)
        .filter((observation) =>
          observation.logicalKey.toLocaleLowerCase() ===
            input.logicalKey.toLocaleLowerCase());
      const values = [...new Set([
        ...cards.map((card) => card.body.trim()),
        ...observations.map((observation) => observation.value.trim()),
      ].filter((value) => value.length >= 4))];
      const options: HardPurgeOptions = {
        memoryRoot: scope.paths.rootDir,
        workdir: input.workdir,
        scope: scope.label,
        intent: "forget",
        targets: {
          ids: cards.map((card) => card.id),
          logicalKeys: [input.logicalKey],
          values,
        },
        baseReleaseId: scope.snapshot?.id ?? null,
      };
      const plan = previewHardPurge(options);
      if (hardPurgePlanHasMatches(plan)) {
        planned.push({ scope, options, plan });
      }
    }
  } catch (error) {
    printMutationError("无法生成 hard-purge 计划；未修改任何文件", error);
    return;
  }

  if (planned.length === 0) {
    console.log(
      `\n  没有找到与 ${input.logicalKey} 匹配的 release、observation、` +
      "candidate、Dream 或派生产物；未写入 purge ledger。",
    );
    return;
  }

  if (input.dryRun) {
    const lines = [
      "",
      `  🧹 Hard-purge dry run：${input.logicalKey}`,
      "  仅预览；没有写 control event、purge ledger、release 或删除任何文件。",
    ];
    for (const item of planned) {
      lines.push(
        "",
        `  ── ${scopeLabel(item.scope)}; base=${item.plan.baseReleaseId ?? "(none)"} ──`,
      );
      for (const location of item.plan.locations) {
        lines.push(
          `  - ${location.category}/${location.action}; ` +
          `matches=${location.matchCount}; path=${location.path}`,
        );
      }
      for (const residual of item.plan.residuals) {
        lines.push(`  ⚠️ residual=${residual.reason}; path=${residual.path}`);
      }
      lines.push(
        `  fingerprints: ids=${item.plan.fingerprints.ids.length}, ` +
        `keys=${item.plan.fingerprints.logicalKeys.length}, ` +
        `values=${item.plan.fingerprints.values.length}`,
      );
    }
    console.log(lines.join("\n"));
    return;
  }

  try {
    appendMemoryControlEvent({
      action: "forget",
      workingDir: input.workdir,
      rootDir: input.repository.globalPaths.rootDir,
      target: input.logicalKey,
    });
  } catch (error) {
    printMutationError(
      "无法记录可验证的用户控制事件，未执行 hard purge",
      error,
    );
    return;
  }

  const lines = [
    "",
    `  🧹 正在彻底清除 ${input.logicalKey}：`,
  ];
  let failures = 0;
  for (const item of planned) {
    try {
      const result = hardPurgeMemories(item.options);
      lines.push(
        `  - ${scopeLabel(item.scope)} → release=${result.releaseId}; ` +
        `removed=${result.removedPaths.length}; ` +
        `rewritten=${result.rewrittenPaths.length}; ` +
        `post_scan_matches=${result.postScanMatches.length}; ` +
        `complete=${result.complete}`,
      );
      for (const residual of result.residuals) {
        lines.push(`    ⚠️ residual=${residual.reason}; path=${residual.path}`);
      }
    } catch (error) {
      failures++;
      lines.push(
        `  - ${scopeLabel(item.scope)} 清除失败：` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  lines.push(
    failures === 0
      ? "  完成：命中明文已物理清理，并写入不可回滚 purge ledger。"
      : "  警告：部分 scope 清除失败；成功 scope 不会自动回滚，请根据上面的错误重试。",
  );
  console.log(lines.join("\n"));
}

function hardPurgePlanHasMatches(plan: HardPurgePlan): boolean {
  return plan.locations.some((location) =>
    location.category !== "current_release" && location.matchCount > 0);
}

function printProfile(scopes: LoadedScope[]): void {
  const policy = loadMemoryPolicy();
  const lines = [
    "",
    "  🧠 当前用户画像（仅来自通过哈希验证的 CURRENT release）",
    `  学习状态：${policy.learning_enabled ? "运行中" : "已暂停"}`,
  ];
  let found = false;

  for (const scope of scopes) {
    if (scope.error) {
      lines.push(
        "",
        `  ⚠️ ${scopeLabel(scope)} release 无法验证，因此未读取：${scope.error}`,
      );
      continue;
    }
    if (!scope.snapshot) continue;
    found = true;
    lines.push(
      "",
      `  ── ${scopeLabel(scope)} @ ${scope.snapshot.id} ──`,
      indentBlock(scope.snapshot.profile.trimEnd(), "  "),
    );
  }

  if (!found) {
    lines.push(
      "",
      "  暂无已发布且通过验证的用户画像。原始 observation 不会被当作已确认偏好直接应用。",
    );
  }
  console.log(lines.join("\n"));
}

function printWhy(
  query: string,
  scopes: LoadedScope[],
  observations: UserObservation[],
  controlEvents: MemoryControlEvent[],
  controlError?: string,
): void {
  const normalized = query.toLocaleLowerCase();
  const matches = scopes.flatMap((scope) =>
    (scope.snapshot?.cards ?? [])
      .filter((card) => cardMatches(card, normalized))
      .map((card) => ({ scope, card })));
  const observationMatches = observations.filter((observation) =>
    observation.logicalKey.toLocaleLowerCase().includes(normalized));
  const lines = [
    "",
    `  🔎 为什么记住「${query}」`,
    "  下面区分 verified card 与尚未发布的原始 observation；后者只是证据。",
  ];

  for (const scope of scopes) {
    if (scope.error) {
      lines.push(
        "",
        `  ⚠️ ${scopeLabel(scope)} release 未通过验证，已排除：${scope.error}`,
      );
    }
  }
  if (controlError) {
    lines.push(
      "",
      `  ⚠️ memory control event chain 无法验证：${controlError}`,
    );
  }

  for (const { scope, card } of matches) {
    const userEvidence = card.evidence.filter((item) => item.actor === "user");
    lines.push(
      "",
      `  [verified card] ${card.logicalKey} — ${card.title}`,
      `    release=${scope.snapshot!.id}; card=${card.id}@${card.revision}`,
      `    scope=${card.scope}; status=${card.status}; application=${card.application}`,
      `    authority=${card.authority}; confidence=${card.confidence.toFixed(3)}`,
      `    support=${card.supportScore}; opposition=${card.oppositionScore}`,
      `    contexts=${formatContexts(card)}`,
      `    value=${oneLine(card.body, 300) || "(empty)"}`,
    );
    if (userEvidence.length === 0) {
      lines.push("    user_evidence=(none recorded)");
    } else {
      lines.push("    user_evidence:");
      for (const evidence of userEvidence) {
        const controlStatus = controlEvidenceStatus(evidence, controlEvents);
        lines.push(
          `      - session=${evidence.sessionId}; event_seq=${evidence.eventSeq}; ` +
          `event_hash=${shortHash(evidence.eventHash)}; actor=${evidence.actor}; ` +
          `signal=${evidence.signal}` +
          (controlStatus ? `; control_chain=${controlStatus}` : "") +
          (evidence.excerpt ? `; excerpt=${oneLine(evidence.excerpt, 160)}` : ""),
        );
      }
      const ignored = card.evidence.length - userEvidence.length;
      if (ignored > 0) {
        lines.push(`    ignored_non_user_evidence=${ignored}`);
      }
    }
  }

  for (const observation of observationMatches) {
    lines.push(
      "",
      `  [raw observation] ${observation.logicalKey}`,
      `    value=${oneLine(observation.value, 300)}; polarity=${observation.polarity}; signal=${observation.signal}`,
      `    scope=${formatObservationScope(observation)}; actor=${observation.actor}`,
      `    session=${observation.sessionId}; event_id=${observation.eventId ?? "(none)"}; ` +
      `event_seq=${observation.eventSeq ?? "(none)"}; ` +
      `event_hash=${shortHash(observation.eventHash)}`,
    );
  }

  if (matches.length === 0 && observationMatches.length === 0) {
    lines.push("", "  没有找到对应的 verified card 或原始 observation。");
  } else if (matches.length === 0) {
    lines.push(
      "",
      "  结论：目前只有 observation，还没有进入 verified release，不能当作已生效画像。",
    );
  }
  console.log(lines.join("\n"));
}

function printStats(
  scopes: LoadedScope[],
  repository: FileMemoryRepository,
  config?: AgentConfig,
): void {
  const policy = loadMemoryPolicy();
  const observations = repository.listObservations();
  const candidates = repository.listCandidates();
  const dreams = [
    ...listDreamRuns(repository.dreamsDir("global")),
    ...listDreamRuns(repository.dreamsDir("project")),
  ];
  const cards = scopes.flatMap((scope) => scope.snapshot?.cards ?? []);
  const repositoryCards = cards.filter((card) => card.authority === "repository");
  const utility = memoryUtilityRanking(config);
  const lines = [
    "",
    "  🧠 文件记忆统计",
    `  学习：${policy.learning_enabled ? "运行中" : "已暂停"}`,
    `  verified cards：${cards.length}（其中项目事实 ${repositoryCards.length}）` +
    ` | observations：${observations.length} | candidates：${candidates.length} | dreams：${dreams.length}`,
    `  card 状态：${formatCountMap(cards.map((card) => card.status))}`,
    `  candidate 状态：${formatCountMap(candidates.map((candidate) => candidate.state))}`,
    `  dream 状态：${formatCountMap(dreams.map((dream) => dream.status))}`,
    `  Dream 队列：${
      dreams.filter((dream) => dream.status === "queued").length
    } queued（用 /memory dream --run 处理）`,
    `  已到复核期的 card：${
      cards.filter((card) =>
        card.reviewAfter !== undefined &&
        Date.parse(card.reviewAfter) <= Date.now()).length
    }`,
    `  已达阈值的效果排序项：${utility.size}` +
    `（alpha=${config?.memory?.utilityLearningRate ?? policy.utility.alpha}, ` +
    `min_uses=${config?.memory?.utilityMinUses ?? policy.utility.minimum_uses}）`,
  ];
  for (const [memoryId, score] of [...utility.entries()]
    .sort(([, left], [, right]) => right - left)
    .slice(0, 5)) {
    lines.push(`  - utility ${score.toFixed(3)} ${memoryId}`);
  }

  for (const scope of scopes) {
    if (scope.error) {
      lines.push(`  ${scopeLabel(scope)}：INVALID（${scope.error}）`);
    } else {
      lines.push(
        `  ${scopeLabel(scope)}：${scope.snapshot
          ? `${scope.snapshot.id} (${scope.snapshot.cards.length} cards)`
          : "(no CURRENT release)"}`,
      );
    }
  }
  console.log(lines.join("\n"));
}

function printSearch(
  query: string,
  scopes: LoadedScope[],
  config?: AgentConfig,
): void {
  const utility = memoryUtilityRanking(config);
  const results: Array<{
    scope: LoadedScope;
    entry: CatalogEntry;
  }> = [];
  for (const scope of scopes) {
    if (!scope.snapshot) continue;
    try {
      const found = searchCurrentCatalog(scope.paths, query, {
        limit: 20,
        ...(utility.size > 0 ? { utility } : {}),
      });
      for (const entry of found) results.push({ scope, entry });
    } catch {
      // loadScopes already records verification failures; never fall back to
      // reading an invalid catalog.
    }
  }
  // Utility is a tiebreak across scopes too, but confidence still leads: a
  // useful memory does not become a more believable one.
  results.sort((left, right) =>
    right.entry.confidence - left.entry.confidence ||
    (utility.get(right.entry.id) ?? 0) - (utility.get(left.entry.id) ?? 0) ||
    left.entry.logicalKey.localeCompare(right.entry.logicalKey));

  const lines = ["", `  🔎 文件索引搜索「${query}」：`];
  if (results.length === 0) {
    lines.push("  未在 verified catalog.tsv 中找到结果。");
  } else {
    for (const { scope, entry } of results.slice(0, 20)) {
      const score = utility.get(entry.id);
      lines.push(
        `  - [${scope.label}] ${entry.logicalKey} — ${entry.title}`,
        `    ${entry.status}/${entry.application}; authority=${entry.authority}; ` +
        `confidence=${entry.confidence.toFixed(3)}` +
        `${score === undefined ? "" : `; utility=${score.toFixed(3)}`}` +
        `; ${entry.summary}`,
      );
    }
  }
  appendScopeErrors(lines, scopes);
  console.log(lines.join("\n"));
}

/**
 * Utility scores for ranking. Config tunes the estimator when set; otherwise
 * POLICY.yml decides, so neither layer is permanently shadowed by the other.
 */
function memoryUtilityRanking(config?: AgentConfig): Map<string, number> {
  try {
    const policy = loadMemoryPolicy();
    return memoryUtilityScores({
      learningRate: config?.memory?.utilityLearningRate ?? policy.utility.alpha,
      minimumUses: config?.memory?.utilityMinUses ?? policy.utility.minimum_uses,
    });
  } catch {
    // Ranking is an enhancement; an unreadable outcome log must not break search.
    return new Map();
  }
}

function printMemoryList(scopes: LoadedScope[]): void {
  const lines = ["", "  🗂️ 当前 verified file memories："];
  let count = 0;
  for (const scope of scopes) {
    if (!scope.snapshot) continue;
    lines.push(
      `  ── ${scopeLabel(scope)} @ ${scope.snapshot.id} ──`,
    );
    for (const card of [...scope.snapshot.cards].sort((left, right) =>
      left.logicalKey.localeCompare(right.logicalKey))) {
      count++;
      lines.push(
        `  - ${card.logicalKey} — ${card.title}`,
        `    ${card.kind}; ${card.status}/${card.application}; ` +
        `authority=${card.authority}; confidence=${card.confidence.toFixed(3)}`,
        `    ${oneLine(card.body, 180)}`,
      );
    }
  }
  if (count === 0) lines.push("  暂无 current verified cards。");
  appendScopeErrors(lines, scopes);
  console.log(lines.join("\n"));
}

function queueManualDreams(repository: FileMemoryRepository): void {
  const policy = loadMemoryPolicy();
  if (!policy.learning_enabled) {
    console.log(
      "\n  记忆学习当前已暂停；没有写入 Dream 队列。请先运行 /profile resume-learning。",
    );
    return;
  }

  const queued: DreamRun[] = [];
  for (const scope of ["global", "project"] as const) {
    const observations = repository.listObservations(scope);
    const candidates = [
      ...repository.listCandidates("pending", scope),
      ...repository.listCandidates("review", scope),
    ];
    if (observations.length === 0 && candidates.length === 0) continue;

    queued.push(queueDream(repository.dreamsDir(scope), {
      scope,
      ...(scope === "project" ? { project_id: repository.projectId } : {}),
      reason: "manual_cli",
      observation_ids: observations.map((observation) => observation.id),
      candidate_ids: candidates.map((candidate) => candidate.id),
      max_retries: policy.dream.max_retries,
    }));
  }

  if (queued.length === 0) {
    console.log(
      "\n  没有可供 Dream 处理的新 observation 或 pending/review candidate；未写入队列。",
    );
    return;
  }

  const lines = [
    "",
    "  🌙 Dream 已持久化到队列（仅 queued；本命令不会执行、验证或发布 release）：",
    ...queued.map((run) =>
      `  - ${run.scope}${run.project_id ? `:${run.project_id}` : ""} ` +
      `${run.run_id} [${run.status}] observations=${run.observation_ids.length} ` +
      `candidates=${run.candidate_ids.length}`),
  ];
  console.log(lines.join("\n"));
}

/**
 * Runs queued Dreams in the foreground. The runner keeps its own lease, run cap,
 * and budget; this wrapper only reports what happened.
 */
async function drainDreamQueue(
  workdir: string,
  config?: AgentConfig,
): Promise<void> {
  if (!config) {
    console.log(
      "\n  当前上下文没有模型配置，无法执行 Dream。请在 rubato 会话内运行 /memory dream --run。",
    );
    return;
  }
  const pending = pendingDreamSummary(workdir);
  if (pending.queued === 0) {
    console.log("\n  队列里没有 queued Dream，未调用模型。");
    return;
  }

  console.log(
    `\n  🌙 正在处理 ${pending.queued} 个 queued Dream（project=${pending.byScope.project}、` +
    `global=${pending.byScope.global}）；模型只能产出候选，不能发布或删除记忆…`,
  );
  try {
    const result = await runQueuedDreams({
      workingDir: workdir,
      model: createProvider(config.model),
      modelName: config.model.model,
      enabled: config.memory?.enabled !== false,
      learningEnabled: config.memory?.learningEnabled !== false,
      maxRuns: config.memory?.dreamMaxRunsPerStart ?? 2,
    });
    const lines = [
      "",
      `  已处理 ${result.attempted} 个 Dream。`,
      `  确定性发布 release：${
        result.publishedReleaseIds.length > 0
          ? result.publishedReleaseIds.join(", ")
          : "(无)"
      }`,
      `  待复核：${result.needsReview}；被拒绝：${result.rejected}`,
    ];
    if (result.skipped.length > 0) {
      lines.push(`  跳过：${result.skipped.join(", ")}`);
    }
    for (const error of result.errors.slice(0, 5)) {
      lines.push(`  ⚠️ ${error}`);
    }
    console.log(lines.join("\n"));
  } catch (error) {
    printMutationError("Dream 执行失败", error);
  }
}

/**
 * Repository facts are re-derivable, so this command supports a read-only audit
 * in addition to publishing a refreshed snapshot.
 */
async function runBootstrapCommand(
  args: string[],
  workdir: string,
  config?: AgentConfig,
): Promise<void> {
  if (!looksLikeProject(workdir)) {
    console.log(
      "\n  当前目录看起来不是一个项目（没有 package.json / tsconfig.json / .git 等标志），已跳过扫描。",
    );
    return;
  }

  const checkOnly = args.includes("--check") || args.includes("--audit");
  const options = {
    workingDir: workdir,
    enabled: config?.memory?.enabled !== false,
    learningEnabled: config?.memory?.learningEnabled !== false,
  };

  try {
    if (checkOnly) {
      const audit = await auditProjectFacts(options);
      console.log([
        "",
        "  🧱 项目事实校验（只读，未写入任何 release）：",
        `  与 checkout 一致：${audit.matched}`,
        `  已过期需刷新：${audit.stale.length > 0 ? audit.stale.join(", ") : "(无)"}`,
        `  尚未记录：${audit.missing.length > 0 ? audit.missing.join(", ") : "(无)"}`,
        `  已不再成立：${audit.orphaned.length > 0 ? audit.orphaned.join(", ") : "(无)"}`,
      ].join("\n"));
      return;
    }

    const result = await bootstrapProjectMemory(options);
    const lines = [
      "",
      `  🧱 已扫描 ${result.scanned} 条项目事实（代码结构、配置、依赖、Git 历史）。`,
      `  新增：${result.created.length > 0 ? result.created.join(", ") : "(无)"}`,
      `  更新：${result.revised.length > 0 ? result.revised.join(", ") : "(无)"}`,
      `  退役：${result.retired.length > 0 ? result.retired.join(", ") : "(无)"}`,
      `  未变化：${result.unchanged}`,
      `  release：${result.releaseId ?? "(无变化，未发布)"}`,
    ];
    for (const item of result.skipped.slice(0, 10)) {
      lines.push(`  ⚠️ 跳过 ${item.logicalKey}：${item.reason}`);
    }
    for (const warning of result.warnings.slice(0, 10)) {
      lines.push(`  ⚠️ ${warning}`);
    }
    console.log(lines.join("\n"));
  } catch (error) {
    printMutationError("项目事实扫描失败", error);
  }
}

function appendScopeErrors(lines: string[], scopes: LoadedScope[]): void {
  for (const scope of scopes) {
    if (scope.error) {
      lines.push(
        `  ⚠️ ${scopeLabel(scope)} release 未通过验证，已排除：${scope.error}`,
      );
    }
  }
}

function selectExactCards(
  scopes: LoadedScope[],
  target: string,
  allowId = false,
): CardSelection {
  const invalid = scopes.filter((scope) => scope.error);
  if (invalid.length > 0) {
    return {
      ok: false,
      message:
        "至少一个 CURRENT release 无法验证，已拒绝修改：" +
        invalid.map((scope) => `${scopeLabel(scope)} (${scope.error})`).join("; "),
    };
  }
  const normalized = target.toLocaleLowerCase();
  const matches = scopes
    .map((scope) => ({
      scope,
      cards: (scope.snapshot?.cards ?? []).filter((card) =>
        card.logicalKey.toLocaleLowerCase() === normalized ||
        (allowId && card.id.toLocaleLowerCase() === normalized)),
    }))
    .filter((item) => item.cards.length > 0);
  if (matches.length === 0) {
    return {
      ok: false,
      message: `没有找到 current verified memory：${target}。`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message:
        `${target} 同时存在于 global/project scope，拒绝猜测修改目标：` +
        matches.map((item) => scopeLabel(item.scope)).join(", "),
    };
  }
  return {
    ok: true,
    scope: matches[0].scope,
    cards: matches[0].cards,
  };
}

function printMutationError(label: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(
    `\n  ${label}：${message}` +
    (/CURRENT changed|Revision mismatch|locked by another publisher/i.test(message)
      ? " 请重新查看最新 profile 后重试；系统没有覆盖并发更新。"
      : ""),
  );
}

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function formatContexts(card: MemoryCard): string {
  const values = [
    card.contexts.domains.length
      ? `domains=${card.contexts.domains.join(",")}`
      : "",
    card.contexts.projects.length
      ? `projects=${card.contexts.projects.join(",")}`
      : "",
    card.contexts.surfaces.length
      ? `surfaces=${card.contexts.surfaces.join(",")}`
      : "",
    card.contexts.languages.length
      ? `languages=${card.contexts.languages.join(",")}`
      : "",
  ].filter(Boolean);
  return values.join("; ") || "(all)";
}

function printProfileUsage(): void {
  console.log(
    "\n  用法：\n" +
    "  /profile show\n" +
    "  /profile why <logical-key>\n" +
    "  /profile correct <logical-key> <new-value>\n" +
    "  /profile forget <logical-key> [--dry-run]\n" +
    "  /profile export [--include-secret]  （默认排除 secret）\n" +
    "  /profile pause-learning | /profile resume-learning",
  );
}

function printMemoryUsage(): void {
  console.log(
    "\n  用法：\n" +
    "  /memory stats | /memory search <q> | /memory list\n" +
    "  /memory dream           仅入队（不调用模型）\n" +
    "  /memory dream --run     入队并立即处理队列（会调用模型）\n" +
    "  /memory bootstrap       重新扫描项目事实（代码结构/配置/Git 历史）\n" +
    "  /memory bootstrap --check  只校验，不写入\n" +
    "  /memory retire <id-or-logical-key>  （可回滚，非隐私删除）\n" +
    "  /memory undo [target-release-id]",
  );
}

function scopeLabel(scope: LoadedScope): string {
  return scope.label === "project"
    ? `project:${scope.paths.projectId ?? "unknown"}`
    : "global";
}

function cardMatches(card: MemoryCard, normalizedQuery: string): boolean {
  return [
    card.logicalKey,
    card.id,
    card.title,
    ...card.aliases,
  ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}

function formatObservationScope(observation: UserObservation): string {
  return observation.scope.kind === "global"
    ? "global"
    : `${observation.scope.kind}:${observation.scope.value ?? "(missing)"}`;
}

function controlEvidenceStatus(
  evidence: MemoryCard["evidence"][number],
  controlEvents: MemoryControlEvent[],
): "verified" | "unresolved" | null {
  if (!evidence.sessionId.startsWith("control:")) return null;
  const projectId = evidence.sessionId.slice("control:".length);
  const event = controlEvents[evidence.eventSeq];
  return event &&
      event.seq === evidence.eventSeq &&
      event.hash === evidence.eventHash &&
      event.project_id === projectId &&
      event.actor === "user"
    ? "verified"
    : "unresolved";
}

function shortHash(value: string | undefined): string {
  if (!value) return "(none)";
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

function oneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function indentBlock(value: string, prefix: string): string {
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function formatCountMap(values: string[]): string {
  if (values.length === 0) return "(none)";
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
}

function summarizeChangeTypes(
  changes: MemoryReleaseSnapshot["manifest"]["changes"],
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const change of changes) {
    summary[change.type] = (summary[change.type] ?? 0) + 1;
  }
  return summary;
}
