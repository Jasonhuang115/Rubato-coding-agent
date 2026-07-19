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
}

// ---- Agent context (passed to every tool) ----

export interface BudgetManager {
  tryAllocate(depth: number): { allowed: boolean; reason?: string };
  releaseAgent(): void;
}

export interface AgentContext {
  workingDir: string;
  sessionId: string;
  readGuard: ReadGuardState;
  permissionManager: PermissionManager;
  config: AgentConfig;
  planManager?: PlanManager;
  /** Recursion depth. 0 = root agent. */
  depth: number;
  /** Global resource budget shared across the agent tree. */
  budgetManager?: BudgetManager;
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
    source: "local_onnx" | "api";
    model?: string;
  };
  mnemosyne: {
    bootstrap_on_first_open: boolean;
    bootstrap_max_files: number;
  };
  session: {
    cleanupPeriodDays: number;
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

export interface SubagentResult {
  status: "completed" | "failed" | "timeout" | "budget_exceeded";
  agentId: string;
  output: string;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  /** Machine-extractable summary (for parent agent to merge). */
  summary?: string;
  /** Files modified by this subagent. */
  filesChanged?: string[];
}
