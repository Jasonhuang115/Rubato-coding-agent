import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { projectMemoryId } from "../../shared/project-id.js";
import { getRubatoHome } from "../../shared/rubato-home.js";
import type {
  SubagentFailureKind,
  SubagentTaskStatus,
  TaskDetail,
} from "../../shared/core-types.js";

const SCHEMA_VERSION = 2;
const DEFAULT_LEASE_MS = 15_000;

export type AgentKind = "root" | "subagent";
export type RunStatus = "queued" | "running" | "finished" | "failed";
export type RunTrigger = "user_message" | "subagent_terminal" | "resume";
export type RuntimeEventKind = "user_message" | "subagent_terminal";

export interface AgentRunInput {
  runId: string;
  conversationId: string;
  kind: AgentKind;
  trigger: RunTrigger;
  provider: string;
  model: string;
  taskId?: string;
  attempt?: number;
  sessionPath?: string;
  tracePath?: string;
  draftPath?: string;
}

export interface PersistedTaskControl {
  taskId: string;
  conversationId: string;
  originRunId: string;
  status: SubagentTaskStatus;
  specPath: string;
  reportPath: string;
  resultPath: string;
  coveragePath: string;
  worktreePath?: string;
  timeoutMs: number;
  accumulatedRuntimeMs: number;
  attempt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  currentActivity?: string;
  currentTool?: string;
  failureKind?: SubagentFailureKind;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
  pinned: boolean;
}

export interface RuntimeEventRecord {
  eventId: string;
  conversationId: string;
  taskId?: string;
  kind: RuntimeEventKind;
  terminalStatus?: "finished" | "failed";
  failureKind?: SubagentFailureKind;
  sourceEventId?: string;
  reportPath?: string;
  createdAt: number;
  claimedAt?: number;
  claimOwner?: string;
  claimExpiresAt?: number;
  deliveredAt?: number;
}

export interface AgentRunControl {
  runId: string;
  conversationId: string;
  kind: AgentKind;
  status: RunStatus;
  sessionPath?: string;
  tracePath?: string;
  draftPath?: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  failureKind?: string;
}

interface TaskRow {
  task_id: string;
  conversation_id: string;
  origin_run_id: string;
  status: SubagentTaskStatus;
  spec_path: string;
  report_path: string;
  result_path: string;
  coverage_path: string;
  worktree_path: string | null;
  timeout_ms: number;
  accumulated_runtime_ms: number;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  current_activity: string | null;
  current_tool: string | null;
  failure_kind: SubagentFailureKind | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number;
  pinned: number;
}

interface EventRow {
  event_id: string;
  conversation_id: string;
  task_id: string | null;
  kind: RuntimeEventKind;
  terminal_status: "finished" | "failed" | null;
  failure_kind: SubagentFailureKind | null;
  source_event_id: string | null;
  report_path: string | null;
  created_at: number;
  claimed_at: number | null;
  claim_owner: string | null;
  claim_expires_at: number | null;
  delivered_at: number | null;
}

export class ControlPlaneStore {
  readonly projectId: string;
  readonly dbPath: string;
  readonly ownerId = `control-plane-${randomUUID()}`;
  private readonly db: Database.Database;

