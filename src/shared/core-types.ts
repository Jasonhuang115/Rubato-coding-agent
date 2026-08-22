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
  control?: AgentControl;
}

// ---- Agent context (passed to every tool) ----

export interface AgentContext {
  workingDir: string;
  /** Stable root project identity used for project-scoped state and memory. */
  projectId?: string;
  /** Stable across --continue/--resume. */
  conversationId?: string;
  /** Current agent-loop execution identifier. */
  runId?: string;
  sessionId: string;
  readGuard: ReadGuardState;
  permissionManager: PermissionManager;
  config: AgentConfig;
  mode: AgentMode;
  /** Recursion depth. 0 = root agent. */
  depth: number;
  /** Present only while a managed subagent task is running. */
  taskRuntime?: SubagentRuntimeContext;
  /** Per-agent cancellation signal. */
  abortSignal?: AbortSignal;
  /** Root-session permission prompt used by foreground and background subagents. */
  onConfirmTool?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<ConfirmDecision>;
  /** Root-only runtime backstop for explicit parallel multi-scope requests. */
  delegationGate?: {
    prepareTurn(toolCalls: Array<{
      name: string;
      input: Record<string, unknown>;
    }>): void;
    check(toolName: string, input: Record<string, unknown>): string | null;
    recordToolResult(toolName: string, succeeded: boolean): void;
    observeUserMessage(message: string): void;
  };
}

export type AgentMode = "default" | "plan";
export type PlanPhase = "planning" | "awaiting_approval";

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
    contextWindow?: number; // working context window override
    maxTokens?: number;     // output cap; also used as compaction output reserve
  };
  permissions: {
    bash: PermissionMode;
    read: PermissionMode;
    write: PermissionMode;
    edit: PermissionMode;
    web: PermissionMode;
    rules?: PermissionRule[];
  };
  memory?: {
    /** Master switch for agent-managed file memory. */
    enabled: boolean;
    /** Mid-term technical decisions scoped to the current project. */
    projectEnabled: boolean;
    /** Long-term user preferences shared across projects. */
    userEnabled: boolean;
  };
  session: {
    cleanupPeriodDays: number;
  };
  subagents?: Partial<SubagentLimits>;
  worktree?: {
    baseRef: "fresh" | "head";
  };
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

// ---- Subagent ----

export interface SubagentDefinition {
  name: string;               // "explore" | "general" | "verify" | custom
  description: string;        // used for intent-matching
  systemPrompt: string;
  model?: string;             // "inherit" | specific model ID
  tools: string[];            // allowlist, ["*"] = the safe capability set
  /** Legacy compatibility hint. Tool access is enforced from tools + isolation. */
  readonly: boolean;
  isolation?: "worktree";
}

export type SubagentTaskStatus =
  | "queued"
  | "running"
  | "finished"
  | "failed";

export type SubagentFailureKind =
  | "cancelled"
  | "timed_out"
  | "model_error"
  | "empty_report"
  | "coverage_incomplete"
  | "worktree_invalid"
  | "runtime_error"
  | "interrupted";

export interface SubagentLimits {
  maxConcurrent: number;
  maxWriteConcurrent: number;
  maxTasksPerSession: number;
  artifactTtlDays: number;
  artifactSoftLimitBytes: number;
}

export interface AgentTaskInput {
  description: string;
  prompt: string;
  subagent_type?: string;
  model?: string;
  timeout_ms: number;
  isolation?: "worktree";
  scope?: string[];
  /** Inherited runtime mode; used to keep Plan exploration read-only. */
  mode?: AgentMode;
  /**
   * `exhaustive` enables a runtime-enforced file/line coverage gate.
   * `auto` (the default) also enables it when the task wording promises
   * exhaustive or every-line inspection.
   */
  coverage?: "auto" | "exhaustive";
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
  snapshot(): CoverageManifest;
}

export interface PlanReadyControl {
  type: "plan_ready";
  title: string;
  markdown: string;
  path: string;
}

export type AgentControl = PlanReadyControl;

export interface SubagentRuntimeContext {
  rootSessionId: string;
  taskId: string;
  agentId: string;
  onActivity?: (activity: string, toolName?: string) => void;
  onTextDelta?: (text: string) => void;
  onTextFlush?: () => void;
  coverage?: SubagentCoverageTracker;
}

export interface TaskArtifactPaths {
  task: string;
  result: string;
  report: string;
  transcript: string;
  coverage: string;
  patch: string;
  taskDir: string;
}

export interface TaskWorkspace {
  path: string;
  branch: string;
  baseCommit: string;
  repoRoot: string;
  locked: boolean;
  createdAt: number;
  sourceDirty: boolean;
}

export interface WorkspaceResult extends TaskWorkspace {
  headCommit: string;
  commits: string[];
  filesChanged: string[];
  dirty: boolean;
  patchPath: string;
  scopeDeviations: string[];
}

export interface TaskSummary {
  taskId: string;
  agentId: string;
  rootSessionId: string;
  description: string;
  subagentType: string;
  status: SubagentTaskStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastActivityAt: number;
  currentActivity?: string;
  currentTool?: string;
  failureKind?: SubagentFailureKind;
  error?: string;
  pinned?: boolean;
  scope?: string[];
  workspace?: TaskWorkspace;
  artifacts: TaskArtifactPaths;
}

export interface TaskResult {
  taskId: string;
  agentId: string;
  status: SubagentTaskStatus;
  failureKind?: SubagentFailureKind;
  reportPath: string;
  resultPath: string;
  transcriptPath: string;
  coveragePath: string;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  error?: string;
  coverage?: CoverageSummary;
  workspace?: WorkspaceResult;
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
  cancel(taskId: string): Promise<void>;
  cleanup(taskId: string): Promise<void>;
}
