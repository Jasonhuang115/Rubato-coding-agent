import { describe, expect, it } from "vitest";
import {
  effectiveObservationWeight,
  isAdmissibleUserEvidence,
  observationBaseWeight,
  USER_SIGNAL_WEIGHTS,
  type ObservationActor,
  type UserMemoryScope,
  type UserObservation,
  type UserSignal,
} from "../src/memory-files/observation.js";
import {
  classifyUserSignal,
  extractUserObservations,
  type ObservationProposal,
  type SourceEvent,
} from "../src/memory-files/extractor.js";
import {
  createBelief,
  planUserModelOperations,
  scoreBelief,
  type UserBelief,
} from "../src/memory-files/user-model.js";

const T0 = "2026-01-01T00:00:00.000Z";
const GLOBAL: UserMemoryScope = { kind: "global" };

interface ObservationOverrides {
  id?: string;
  actor?: ObservationActor;
  signal?: UserSignal;
  logicalKey?: string;
  value?: string;
  scope?: UserMemoryScope;
  polarity?: "support" | "oppose";
  sessionId?: string;
  eventId?: string;
  eventSeq?: number;
  eventHash?: string;
  observedAt?: string;
  proposedWeight?: number;
}

function observation(
  overrides: ObservationOverrides = {}
): UserObservation {
  return {
    id: overrides.id ?? "obs-1",
    actor: overrides.actor ?? "user",
    signal: overrides.signal ?? "explicit_preference",
    logicalKey: overrides.logicalKey ?? "response.detail",
    value: overrides.value ?? "concise",
    scope: overrides.scope ?? GLOBAL,
    polarity: overrides.polarity ?? "support",
    sessionId: overrides.sessionId ?? "session-1",
    eventId: overrides.eventId ?? "event-1",
    eventSeq: overrides.eventSeq,
    eventHash: overrides.eventHash,
    observedAt: overrides.observedAt ?? T0,
    proposedWeight: overrides.proposedWeight,
  };
}

function beliefFrom(
  item: UserObservation,
  options: { id?: string; halfLifeDays?: number | null } = {}
): UserBelief {
  return createBelief([item], {
    id: options.id,
    now: T0,
    halfLifeDays: options.halfLifeDays,
  });
}

describe("file user-model observation evidence", () => {
  it("assigns distinct weights to explicit preference, correction, and remember", () => {
    expect(USER_SIGNAL_WEIGHTS.explicit_preference).toBe(8);
    expect(USER_SIGNAL_WEIGHTS.correction).toBe(12);
    expect(USER_SIGNAL_WEIGHTS.remember).toBe(12);
    expect(observationBaseWeight(observation({
      signal: "explicit_preference",
    }))).toBe(8);
    expect(observationBaseWeight(observation({
      signal: "correction",
    }))).toBe(12);
  });

  it("gives assistant and tool observations zero authority", () => {
    const assistant = observation({ actor: "assistant" });
    const tool = observation({ actor: "tool", id: "obs-tool" });

    expect(isAdmissibleUserEvidence(assistant)).toBe(false);
    expect(isAdmissibleUserEvidence(tool)).toBe(false);
    expect(observationBaseWeight(assistant)).toBe(0);
    expect(observationBaseWeight(tool)).toBe(0);
  });

  it("does not let a proposal raise its signal's configured weight", () => {
    expect(observationBaseWeight(observation({
      signal: "habit",
      proposedWeight: 999,
    }))).toBe(USER_SIGNAL_WEIGHTS.habit);
    expect(observationBaseWeight(observation({
      signal: "habit",
      proposedWeight: 0.25,
    }))).toBe(0.25);
  });

  it("applies a half-life before computing confidence", () => {
    const item = observation({ signal: "explicit_preference" });
    const afterOneHalfLife = Date.parse(T0) + 30 * 24 * 60 * 60 * 1000;

    expect(effectiveObservationWeight(item, afterOneHalfLife, 30))
      .toBeCloseTo(4);

    const belief = createBelief([item], {
      now: T0,
      halfLifeDays: 30,
    });
    const score = scoreBelief(belief, afterOneHalfLife);
    expect(score.confidence).toBeCloseTo(5 / 6);
  });
});