  constructor(
    projectDir: string,
    options: { dbPath?: string; rubatoHome?: string } = {},
  ) {
    this.projectId = projectMemoryId(projectDir);
    this.dbPath = options.dbPath ?? path.join(
      options.rubatoHome ?? getRubatoHome(),
      "projects",
      this.projectId,
      "state.sqlite3",
    );
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = FULL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  schemaColumns(table: string): string[] {
    if (!new Set(["conversations", "agent_runs", "subagent_tasks", "runtime_events"]).has(table)) {
      throw new Error(`Unknown control-plane table: ${table}`);
    }
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((row) => row.name);
  }

  ensureConversation(conversationId: string, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO conversations (
        conversation_id, project_id, status, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        status = 'active',
        updated_at = excluded.updated_at
    `).run(conversationId, this.projectId, now, now);
  }

  createRun(input: AgentRunInput, now = Date.now()): void {
    this.ensureConversation(input.conversationId, now);
    const transaction = this.db.transaction(() => {
      if (input.kind === "root") {
        const active = this.db.prepare(`
          SELECT run_id, lease_owner, lease_expires_at FROM agent_runs
          WHERE conversation_id = ? AND agent_kind = 'root' AND status = 'running'
        `).get(input.conversationId) as {
          run_id: string;
          lease_owner: string | null;
          lease_expires_at: number | null;
        } | undefined;
        if (active && active.run_id !== input.runId) {
          if ((active.lease_expires_at ?? Number.POSITIVE_INFINITY) > now) {
            throw new Error(`Conversation ${input.conversationId} already has running root run ${active.run_id}`);
          }
          this.db.prepare(`
            UPDATE agent_runs SET status = 'failed', failure_kind = 'interrupted',
              ended_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
            WHERE run_id = ? AND status = 'running'
          `).run(now, now, active.run_id);
        }
      }
      this.db.prepare(`
        INSERT INTO agent_runs (
          run_id, conversation_id, agent_kind, task_id, attempt, status,
          trigger_kind, provider, model, session_path, trace_path, draft_path,
          lease_owner, lease_expires_at, created_at, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.runId,
        input.conversationId,
        input.kind,
        input.taskId ?? null,
        input.attempt ?? 1,
        input.trigger,
        input.provider,
        input.model,
        input.sessionPath ?? null,
        input.tracePath ?? null,
        input.draftPath ?? null,
        input.kind === "root" ? this.ownerId : null,
        input.kind === "root" ? now + DEFAULT_LEASE_MS : null,
        now,
        now,
        now,
      );
      this.db.prepare(`
        UPDATE conversations
        SET active_root_run_id = CASE WHEN ? = 'root' THEN ? ELSE active_root_run_id END,
            latest_run_id = ?, updated_at = ?
        WHERE conversation_id = ?
      `).run(input.kind, input.runId, input.runId, now, input.conversationId);
    });
    transaction();
  }

  heartbeatRun(runId: string, now = Date.now(), leaseMs = DEFAULT_LEASE_MS): boolean {
    const result = this.db.prepare(`
      UPDATE agent_runs SET lease_expires_at = ?, updated_at = ?
      WHERE run_id = ? AND agent_kind = 'root' AND status = 'running'
        AND lease_owner = ?
    `).run(now + leaseMs, now, runId, this.ownerId);
    return result.changes === 1;
  }

