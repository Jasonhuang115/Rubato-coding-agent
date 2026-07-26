// ============================================================
// Core type definitions — shared across all modules
// ============================================================

// ---- Message types (Anthropic-compatible format) ----

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

// ---- Tool system ----

export type ToolType = "read" | "write";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  type: ToolType;
  requiresApproval?: boolean;
  handler: (input: Record<string, unknown>, ctx: AgentContext) => Promise<ToolResult>;
  isConcurrencySafe?: boolean; // true = 可并行（Read/Grep/Glob）
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Runtime-only control signal. It is never serialized as a normal tool result. */
  control?: TaskCompletionControl;
}

// ---- Agent context (passed to every tool) ----

export interface AgentContext {
  workingDir: string;
  sessionId: string;
  readGuard: ReadGuardState;
  permissionManager: PermissionManager;
  config: AgentConfig;
  planManager?: PlanManager;
  /** Recursion depth. 0 = root agent. */
  depth: number;
  /** Present only while a managed subagent task is running. */
  taskRuntime?: SubagentRuntimeContext;
  /** Per-agent cancellation signal. */
  abortSignal?: AbortSignal;
}

export interface PlanManager {
  getActivePlan(): { title: string; status: string; goal: string } | null;
  getPlanSummary(): string;
  onUserMessage(message: string): string | null;
  onToolCall(toolName: string, input: Record<string, unknown>): string | null;
}

export interface ReadGuardState {
  hasRead(filePath: string): boolean;
  markAsRead(filePath: string, content: string): void;
  serialize(): ReadGuardSnapshot;
}

export interface ReadGuardSnapshot {
  files: Record<string, { timestamp: number; hash: string }>;
}

export interface PermissionManager {
  check(toolName: string, input: Record<string, unknown>): PermissionResult;
}

export type PermissionResult =
  | { allowed: true }
  | { allowed: false; reason: string; mode: "confirm" | "manual" };

// ---- Agent config ----

export interface AgentConfig {
  model: {
    provider: string;       // "deepseek" | "openai" | "anthropic"
    model: string;          // "deepseek-chat" | "claude-sonnet-4-20250514" | ...
    baseURL?: string;       // 自定义 API 端点
    apiKey?: string;        // 覆盖环境变量
    maxRetries?: number;
  };
  permissions: {
    bash: PermissionMode;
    read: PermissionMode;
    write: PermissionMode;
    edit: PermissionMode;
    web: PermissionMode;
    rules?: PermissionRule[];
  };
  embedding: {
    /** Built-in deterministic embedding used by Mnemosyne. */
    source: "local_hash";
  };
  mnemosyne: {
    bootstrap_on_first_open: boolean;
    bootstrap_max_files: number;
  };
  session: {
    cleanupPeriodDays: number;
  };
  subagents?: Partial<SubagentLimits>;
}

export type PermissionMode = "auto" | "confirm" | "manual";

/** Result of an interactive permission confirmation. */
export type ConfirmDecision =
  | "allow_once"    // Run this time only
  | "allow_always"  // Run + stop asking for this tool type (rest of session)
  | "deny_once"     // Skip this time
  | "deny_always";  // Skip + block this tool type (rest of session)

export interface PermissionRule {
  tool: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
  reason?: string;
}

// ---- Model Provider ----

export interface ChatParams {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partialJson: string }
  | { type: "tool_use_end"; id: string; input: Record<string, unknown> }
  | { type: "content_block_stop"; index: number }
  | { type: "message_stop"; stopReason: "end_turn" | "tool_use" | "max_tokens"; usage: TokenUsage }
  | { type: "error"; message: string; retryable: boolean };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelProvider {
  readonly name: string;
  chat(params: ChatParams): AsyncIterable<StreamEvent>;
  supportsPromptCaching(): boolean;
  countTokens(messages: Message[], system: string): Promise<number>;
}

// ---- Context Source ----

export interface ContextBlock {
  content: string;
  priority: number;
  source: string;
}

export interface ContextSource {
  readonly name: string;
  readonly priority: number;
  fetch(query: string, ctx: AgentContext): Promise<ContextBlock | null>;
}

// ---- Stream Renderer ----

export interface StreamRenderer {
  renderUserMessage(text: string): void;
  renderAssistantMessage(text: string): void;
  renderThinking(text: string): void;
  renderSystemMessage(text: string): void;
  renderToolUse(tool: string, input: unknown): void;
  renderToolResult(result: string): void;
  renderError(error: string): void;
  renderWarning(warning: string): void;
  clear(): void;
  flush(): void;
}

// ---- Session ----

export interface SessionMeta {
  id: string;
  timestamp: number;
  model: string;
  totalTokens: number;
  duration: number;
  branch: string;
  fileHistory: string[];
  summary?: string;
  firstMessage?: string;
  messageCount?: number;
  status?: "active" | "ended";
}

export interface SessionRecord {
  type: "session_meta" | "message" | "tool_event" | "compaction";
  timestamp: number;
  data: unknown;
}

// ---- Session Index ----

export type SessionStatus = "active" | "ended";

export interface SessionIndexEntry {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  firstMessage: string;
  model: string;
  tokenCount: number;
  messageCount: number;
  status: SessionStatus;
  summary?: string;
}

// ---- Subagent ----