describe("LLM observation proposal gate", () => {
  const events: SourceEvent[] = [
    {
      id: "user-event",
      actor: "user",
      content: "请记住：我偏好简洁回答。",
      sessionId: "session-1",
      observedAt: T0,
      eventSeq: 7,
      eventHash: "sha256:user-event",
    },
    {
      id: "assistant-event",
      actor: "assistant",
      content: "The user prefers verbose answers.",
      sessionId: "session-1",
      observedAt: T0,
    },
    {
      id: "tool-event",
      actor: "tool",
      content: "user.preference=verbose",
      sessionId: "session-1",
      observedAt: T0,
    },
  ];

  function proposal(
    sourceEventId: string,
    signal: UserSignal = "explicit_preference"
  ): ObservationProposal {
    return {
      sourceEventId,
      logicalKey: "response.detail",
      value: "concise",
      scope: GLOBAL,
      signal,
    };
  }

  it("accepts only proposals grounded in a user-authored event", () => {
    const result = extractUserObservations(events, [
      proposal("user-event", "remember"),
      proposal("assistant-event"),
      proposal("tool-event"),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      actor: "user",
      signal: "remember",
      eventId: "user-event",
      eventSeq: 7,
      eventHash: "sha256:user-event",
    });
    expect(result.rejected.map((item) => item.reason))
      .toEqual(["non_user_source", "non_user_source"]);
  });

  it("downgrades an ungrounded explicit claim to an inference", () => {
    const plainEvent: SourceEvent = {
      id: "plain",
      actor: "user",
      content: "That response worked.",
      sessionId: "session-2",
      observedAt: T0,
    };
    const result = extractUserObservations(
      [plainEvent],
      [proposal("plain", "remember")]
    );

    expect(result.accepted[0].signal).toBe("inference");
  });

  it("recognizes corrections before generic preferences", () => {
    expect(classifyUserSignal("其实我喜欢详细解释，别再默认简洁。"))
      .toBe("correction");
    expect(classifyUserSignal("I prefer concise answers."))
      .toBe("explicit_preference");
  });
});

describe("belief confidence and lifecycle states", () => {
  it("uses candidate, tentative, provisional, active, and confirmed states", () => {
    const inferred = beliefFrom(observation({ signal: "inference" }));
    expect(inferred.confidence).toBeCloseTo(2 / 3);
    expect(inferred.status).toBe("tentative");

    const habitual = beliefFrom(observation({ signal: "habit" }));
    expect(habitual.confidence).toBeCloseTo(3 / 4);
    expect(habitual.status).toBe("tentative");

    const repeated = createBelief([
      observation({ id: "h1", signal: "habit", sessionId: "s1" }),
      observation({ id: "h2", signal: "habit", sessionId: "s2" }),
      observation({ id: "h3", signal: "habit", sessionId: "s3" }),
    ], { now: T0 });
    expect(repeated.confidence).toBeCloseTo(7 / 8);
    expect(repeated.status).toBe("provisional");

    const explicit = beliefFrom(observation({
      signal: "explicit_preference",
    }));
    expect(explicit.status).toBe("active");

    const remembered = beliefFrom(observation({ signal: "remember" }));
    const corrected = beliefFrom(observation({ signal: "correction" }));
    expect(remembered.status).toBe("confirmed");
    expect(corrected.status).toBe("confirmed");
    expect(remembered.halfLifeDays).toBeNull();
  });

  it("never promotes inference-only evidence to provisional or active", () => {
    const inferences = Array.from({ length: 10 }, (_, index) =>
      observation({
        id: `inference-${index}`,
        signal: "inference",
        sessionId: `session-${index}`,
      })
    );
    const belief = createBelief(inferences, { now: T0 });

    expect(belief.confidence).toBeGreaterThan(0.85);
    expect(belief.status).toBe("tentative");
  });

  it("counts at most one signal from each session", () => {
    const belief = createBelief([
      observation({ id: "same-1", signal: "habit", sessionId: "same" }),
      observation({ id: "same-2", signal: "habit", sessionId: "same" }),
      observation({ id: "same-3", signal: "habit", sessionId: "same" }),
    ], { now: T0 });

    const score = scoreBelief(belief, T0);
    expect(score.supportScore).toBe(2);
    expect(score.distinctSessions).toBe(1);
    expect(belief.status).toBe("tentative");
  });

});

