// Replay Engine — records and replays agent sessions.
// Every step (messages, tool calls, token usage) is persisted so sessions
// can be replayed with the same or different models for A/B comparison.
//
// Capabilities:
//   - Record: capture step-by-step execution state
//   - Replay: re-execute with same model (exact replay) or different model (A/B test)
//   - Resume: continue from a specific step

import fs from "fs";
import path from "path";
import type { Message, TokenUsage } from "../shared/core-types.js";

// ---- Types ----

export interface StepRecord {
  stepIndex: number;
  timestamp: number;
  /** Messages sent to the model this step. */
  messages: Message[];
  /** The system prompt used. */
  systemPrompt: string;
  /** Model response (text + tool_uses). */
  response?: {
    text: string;
    toolUses: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;
  };
  /** Token usage for the model call. */
  tokenUsage?: TokenUsage;
  /** Model call latency in ms. */
  latencyMs: number;
  /** Tool calls executed and their outputs. */
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    output: string;
    isError: boolean;
    latencyMs: number;
  }>;
  /** Working directory at this step. */
  workingDir: string;
}

export interface ReplaySession {
  sessionId: string;
  model: string;
  timestamp: number;
  steps: StepRecord[];
  metadata: {
    workingDir: string;
    provider: string;
    totalTurns: number;
  };
}

// ---- Replay Store ----

export class ReplayStore {
  private session: ReplaySession | null = null;
  private storageDir: string;

  constructor(storageDir?: string) {
    this.storageDir = storageDir ?? path.join(process.env.HOME ?? "/tmp", ".rubato/replays");
  }

  /**
   * Start recording a new session.
   */
  startRecording(sessionId: string, model: string, workingDir: string, provider: string): void {
    this.session = {
      sessionId,
      model,
      timestamp: Date.now(),
      steps: [],
      metadata: { workingDir, provider, totalTurns: 0 },
    };
  }

  /**
   * Record a completed step.
   */
  recordStep(step: StepRecord): void {
    if (!this.session) return;
    this.session.steps.push(step);
    this.session.metadata.totalTurns = this.session.steps.length;
  }

  /**
   * Save the recorded session to disk.
   */
  save(): string {
    if (!this.session) throw new Error("No session being recorded");

    fs.mkdirSync(this.storageDir, { recursive: true });
    const filePath = path.join(
      this.storageDir,
      `${this.session.sessionId}-${Date.now()}.replay.json`,
    );

    fs.writeFileSync(filePath, JSON.stringify(this.session, null, 2), "utf-8");
    return filePath;
  }

  /**
   * Load a session from disk.
   */
  load(filePath: string): ReplaySession {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ReplaySession;
  }

  /**
   * Get the current session (in-memory).
   */
  current(): ReplaySession | null {
    return this.session;
  }

  /**
   * Stop recording (doesn't save — call save() for that).
   */
  stopRecording(): void {
    this.session = null;
  }
}

// ---- Replay Utilities ----

/**
 * Build messages up to a given step (useful for resuming from step N).
 */
export function messagesUpToStep(session: ReplaySession, stepIndex: number): Message[] {
  const messages: Message[] = [];

  for (let i = 0; i < stepIndex && i < session.steps.length; i++) {
    const step = session.steps[i];
    // Add the assistant message
    if (step.response) {
      const blocks: Array<Record<string, unknown>> = [];
      if (step.response.text) {
        blocks.push({ type: "text", text: step.response.text });
      }
      for (const tu of step.response.toolUses) {
        blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      }
      messages.push({ role: "assistant", content: blocks as any });
    }

    // Add tool results
    for (const tc of step.toolCalls) {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "",
          content: tc.output,
          is_error: tc.isError,
        }],
      });
    }
  }

  return messages;
}

/**
 * Compare two replay sessions and return differences in tool choice, latency, and tokens.
 */
export function diffSessions(a: ReplaySession, b: ReplaySession): {
  toolChoiceDiff: string[];
  latencyDiff: number;
  tokenDiff: { input: number; output: number };
} {
  const toolChoiceDiff: string[] = [];
  const maxSteps = Math.max(a.steps.length, b.steps.length);

  for (let i = 0; i < maxSteps; i++) {
    const sa = a.steps[i];
    const sb = b.steps[i];

    if (sa && sb) {
      const aTools = sa.toolCalls.map((t) => t.name).join(",");
      const bTools = sb.toolCalls.map((t) => t.name).join(",");
      if (aTools !== bTools) {
        toolChoiceDiff.push(`Step ${i}: [A] ${aTools || "none"} vs [B] ${bTools || "none"}`);
      }
    }
  }

  let totalLatencyA = 0, totalLatencyB = 0;
  let inputA = 0, outputA = 0, inputB = 0, outputB = 0;

  for (const s of a.steps) {
    totalLatencyA += s.latencyMs;
    inputA += s.tokenUsage?.inputTokens ?? 0;
    outputA += s.tokenUsage?.outputTokens ?? 0;
  }
  for (const s of b.steps) {
    totalLatencyB += s.latencyMs;
    inputB += s.tokenUsage?.inputTokens ?? 0;
    outputB += s.tokenUsage?.outputTokens ?? 0;
  }

  return {
    toolChoiceDiff,
    latencyDiff: totalLatencyB - totalLatencyA,
    tokenDiff: { input: inputB - inputA, output: outputB - outputA },
  };
}
