import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listMemoryAccessEvents,
  recordMemoryFileAccess,
  sessionMemoryAccess,
} from "../src/memory-files/access.js";

describe("file-memory access telemetry", () => {
  let root = "";
  let memoryRoot = "";
  let releaseDir = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-memory-access-"));
    memoryRoot = path.join(root, "memory");
    releaseDir = path.join(memoryRoot, "global", "releases", "rel-1");
    fs.mkdirSync(path.join(releaseDir, "cards"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("tracks grep and read separately without changing a memory card", () => {
    const cardPath = path.join(releaseDir, "cards", "pref-detail.md");
    fs.writeFileSync(cardPath, "immutable card\n", "utf8");
    const before = fs.readFileSync(cardPath, "utf8");

    recordMemoryFileAccess({
      sessionId: "session-1",
      action: "search",
      filePath: path.join(releaseDir, "catalog.tsv"),
      output:
        `${path.join(releaseDir, "catalog.tsv")}:2:pref-detail\t1\tcommunication.detail\n`,
    });
    recordMemoryFileAccess({
      sessionId: "session-1",
      action: "read",
      filePath: cardPath,
    });

    expect(fs.readFileSync(cardPath, "utf8")).toBe(before);
    expect(sessionMemoryAccess(memoryRoot, "session-1")).toEqual({
      searched: ["pref-detail"],
      read: ["pref-detail"],
    });
    expect(listMemoryAccessEvents(memoryRoot).map((event) => event.action))
      .toEqual(["search", "read"]);
  });

  it("ignores files outside a verified release", () => {
    expect(recordMemoryFileAccess({
      sessionId: "session-1",
      action: "read",
      filePath: path.join(memoryRoot, "candidates", "unsafe.md"),
    })).toBeNull();
    expect(listMemoryAccessEvents(memoryRoot)).toEqual([]);
  });
});
