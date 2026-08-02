// SessionMeta management — tracks session metadata

import type { SessionMeta } from "../../shared/core-types.js";

export function createSessionMeta(
  id: string,
  model: string,
  branch?: string,
  opts?: {
    firstMessage?: string;
    status?: "active" | "ended";
  }
): SessionMeta {
  return {
    id,
    timestamp: Date.now(),
    model,
    totalTokens: 0,
    duration: 0,
    branch: branch ?? "unknown",
    firstMessage: opts?.firstMessage,
    status: opts?.status ?? "active",
    messageCount: 0,
  };
}

export function finalizeSessionMeta(meta: SessionMeta): SessionMeta {
  return {
    ...meta,
    duration: Date.now() - meta.timestamp,
    timestamp: Date.now(),
  };
}