  finishRun(
    runId: string,
    status: "finished" | "failed",
    values: {
      failureKind?: string;
      inputTokens?: number;
      outputTokens?: number;
      toolCalls?: number;
    } = {},
    now = Date.now(),
  ): void {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT conversation_id, agent_kind FROM agent_runs WHERE run_id = ?
      `).get(runId) as { conversation_id: string; agent_kind: AgentKind } | undefined;
      if (!row) return;
      this.db.prepare(`
        UPDATE agent_runs SET
          status = ?, failure_kind = ?, input_tokens = ?, output_tokens = ?,
          tool_calls = ?, ended_at = ?, updated_at = ?,
          lease_owner = NULL, lease_expires_at = NULL
        WHERE run_id = ?
      `).run(
        status,
        values.failureKind ?? null,
        values.inputTokens ?? 0,
        values.outputTokens ?? 0,
        values.toolCalls ?? 0,
        now,
        now,
        runId,
      );
      if (row.agent_kind === "root") {
        this.db.prepare(`
          UPDATE conversations SET
            active_root_run_id = CASE WHEN active_root_run_id = ? THEN NULL ELSE active_root_run_id END,
            updated_at = ?
          WHERE conversation_id = ?
        `).run(runId, now, row.conversation_id);
      }
    });
    transaction();
  }

  getRun(runId: string): AgentRunControl | undefined {
    const row = this.db.prepare(`
      SELECT run_id, conversation_id, agent_kind, status, session_path,
        trace_path, draft_path, input_tokens, output_tokens, tool_calls, failure_kind
      FROM agent_runs WHERE run_id = ?
    `).get(runId) as {
      run_id: string;
      conversation_id: string;
      agent_kind: AgentKind;
      status: RunStatus;
      session_path: string | null;
      trace_path: string | null;
      draft_path: string | null;
      input_tokens: number;
      output_tokens: number;
      tool_calls: number;
      failure_kind: string | null;
    } | undefined;
    return row ? {
      runId: row.run_id,
      conversationId: row.conversation_id,
      kind: row.agent_kind,
      status: row.status,
      sessionPath: row.session_path ?? undefined,
      tracePath: row.trace_path ?? undefined,
      draftPath: row.draft_path ?? undefined,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      toolCalls: row.tool_calls,
      failureKind: row.failure_kind ?? undefined,
    } : undefined;
  }

  upsertTask(
    detail: TaskDetail,
    values: {
      conversationId: string;
      originRunId: string;
      timeoutMs: number;
      accumulatedRuntimeMs?: number;
      attempt?: number;
      leaseOwner?: string;
      leaseExpiresAt?: number;
    },
    now = Date.now(),
  ): void {
    this.ensureConversation(values.conversationId, now);
    this.db.prepare(`
      INSERT INTO subagent_tasks (
        task_id, conversation_id, origin_run_id, status,
        spec_path, report_path, result_path, coverage_path, worktree_path,
        timeout_ms, accumulated_runtime_ms, attempt,
        lease_owner, lease_expires_at, current_activity, current_tool,
        failure_kind, created_at, started_at, ended_at, updated_at, pinned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        status = excluded.status,
        worktree_path = excluded.worktree_path,
        accumulated_runtime_ms = excluded.accumulated_runtime_ms,
        attempt = excluded.attempt,
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        current_activity = excluded.current_activity,
        current_tool = excluded.current_tool,
        failure_kind = excluded.failure_kind,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        updated_at = excluded.updated_at,
        pinned = excluded.pinned
    `).run(
      detail.taskId,
      values.conversationId,
      values.originRunId,
      detail.status,
      detail.artifacts.task,
      detail.artifacts.report,
      detail.artifacts.result,
      detail.artifacts.coverage,
      detail.workspace?.path ?? null,
      values.timeoutMs,
      values.accumulatedRuntimeMs ?? 0,
      values.attempt ?? 0,
      values.leaseOwner ?? null,
      values.leaseExpiresAt ?? null,
      detail.currentActivity ?? null,
      detail.currentTool ?? null,
      detail.failureKind ?? null,
      detail.createdAt,
      detail.startedAt ?? null,
      detail.endedAt ?? null,
      now,
      detail.pinned ? 1 : 0,
    );
  }

  updateTaskControl(
    taskId: string,
    values: {
      status?: SubagentTaskStatus;
      accumulatedRuntimeMs?: number;
      attempt?: number;
      leaseOwner?: string | null;
      leaseExpiresAt?: number | null;
      currentActivity?: string | null;
      currentTool?: string | null;
      failureKind?: SubagentFailureKind | null;
      startedAt?: number | null;
      endedAt?: number | null;
      worktreePath?: string | null;
      pinned?: boolean;
    },
    now = Date.now(),
  ): void {
    const assignments: string[] = ["updated_at = @updatedAt"];
    const params: Record<string, unknown> = { taskId, updatedAt: now };
    const columns: Array<[keyof typeof values, string, (value: unknown) => unknown]> = [
      ["status", "status", (value) => value],
      ["accumulatedRuntimeMs", "accumulated_runtime_ms", (value) => value],
      ["attempt", "attempt", (value) => value],
      ["leaseOwner", "lease_owner", (value) => value],
      ["leaseExpiresAt", "lease_expires_at", (value) => value],
      ["currentActivity", "current_activity", (value) => value],
      ["currentTool", "current_tool", (value) => value],
      ["failureKind", "failure_kind", (value) => value],
      ["startedAt", "started_at", (value) => value],
      ["endedAt", "ended_at", (value) => value],
      ["worktreePath", "worktree_path", (value) => value],
      ["pinned", "pinned", (value) => value ? 1 : 0],
    ];
    for (const [key, column, transform] of columns) {
      if (!(key in values)) continue;
      assignments.push(`${column} = @${String(key)}`);
      params[String(key)] = transform(values[key]);
    }
    this.db.prepare(`
      UPDATE subagent_tasks SET ${assignments.join(", ")} WHERE task_id = @taskId
    `).run(params);
  }

  getTask(taskId: string): PersistedTaskControl | undefined {
    const row = this.db.prepare(`
      SELECT * FROM subagent_tasks WHERE task_id = ?
    `).get(taskId) as TaskRow | undefined;
    return row ? mapTask(row) : undefined;
  }

  listTasks(conversationId: string): PersistedTaskControl[] {
    return (this.db.prepare(`
      SELECT * FROM subagent_tasks
      WHERE conversation_id = ? ORDER BY created_at, task_id
    `).all(conversationId) as TaskRow[]).map(mapTask);
  }

  deleteTask(taskId: string): void {
    this.db.prepare("DELETE FROM subagent_tasks WHERE task_id = ?").run(taskId);
  }

  claimTask(
    taskId: string,
    owner: string,
    now = Date.now(),
    leaseMs = DEFAULT_LEASE_MS,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_tasks SET
        status = 'running', attempt = attempt + 1,
        lease_owner = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?),
        updated_at = ?
      WHERE task_id = ? AND status = 'queued'
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(owner, now + leaseMs, now, now, taskId, now);
    return result.changes === 1;
  }

  heartbeatTask(
    taskId: string,
    owner: string,
    accumulatedRuntimeMs: number,
    now = Date.now(),
    leaseMs = DEFAULT_LEASE_MS,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_tasks SET
        accumulated_runtime_ms = ?, lease_expires_at = ?, updated_at = ?
      WHERE task_id = ? AND status = 'running' AND lease_owner = ?
    `).run(accumulatedRuntimeMs, now + leaseMs, now, taskId, owner);
    return result.changes === 1;
  }