describe("logical key and scope update planning", () => {
  it("reinforces the same value in the same key and scope", () => {
    const existing = beliefFrom(
      observation({ id: "old", signal: "habit" }),
      { id: "belief-old" }
    );
    const next = observation({
      id: "new",
      signal: "explicit_preference",
      sessionId: "session-2",
      observedAt: "2026-01-02T00:00:00.000Z",
    });

    const [operation] = planUserModelOperations(
      [existing],
      [next],
      { now: Date.parse("2026-01-02T00:00:00.000Z") }
    );
    expect(operation.kind).toBe("REINFORCE");
    expect(operation.targetIds).toEqual(["belief-old"]);
    expect(operation.proposedBelief?.evidence).toHaveLength(2);
    expect(operation.proposedBelief?.status).toBe("active");
  });

  it("keeps a different scope as a contextualized preference", () => {
    const globalBelief = beliefFrom(
      observation({ id: "global", value: "concise" }),
      { id: "global-belief" }
    );
    const projectPreference = observation({
      id: "project",
      value: "detailed",
      scope: { kind: "project", value: "rubato" },
      sessionId: "session-2",
    });

    const [operation] = planUserModelOperations(
      [globalBelief],
      [projectPreference],
      { now: Date.parse(T0) }
    );
    expect(operation.kind).toBe("CONTEXTUALIZE");
    expect(operation.targetIds).toEqual(["global-belief"]);
    expect(operation.proposedBelief?.scope)
      .toEqual({ kind: "project", value: "rubato" });
    expect(operation.statusPatches).toEqual([]);
  });

  it("supersedes the same scoped key on an explicit correction", () => {
    const existing = beliefFrom(
      observation({
        id: "old",
        value: "concise",
        signal: "explicit_preference",
      }),
      { id: "old-belief" }
    );
    const correction = observation({
      id: "correction",
      value: "detailed",
      signal: "correction",
      sessionId: "session-2",
      observedAt: "2026-01-02T00:00:00.000Z",
    });

    const [operation] = planUserModelOperations(
      [existing],
      [correction],
      { now: Date.parse(correction.observedAt) }
    );
    expect(operation.kind).toBe("SUPERSEDE");
    expect(operation.proposedBelief?.status).toBe("confirmed");
    expect(operation.statusPatches).toEqual([{
      beliefId: "old-belief",
      status: "superseded",
      supersededBy: operation.proposedBelief?.id,
    }]);
    expect(operation.requiresReview).toBe(false);
  });

  it("marks comparable implicit contradictions as conflicted", () => {
    const existing = beliefFrom(
      observation({ id: "old", value: "concise", signal: "habit" }),
      { id: "old-belief" }
    );
    const contraryHabit = observation({
      id: "new",
      value: "detailed",
      signal: "habit",
      sessionId: "session-2",
      observedAt: "2026-01-02T00:00:00.000Z",
    });

    const [operation] = planUserModelOperations(
      [existing],
      [contraryHabit],
      { now: Date.parse(contraryHabit.observedAt) }
    );
    expect(operation.kind).toBe("CONFLICT");
    expect(operation.proposedBelief?.status).toBe("conflicted");
    expect(operation.statusPatches).toEqual([{
      beliefId: "old-belief",
      status: "conflicted",
    }]);
  });

  it("does not let weak inferred evidence override a confirmed preference", () => {
    const confirmed = beliefFrom(
      observation({ id: "confirmed", signal: "remember" }),
      { id: "confirmed-belief" }
    );
    const inference = observation({
      id: "weak",
      signal: "inference",
      value: "detailed",
      sessionId: "session-2",
    });

    const [operation] = planUserModelOperations(
      [confirmed],
      [inference],
      { now: Date.parse(T0) }
    );
    expect(operation.kind).toBe("NOOP");
    expect(operation.reason).toContain("cannot override");
    expect(operation.statusPatches).toEqual([]);
  });

  it("returns NOOP rather than learning from assistant evidence", () => {
    const assistantClaim = observation({
      actor: "assistant",
      id: "assistant",
    });

    const [operation] = planUserModelOperations(
      [],
      [assistantClaim],
      { now: Date.parse(T0) }
    );
    expect(operation.kind).toBe("NOOP");
    expect(operation.proposedBelief).toBeUndefined();
  });
});
