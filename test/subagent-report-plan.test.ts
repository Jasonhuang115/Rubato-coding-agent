import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  PLAN_END_MARKER,
  PLAN_PLACEHOLDER_ITEM,
  PLAN_START_MARKER,
} from "../src/agent/subagents/artifact-store.js";
import { GENERAL_DEF } from "../src/agent/subagent.js";
import { buildSubagentStaticPrompt } from "../src/prompt/static.js";
import type { TaskDetail } from "../src/shared/core-types.js";

describe("subagent Plan/Report artifacts", () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-report-root-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-report-home-"));
    process.env.RUBATO_HOME = home;
  });

  afterEach(() => {
    delete process.env.RUBATO_HOME;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("seeds Plan and Report sections and keeps appends in Report", () => {
    const store = new ArtifactStore(root, "session", home);
    const task = makeTask(store, "task-one");
    store.initializeTask(task, { timeoutMs: 60_000 });
    const seeded = fs.readFileSync(task.artifacts.report, "utf8");
    expect(seeded).toContain(PLAN_START_MARKER);
    expect(seeded).toContain("## Plan");
    expect(seeded).toContain(PLAN_PLACEHOLDER_ITEM);
    expect(seeded).toContain(PLAN_END_MARKER);
    expect(seeded).toContain("## Report");

    store.appendReport(task.taskId, "first finding\n");
    store.editReport(
      task.artifacts.report,
      PLAN_PLACEHOLDER_ITEM,
      "- [x] inspect the module",
    );
    store.appendReport(task.taskId, "second finding\n");
    const body = fs.readFileSync(task.artifacts.report, "utf8");
    expect(body).toContain("- [x] inspect the module");
    expect(body).toContain("first finding");
    expect(body).toContain("second finding");
    expect(body.indexOf("## Plan")).toBeLessThan(body.indexOf("## Report"));
    expect(body.indexOf("- [x] inspect the module")).toBeLessThan(body.indexOf("## Report"));
    expect(body.indexOf("first finding")).toBeGreaterThan(body.indexOf("## Report"));
  });

  it("reminds once when Report starts while Plan is still a placeholder", () => {
    const store = new ArtifactStore(root, "session", home);
    const task = makeTask(store, "task-two");
    store.initializeTask(task, { timeoutMs: 1_000 });
    store.appendReport(task.taskId, "premature conclusion\n");
    const reminder = store.takePlanReminder(task.artifacts.report);
    expect(reminder).toContain("placeholder");
    expect(store.takePlanReminder(task.artifacts.report)).toBeUndefined();
    expect(fs.readFileSync(task.artifacts.report, "utf8")).toContain("premature conclusion");
  });

  it("gives every subagent Edit and describes crash recovery in the static prompt", () => {
    expect(GENERAL_DEF.tools).toContain("Edit");
    expect(GENERAL_DEF.tools).not.toContain("Write");
    const prompt = buildSubagentStaticPrompt(GENERAL_DEF.systemPrompt, false);
    expect(prompt).toContain("report.md is durable");
    expect(prompt).toContain("first unchecked Plan item");
    expect(prompt).toContain("## Report is the deliverable");
  });
});

function makeTask(store: ArtifactStore, taskId: string): TaskDetail {
  const now = Date.now();
  return {
    taskId,
    agentId: `agent-${taskId}`,
    rootSessionId: "session",
    description: "plan report",
    prompt: "prompt",
    subagentType: "general",
    status: "queued",
    createdAt: now,
    lastActivityAt: now,
    artifacts: store.paths(taskId),
  };
}
