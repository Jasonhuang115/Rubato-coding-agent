import { describe, expect, it } from "vitest";
import { proposeFastUserObservations } from "../src/memory-files/fast-extractor.js";
import type { SourceEvent } from "../src/memory-files/extractor.js";

function event(content: string, id = "evt-1"): SourceEvent {
  return {
    id,
    actor: "user",
    content,
    sessionId: "session-1",
    observedAt: "2026-07-31T00:00:00.000Z",
    eventSeq: 1,
    eventHash: "a".repeat(64),
  };
}

describe("fast explicit memory extraction", () => {
  it("keeps one-off instructions in the current session only", () => {
    const result = proposeFastUserObservations([
      event("这次不要解释，直接给结论。"),
    ], { projectId: "project-1" });
    expect(result.proposals).toEqual([]);
    expect(result.skipped[0].reason).toBe("session_only");
  });

  it("extracts a standing architecture communication preference", () => {
    const result = proposeFastUserObservations([
      event("以后技术方案和架构讨论都要详细解释原因。"),
    ], { projectId: "project-1" });
    expect(result.proposals).toContainEqual(expect.objectContaining({
      logicalKey: "communication.explanation_depth",
      value: "detailed",
      scope: { kind: "domain", value: "architecture" },
      signal: "explicit_preference",
    }));
  });

  it("defaults a project observation to project scope", () => {
    const result = proposeFastUserObservations([
      event("我偏好用中文回答。"),
    ], { projectId: "project-1" });
    expect(result.proposals[0]).toMatchObject({
      logicalKey: "communication.language",
      value: "zh",
      scope: { kind: "project", value: "project-1" },
    });
  });

  it("requires explicit all-project wording before choosing global scope", () => {
    const result = proposeFastUserObservations([
      event("所有项目都默认用中文回答。"),
    ], { projectId: "project-1" });
    expect(result.proposals[0].scope).toEqual({ kind: "global" });
  });

  it("never fast-publishes sensitive or secret-bearing statements", () => {
    const result = proposeFastUserObservations([
      event("请记住 token=abc123456789012345"),
      event("请记住我的政治立场是某某", "evt-2"),
    ], { projectId: "project-1" });
    expect(result.proposals).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual([
      "sensitive",
      "sensitive",
    ]);
  });
});