  pauseTask(taskId: string, owner: string, accumulatedRuntimeMs: number, now = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_tasks SET
        status = 'queued', accumulated_runtime_ms = ?, lease_owner = NULL,
        lease_expires_at = NULL, current_activity = 'paused', current_tool = NULL,
        updated_at = ?
      WHERE task_id = ? AND status = 'running' AND lease_owner = ?
    `).run(accumulatedRuntimeMs, now, taskId, owner);
    return result.changes === 1;
  }

  recoverExpiredTasks(conversationId: string, now = Date.now()): string[] {
    const rows = this.db.prepare(`
      SELECT task_id FROM subagent_tasks
      WHERE conversation_id = ? AND status = 'running'
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).all(conversationId, now) as Array<{ task_id: string }>;
    this.db.prepare(`
      UPDATE subagent_tasks SET
        status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
        current_activity = 'recovering', current_tool = NULL, updated_at = ?
      WHERE conversation_id = ? AND status = 'running'
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).run(now, conversationId, now);
    return rows.map((row) => row.task_id);
  }

  createUserMessageEvent(
    conversationId: string,
    sourceEventId: string,
    deliveredBy?: string,
    now = Date.now(),
  ): string {
    const eventId = randomUUID();
    this.ensureConversation(conversationId, now);
    this.db.prepare(`
      INSERT OR IGNORE INTO runtime_events (
        event_id, conversation_id, kind, source_event_id, created_at,
        claimed_at, claim_owner, delivered_at
      ) VALUES (?, ?, 'user_message', ?, ?, ?, ?, ?)
    `).run(
      eventId,
      conversationId,
      sourceEventId,
      now,
      deliveredBy ? now : null,
      deliveredBy ?? null,
      deliveredBy ? now : null,
    );
    const existing = this.db.prepare(`
      SELECT event_id FROM runtime_events WHERE kind = 'user_message' AND source_event_id = ?
    `).get(sourceEventId) as { event_id: string };
    return existing.event_id;
  }

  createTerminalEvent(
    conversationId: string,
    values: {
      taskId: string;
      status: "finished" | "failed";
      failureKind?: SubagentFailureKind;
      reportPath: string;
      claimOwner?: string;
    },
    now = Date.now(),
  ): string {
    const eventId = randomUUID();
    this.ensureConversation(conversationId, now);
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE subagent_tasks SET
          status = ?, failure_kind = ?, ended_at = ?, updated_at = ?,
          lease_owner = NULL, lease_expires_at = NULL,
          current_activity = ?, current_tool = NULL
        WHERE task_id = ?
      `).run(
        values.status,
        values.failureKind ?? null,
        now,
        now,
        values.status,
        values.taskId,
      );
      this.db.prepare(`
        INSERT OR IGNORE INTO runtime_events (
          event_id, conversation_id, task_id, kind, terminal_status,
          failure_kind, report_path, created_at, claimed_at, claim_owner, claim_expires_at
        ) VALUES (?, ?, ?, 'subagent_terminal', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        conversationId,
        values.taskId,
        values.status,
        values.failureKind ?? null,
        values.reportPath,
        now,
        values.claimOwner ? now : null,
        values.claimOwner ?? null,
        values.claimOwner ? now + DEFAULT_LEASE_MS : null,
      );
      if (values.claimOwner) {
        this.db.prepare(`
          UPDATE runtime_events SET claimed_at = ?, claim_owner = ?, claim_expires_at = ?
          WHERE kind = 'subagent_terminal' AND task_id = ? AND delivered_at IS NULL
            AND (claim_owner IS NULL OR claim_owner = ? OR claim_expires_at <= ?)
        `).run(
          now,
          values.claimOwner,
          now + DEFAULT_LEASE_MS,
          values.taskId,
          values.claimOwner,
          now,
        );
      }
    });
    transaction();
    const existing = this.db.prepare(`
      SELECT event_id FROM runtime_events
      WHERE kind = 'subagent_terminal' AND task_id = ?
    `).get(values.taskId) as { event_id: string };
    return existing.event_id;
  }

  claimEvents(
    conversationId: string,
    owner: string,
    now = Date.now(),
    leaseMs = DEFAULT_LEASE_MS,
  ): RuntimeEventRecord[] {
    const transaction = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT event_id FROM runtime_events
        WHERE conversation_id = ? AND delivered_at IS NULL
          AND (claim_expires_at IS NULL OR claim_expires_at <= ? OR claim_owner = ?)
        ORDER BY created_at, event_id
      `).all(conversationId, now, owner) as Array<{ event_id: string }>;
      if (rows.length === 0) return [];
      const update = this.db.prepare(`
        UPDATE runtime_events SET claimed_at = ?, claim_owner = ?, claim_expires_at = ?
        WHERE event_id = ?
      `);
      for (const row of rows) update.run(now, owner, now + leaseMs, row.event_id);
      return this.db.prepare(`
        SELECT * FROM runtime_events WHERE claim_owner = ? AND delivered_at IS NULL
        ORDER BY created_at, event_id
      `).all(owner) as EventRow[];
    });
    return transaction().map(mapEvent);
  }

  markEventsDelivered(eventIds: string[], owner: string, now = Date.now()): void {
    if (eventIds.length === 0) return;
    const statement = this.db.prepare(`
      UPDATE runtime_events SET delivered_at = ?, claim_expires_at = NULL
      WHERE event_id = ? AND claim_owner = ?
    `);
    this.db.transaction(() => {
      for (const eventId of eventIds) statement.run(now, eventId, owner);
    })();
  }

  listPendingEvents(conversationId: string): RuntimeEventRecord[] {
    return (this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE conversation_id = ? AND delivered_at IS NULL
      ORDER BY created_at, event_id
    `).all(conversationId) as EventRow[]).map(mapEvent);
  }

  importLegacyArtifacts(): { imported: number; unavailable: number } {
    const runsDir = path.join(path.dirname(this.dbPath), "runs");
    if (!fs.existsSync(runsDir)) return { imported: 0, unavailable: 0 };
    let imported = 0;
    let unavailable = 0;
    for (const runEntry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) continue;
      const tasksDir = path.join(runsDir, runEntry.name, "tasks");
      if (!fs.existsSync(tasksDir)) continue;
      for (const taskEntry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
        if (!taskEntry.isDirectory() || this.getTask(taskEntry.name)) continue;
        const taskDir = path.join(tasksDir, taskEntry.name);
        const specPath = path.join(taskDir, "task.json");
        if (!fs.existsSync(specPath)) continue;
        try {
          const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as {
            taskId?: string;
            rootSessionId?: string;
            createdAt?: number;
            timeoutMs?: number;
            workspace?: { path?: string };
          };
          const taskId = spec.taskId ?? taskEntry.name;
          const conversationId = spec.rootSessionId || runEntry.name;
          const resultPath = path.join(taskDir, "result.json");
          const reportPath = path.join(taskDir, "report.md");
          const coveragePath = path.join(taskDir, "coverage.json");
          let status: SubagentTaskStatus = "failed";
          let failureKind: SubagentFailureKind | undefined = "interrupted";
          let endedAt: number | undefined;
          if (fs.existsSync(resultPath)) {
            const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
              status?: SubagentTaskStatus;
              failureKind?: SubagentFailureKind;
              endedAt?: number;
            };
            status = result.status === "finished" ? "finished" : "failed";
            failureKind = result.failureKind;
            endedAt = result.endedAt;
          } else {
            unavailable++;
            fs.appendFileSync(
              reportPath,
              "\n\n<!-- Legacy task cannot be resumed because its pre-database specification is incomplete. -->\n",
              "utf8",
            );
          }
          const now = Date.now();
          this.ensureConversation(conversationId, now);
          this.db.prepare(`
            INSERT OR IGNORE INTO subagent_tasks (
              task_id, conversation_id, origin_run_id, status,
              spec_path, report_path, result_path, coverage_path, worktree_path,
              timeout_ms, accumulated_runtime_ms, attempt,
              current_activity, failure_kind, created_at, ended_at, updated_at, pinned
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 0)
          `).run(
            taskId,
            conversationId,
            runEntry.name,
            status,
            specPath,
            reportPath,
            resultPath,
            coveragePath,
            spec.workspace?.path ?? null,
            Math.max(1, spec.timeoutMs ?? 1),
            status,
            failureKind ?? null,
            spec.createdAt ?? now,
            endedAt ?? now,
            now,
          );
          this.createTerminalEvent(conversationId, {
            taskId,
            status: status === "finished" ? "finished" : "failed",
            failureKind,
            reportPath,
          }, endedAt ?? now);
          imported++;
        } catch {
          // Malformed legacy artifacts remain untouched and are not indexed.
        }
      }
    }
    return { imported, unavailable };
  }

  reconcileArtifacts(conversationId: string): { repaired: string[]; missing: string[] } {
    const repaired: string[] = [];
    const missing: string[] = [];
    for (const task of this.listTasks(conversationId)) {
      if (fs.existsSync(task.resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(task.resultPath, "utf8")) as {
            status?: SubagentTaskStatus;
            failureKind?: SubagentFailureKind;
            endedAt?: number;
          };
          if (!isTerminalStatus(task.status) || !this.hasTerminalEvent(task.taskId)) {
            const status = result.status === "finished" ? "finished" : "failed";
            this.createTerminalEvent(conversationId, {
              taskId: task.taskId,
              status,
              failureKind: result.failureKind,
              reportPath: task.reportPath,
            }, result.endedAt ?? Date.now());
            repaired.push(task.taskId);
          }
        } catch {
          // Leave malformed terminal artifacts for explicit inspection.
        }
      } else if (isTerminalStatus(task.status) && !fs.existsSync(task.resultPath)) {
        this.updateTaskControl(task.taskId, {
          status: "failed",
          failureKind: "runtime_error",
          currentActivity: "artifact_missing",
        });
        this.createTerminalEvent(conversationId, {
          taskId: task.taskId,
          status: "failed",
          failureKind: "runtime_error",
          reportPath: task.reportPath,
        });
        missing.push(task.taskId);
      }
    }
    return { repaired, missing };
  }

  private hasTerminalEvent(taskId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM runtime_events
      WHERE kind = 'subagent_terminal' AND task_id = ?
    `).get(taskId));
  }

  setOpikExportedSequence(runId: string, sequence: number): void {
    this.db.prepare(`
      UPDATE agent_runs SET opik_exported_seq = MAX(opik_exported_seq, ?), updated_at = ?
      WHERE run_id = ?
    `).run(sequence, Date.now(), runId);
  }

  getOpikExportedSequence(runId: string): number {
    const row = this.db.prepare(`
      SELECT opik_exported_seq FROM agent_runs WHERE run_id = ?
    `).get(runId) as { opik_exported_seq: number } | undefined;
    return row?.opik_exported_seq ?? 0;
  }

  listTraceExports(conversationId: string): Array<{
    runId: string;
    tracePath: string;
    exportedSequence: number;
  }> {
    return (this.db.prepare(`
      SELECT run_id, trace_path, opik_exported_seq FROM agent_runs
      WHERE conversation_id = ? AND trace_path IS NOT NULL
      ORDER BY created_at, run_id
    `).all(conversationId) as Array<{
      run_id: string;
      trace_path: string;
      opik_exported_seq: number;
    }>).map((row) => ({
      runId: row.run_id,
      tracePath: row.trace_path,
      exportedSequence: row.opik_exported_seq,
    }));
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      throw new Error(`Control-plane schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (version === SCHEMA_VERSION) return;
    this.db.transaction(() => {
      if (version === 1) {
        this.db.exec(`
          ALTER TABLE agent_runs ADD COLUMN lease_owner TEXT;
          ALTER TABLE agent_runs ADD COLUMN lease_expires_at INTEGER;
        `);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
        return;
      }
      this.db.exec(`
        CREATE TABLE conversations (
          conversation_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'ended')),
          active_root_run_id TEXT,
          latest_run_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE agent_runs (
          run_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
          agent_kind TEXT NOT NULL CHECK(agent_kind IN ('root', 'subagent')),
          task_id TEXT,
          attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0),
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'finished', 'failed')),
          trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('user_message', 'subagent_terminal', 'resume')),
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          tool_calls INTEGER NOT NULL DEFAULT 0,
          failure_kind TEXT,
          session_path TEXT,
          trace_path TEXT,
          draft_path TEXT,
          opik_exported_seq INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          ended_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX one_running_root_per_conversation
          ON agent_runs(conversation_id)
          WHERE agent_kind = 'root' AND status = 'running';
        CREATE INDEX agent_runs_conversation_created
          ON agent_runs(conversation_id, created_at);

        CREATE TABLE subagent_tasks (
          task_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
          origin_run_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'finished', 'failed')),
          spec_path TEXT NOT NULL,
          report_path TEXT NOT NULL,
          result_path TEXT NOT NULL,
          coverage_path TEXT NOT NULL,
          worktree_path TEXT,
          timeout_ms INTEGER NOT NULL CHECK(timeout_ms > 0),
          accumulated_runtime_ms INTEGER NOT NULL DEFAULT 0 CHECK(accumulated_runtime_ms >= 0),
          attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
          lease_owner TEXT,
          lease_expires_at INTEGER,
          current_activity TEXT,
          current_tool TEXT,
          failure_kind TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          ended_at INTEGER,
          updated_at INTEGER NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1))
        );
        CREATE INDEX subagent_tasks_conversation_status
          ON subagent_tasks(conversation_id, status, created_at);

        CREATE TABLE runtime_events (
          event_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
          task_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('user_message', 'subagent_terminal')),
          terminal_status TEXT CHECK(terminal_status IN ('finished', 'failed')),
          failure_kind TEXT,
          source_event_id TEXT,
          report_path TEXT,
          created_at INTEGER NOT NULL,
          claimed_at INTEGER,
          claim_owner TEXT,
          claim_expires_at INTEGER,
          delivered_at INTEGER,
          CHECK(
            (kind = 'user_message' AND source_event_id IS NOT NULL AND task_id IS NULL
              AND terminal_status IS NULL AND report_path IS NULL)
            OR
            (kind = 'subagent_terminal' AND task_id IS NOT NULL
              AND terminal_status IS NOT NULL AND report_path IS NOT NULL)
          )
        );
        CREATE UNIQUE INDEX one_terminal_event_per_task
          ON runtime_events(task_id)
          WHERE kind = 'subagent_terminal';
        CREATE UNIQUE INDEX one_event_per_user_message
          ON runtime_events(source_event_id)
          WHERE kind = 'user_message';
        CREATE INDEX runtime_events_pending
          ON runtime_events(conversation_id, delivered_at, created_at);
      `);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }
}

function mapTask(row: TaskRow): PersistedTaskControl {
  return {
    taskId: row.task_id,
    conversationId: row.conversation_id,
    originRunId: row.origin_run_id,
    status: row.status,
    specPath: row.spec_path,
    reportPath: row.report_path,
    resultPath: row.result_path,
    coveragePath: row.coverage_path,
    worktreePath: row.worktree_path ?? undefined,
    timeoutMs: row.timeout_ms,
    accumulatedRuntimeMs: row.accumulated_runtime_ms,
    attempt: row.attempt,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    currentActivity: row.current_activity ?? undefined,
    currentTool: row.current_tool ?? undefined,
    failureKind: row.failure_kind ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    updatedAt: row.updated_at,
    pinned: row.pinned === 1,
  };
}

function mapEvent(row: EventRow): RuntimeEventRecord {
  return {
    eventId: row.event_id,
    conversationId: row.conversation_id,
    taskId: row.task_id ?? undefined,
    kind: row.kind,
    terminalStatus: row.terminal_status ?? undefined,
    failureKind: row.failure_kind ?? undefined,
    sourceEventId: row.source_event_id ?? undefined,
    reportPath: row.report_path ?? undefined,
    createdAt: row.created_at,
    claimedAt: row.claimed_at ?? undefined,
    claimOwner: row.claim_owner ?? undefined,
    claimExpiresAt: row.claim_expires_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
  };
}

function isTerminalStatus(status: SubagentTaskStatus): boolean {
  return status === "finished" || status === "failed";
}
