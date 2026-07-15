// SessionMeta management — tracks session metadata

import type { SessionMeta } from "../core-types.js";

export function createSessionMeta(
  id: string,
  model: string,
  branch?: string
): SessionMeta {
  return {
    id,
    timestamp: Date.now(),
    model,
    totalTokens: 0,
    duration: 0,
    branch: branch ?? "unknown",
    fileHistory: [],
  };
}

export function updateSessionMeta(
  meta: SessionMeta,
  updates: Partial<SessionMeta>
): SessionMeta {
  return { ...meta, ...updates };
}

export function recordFileAccess(meta: SessionMeta, filePath: string): void {
  if (!meta.fileHistory.includes(filePath)) {
    meta.fileHistory.push(filePath);
  }
}

export function addTokens(meta: SessionMeta, tokens: number): void {
  meta.totalTokens += tokens;
}

export function finalizeSessionMeta(meta: SessionMeta): SessionMeta {
  return {
    ...meta,
    duration: Date.now() - meta.timestamp,
    timestamp: Date.now(),
  };
}

// ---- Extension point: Phase 2 Mnemosyne consumer reads this meta ----

export interface MetaConsumer {
  consume(meta: SessionMeta): Promise<void>;
}

const consumers: MetaConsumer[] = [];

export function registerMetaConsumer(consumer: MetaConsumer): void {
  consumers.push(consumer);
}

export async function notifyConsumers(meta: SessionMeta): Promise<void> {
  for (const consumer of consumers) {
    try {
      await consumer.consume(meta);
    } catch {
      // Consumer errors shouldn't crash the session
    }
  }
}
