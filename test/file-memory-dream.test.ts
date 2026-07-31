import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  failDream,
  leaseNextDream,
  listDreamRuns,
  markDreamProduced,
  markDreamPublished,
  markDreamRunning,
  markDreamValidated,
  queueDream,
  recoverExpiredDreams,
  shouldQueueDream,
} from "../src/memory-files/dream.js";

describe("file memory Dream queue", () => {
  let dreamsDir = "";

  beforeEach(() => {
    dreamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-dream-"));
  });

  afterEach(() => {
    fs.rmSync(dreamsDir, { recursive: true, force: true });
  });

  it("is idempotent by input digest and follows the publish state machine", () => {
    const input = {
      scope: "global" as const,
      reason: "threshold",
      observation_ids: ["obs-2", "obs-1"],
      candidate_ids: ["candidate-1"],
    };
    const first = queueDream(dreamsDir, input);
    const duplicate = queueDream(dreamsDir, {
      ...input,
      observation_ids: ["obs-1", "obs-2"],
    });
    expect(duplicate.run_id).toBe(first.run_id);

    const leased = leaseNextDream(dreamsDir, "worker-1", 15);
    expect(leased?.status).toBe("leased");
    expect(markDreamRunning(dreamsDir, first.run_id, "worker-1").status)
      .toBe("running");
    expect(markDreamProduced(dreamsDir, first.run_id, [{ operation: "NOOP" }]).status)
      .toBe("produced");
    expect(markDreamValidated(dreamsDir, first.run_id).status)
      .toBe("validated");
    expect(markDreamPublished(dreamsDir, first.run_id, "release-1").status)
      .toBe("published");
    expect(listDreamRuns(dreamsDir)).toHaveLength(1);
  });

  it("recovers expired leases and eventually requires review", () => {
    const run = queueDream(dreamsDir, {
      scope: "project",
      project_id: "project-1",
      reason: "manual",
      observation_ids: ["obs-1"],
      candidate_ids: [],
      max_retries: 0,
    });
    leaseNextDream(dreamsDir, "dead-worker", 1, new Date(0));
    const recovered = recoverExpiredDreams(dreamsDir, new Date(120_000));
    expect(recovered[0]).toMatchObject({
      run_id: run.run_id,
      status: "needs_review",
      review_reason: "retry_limit_exceeded",
    });
  });

  it("does not queue merely because time passed without new observations", () => {
    expect(shouldQueueDream({
      newly_closed_sessions: 0,
      pending_candidates: 0,
      oldest_observation_age_hours: 100,
      has_new_observations: false,
    }, {
      closed_sessions: 5,
      pending_candidates: 20,
      observation_age_hours: 24,
    }).queue).toBe(false);
  });

  it("requeues a transient worker failure within the retry budget", () => {
    const run = queueDream(dreamsDir, {
      scope: "global",
      reason: "manual",
      observation_ids: ["obs-1"],
      candidate_ids: [],
      max_retries: 3,
    });
    leaseNextDream(dreamsDir, "worker");
    expect(failDream(dreamsDir, run.run_id, "temporary").status).toBe("queued");
  });
});