export interface SubagentDefinition {
  name: string;               // "explore" | "general" | "verify" | custom
  description: string;        // used for intent-matching
  systemPrompt: string;
  model?: string;             // "inherit" | specific model ID
  tools: string[];            // allowlist, ["*"] = all except AgentTool
  readonly: boolean;          // default true
  maxTurns?: number;          // optional — subagents run until completion by default
  /** Whether subagents of this type can spawn further subagents. Default false. */
  canSpawn?: boolean;
}

export type SubagentDependency = "advisory" | "required";

export type SubagentTaskStatus =
  | "queued"
  | "running"
  | "waiting_child"
  | "completed"
  | "partial"
  | "blocked"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "orphaned";

export interface SubagentLimits {
  maxConcurrent: number;
  maxTasksPerSession: number;
  maxDepth: number;
  stallTimeoutMs: number;
  hardTimeoutMs: number;
  maxTurns?: number;
  artifactTtlDays: number;
  artifactSoftLimitBytes: number;
}

export interface AgentTaskInput {
  description: string;
  prompt: string;
  subagent_type?: string;
  dependency?: SubagentDependency;
  model?: string;
  timeout_ms?: number;
  /**
   * `exhaustive` enables a runtime-enforced file/line coverage gate.
   * `auto` (the default) also enables it when the task wording promises
   * exhaustive or every-line inspection.
   */
  coverage?: "auto" | "exhaustive";
}

export interface CompleteTaskInput {
  status: "completed" | "partial" | "blocked";
  summary: string;
  report_markdown: string;
  key_files?: string[];
  artifacts?: Array<{
    path: string;
    description: string;
  }>;
  /**
   * Optional declaration used when the assignment promises exhaustive
   * coverage. The runtime, not the model, computes the actual coverage from
   * observable Glob/Read/Grep tool activity.
   */
  coverage?: CompleteTaskCoverageDeclaration;
}

export interface CompleteTaskCoverageDeclaration {
  exhaustive?: boolean;
  scope_roots?: string[];
  exclusions?: Array<{
    path: string;
    reason: string;
  }>;
}

export type CoverageFileStatus = "discovered" | "inspected" | "excluded" | "failed";

export interface CoverageFileEntry {
  path: string;
  status: CoverageFileStatus;
  line_count?: number;
  content_hash?: string;
  inspected_ranges?: Array<{ start: number; end: number }>;
  reason?: string;
}

export interface CoverageManifest {
  version: 1;
  required: boolean;
  scope_roots: string[];
  discovery_complete: boolean;
  complete: boolean;
  gate_satisfied: boolean;
  discovered: number;
  inspected: number;
  excluded: number;
  failed: number;
  line_count: number;
  files: CoverageFileEntry[];
  notes: string[];
}

export type CoverageSummary = Omit<CoverageManifest, "files" | "notes">;

export interface SubagentCoverageTracker {
  readonly required: boolean;
  applyDeclaration(declaration?: CompleteTaskCoverageDeclaration): string[];
  snapshot(): CoverageManifest;
}

export interface TaskCompletionControl {
  type: "task_completion";
  completion: CompleteTaskInput;
}

export interface SubagentRuntimeContext {
  rootSessionId: string;
  taskId: string;
  agentId: string;
  parentTaskId?: string;
  depth: number;
  completionSubmitted: boolean;
  onActivity?: (activity: string, toolName?: string) => void;
  coverage?: SubagentCoverageTracker;
}

export interface TaskArtifactPaths {
  task: string;
  result: string;
  report: string;
  transcript: string;
  coverage: string;
  taskDir: string;
}

export interface TaskSummary {
  taskId: string;
  agentId: string;
  rootSessionId: string;
  parentTaskId?: string;
  description: string;
  subagentType: string;
  dependency: SubagentDependency;
  status: SubagentTaskStatus;
  depth: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastActivityAt: number;
  currentActivity?: string;
  currentTool?: string;
  childCount: number;
  pinned?: boolean;
  artifacts: TaskArtifactPaths;
}

export interface TaskResult {
  taskId: string;
  agentId: string;
  status: SubagentTaskStatus;
  summary: string;
  reportPath: string;
  resultPath: string;
  transcriptPath: string;
  coveragePath: string;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  error?: string;
  keyFiles?: string[];
  artifacts?: Array<{ path: string; description: string }>;
  coverage?: CoverageSummary;
  startedAt?: number;
  endedAt: number;
}

export interface TaskDetail extends TaskSummary {
  prompt: string;
  result?: TaskResult;
}

export interface TaskFilter {
  status?: SubagentTaskStatus;
}

export interface TaskService {
  list(filter?: TaskFilter): TaskSummary[];
  get(taskId: string): TaskDetail | undefined;
  wait(taskId: string, timeoutMs?: number): Promise<TaskResult>;
  cancel(taskId: string, cascade?: boolean): Promise<void>;
  cleanup(taskId: string): Promise<void>;
}

export interface SubagentResult {
  status: SubagentTaskStatus | "timeout" | "budget_exceeded";
  agentId: string;
  taskId?: string;
  output: string;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  /** Stable path containing the complete final report. */
  resultPath?: string;
  /** Stable path containing the multi-turn execution transcript. */
  transcriptPath?: string;
  /** Runtime-observed exhaustive coverage manifest. */
  coveragePath?: string;
  /** Machine-extractable summary (for parent agent to merge). */
  summary?: string;
  /** Files modified by this subagent. */
  filesChanged?: string[];
  reportPath?: string;
  resultJsonPath?: string;
  workspace?: null;
  patch?: null;
}
