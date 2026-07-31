import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendMemoryControlEvent,
  controlEventPath,
  listMemoryControlEvents,
  rewriteMemoryControlEvents,
} from "../src/memory-files/control-events.js";

describe("memory user-control evidence", () => {
  let root = "";
  let project = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-control-events-"));
    project = path.join(root, "project");
    fs.mkdirSync(project);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("appends correction commands to a verifiable hash chain", () => {
    const first = appendMemoryControlEvent({
      action: "correct",
      workingDir: project,
      target: "communication.language",
      value: "zh",
      rootDir: root,
      occurredAt: "2026-07-31T00:00:00.000Z",
    });
    const second = appendMemoryControlEvent({
      action: "retire",
      workingDir: project,
      target: "communication.language",
      rootDir: root,
      occurredAt: "2026-07-31T01:00:00.000Z",
    });

    expect(second.prev_hash).toBe(first.hash);
    expect(listMemoryControlEvents(root)).toEqual([first, second]);
  });

  it("supports a privacy-only rewrite with a newly valid chain", () => {
    appendMemoryControlEvent({
      action: "correct",
      workingDir: project,
      target: "private.key",
      value: "forgotten value",
      rootDir: root,
    });
    const retained = appendMemoryControlEvent({
      action: "pause_learning",
      workingDir: project,
      rootDir: root,
    });
    const { seq: _seq, prev_hash: _prev, hash: _hash, ...event } = retained;
    rewriteMemoryControlEvents([event], root);

    const rebuilt = listMemoryControlEvents(root);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({
      action: "pause_learning",
      seq: 0,
      prev_hash: null,
    });
    expect(fs.readFileSync(controlEventPath(root), "utf8"))
      .not.toContain("forgotten value");
  });
});
