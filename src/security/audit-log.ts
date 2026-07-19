// Audit Log — records security-sensitive tool executions for later review.
// Each entry captures the tool, input, decision, timing, and outcome.
// In-memory ring buffer, configurable size (default 1000 entries).

export interface AuditEntry {
  timestamp: number;
  sessionId: string;
  toolName: string;
  inputPreview: string;       // first 200 chars of input
  verdict: string;
  risk: string;
  reason: string;
  outcome: string;
  latencyMs: number;
  workspaceRoot: string;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Record a security decision and its outcome.
   */
  record(entry: Omit<AuditEntry, "timestamp"> & { timestamp?: number }): void {
    const full: AuditEntry = {
      ...entry,
      timestamp: entry.timestamp ?? Date.now(),
    };

    this.entries.push(full);

    // Ring buffer: drop oldest entries when at capacity
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  /**
   * Get recent entries, optionally filtered by tool or verdict.
   */
  query(filter?: {
    toolName?: string;
    verdict?: string;
    sessionId?: string;
    maxEntries?: number;
  }): AuditEntry[] {
    let results = [...this.entries];

    if (filter?.toolName) {
      results = results.filter((e) => e.toolName === filter.toolName);
    }
    if (filter?.verdict) {
      results = results.filter((e) => e.verdict === filter.verdict);
    }
    if (filter?.sessionId) {
      results = results.filter((e) => e.sessionId === filter.sessionId);
    }

    const limit = filter?.maxEntries ?? 100;
    return results.slice(-limit);
  }

  /**
   * Get summary statistics.
   */
  stats(): {
    total: number;
    allowCount: number;
    warnCount: number;
    confirmCount: number;
    denyCount: number;
    topTools: Array<{ tool: string; count: number }>;
  } {
    const counts: Record<string, number> = {};
    let allowCount = 0, warnCount = 0, confirmCount = 0, denyCount = 0;

    for (const e of this.entries) {
      counts[e.toolName] = (counts[e.toolName] ?? 0) + 1;
      switch (e.verdict) {
        case "allow": allowCount++; break;
        case "warn": warnCount++; break;
        case "confirm": confirmCount++; break;
        case "deny": denyCount++; break;
      }
    }

    const topTools = Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([tool, count]) => ({ tool, count }));

    return { total: this.entries.length, allowCount, warnCount, confirmCount, denyCount, topTools };
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Get entry count.
   */
  get count(): number {
    return this.entries.length;
  }
}
