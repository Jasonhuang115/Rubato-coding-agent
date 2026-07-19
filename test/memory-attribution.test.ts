import { describe, expect, it, vi } from "vitest";
import type { Message } from "../src/shared/core-types.js";
import type { EntityRow, InjectedMemory, MnemosyneStore } from "../src/memory/store.js";
import { attributeMemoryReferences, recordAttributedMemoryReferences } from "../src/memory/attribution.js";

function injected(
  id: number,
  name: string,
  content: string,
  query = "how should this work",
  retrievalSource = "fts5,vector",
): InjectedMemory {
  const entity: EntityRow = {
    id,
    type: "concept",
    name,
    content,
    source_session: "seed",
    source: "auto",
    protected: 0,
    tags: "",
    confidence: 1,
    created_at: 1,
    updated_at: 1,
    embedding: null,
    status: "active",
    superseded_by: null,
    abstracted_from: "",
    feedback_score: 0,
    access_count: 0,
  };
  return { entity, query, retrievalSource };
}

describe("memory reference attribution", () => {
  it("attributes exact names and distinctive implementation tokens", () => {
    const messages: Message[] = [{
      role: "assistant",
      content: [{ type: "text", text: "I wired AbortController into step-executor.ts and kept retries intact." }],
    }];
    const results = attributeMemoryReferences(messages, [
      injected(1, "AbortController lifecycle", "Cancellation is coordinated by step-executor.ts"),
      injected(2, "PostgreSQL pooling", "Use PgBouncer for transaction pooling"),
    ]);

    expect(results[0]).toMatchObject({ referenced: true, memoryId: 1 });
    expect(results[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(results[1]).toMatchObject({ referenced: false, memoryId: 2 });
  });

  it("does not use terms already present only in the retrieval query as evidence", () => {
    const messages: Message[] = [{ role: "assistant", content: "The database timeout is fixed." }];
    const results = attributeMemoryReferences(messages, [
      injected(3, "Connection recovery", "Set statement_timeout and retry with PgBouncer", "database timeout"),
    ]);
    expect(results[0].referenced).toBe(false);
  });

  it("writes high-confidence references back to the store", () => {
    const memory = injected(4, "RRF fusion", "Combine ranked lists with reciprocal rank fusion");
    const markReferenced = vi.fn();
    const store = {
      getInjectedMemoriesForSession: vi.fn(() => [memory]),
      markReferenced,
    } as unknown as MnemosyneStore;

    const results = recordAttributedMemoryReferences(
      [{ role: "assistant", content: "RRF fusion now combines all ranked lists." }],
      "session-4",
      store,
    );

    expect(results[0].referenced).toBe(true);
    expect(markReferenced).toHaveBeenCalledWith(
      4,
      "session-4",
      "fts5,vector",
      expect.objectContaining({ attribution: "deterministic" }),
    );
  });
});
