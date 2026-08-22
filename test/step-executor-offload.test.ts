import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { offloadIfLarge } from "../src/context/tool-result-offload.js";

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("large tool-result offloading", () => {
  it("deduplicates identical output and does not offload an offloaded Read again", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-offload-"));
    createdDirs.push(dir);
    const content = `unique-${Date.now()}-${"x".repeat(31_000)}`;
    const first = offloadIfLarge(content, "Glob", { pattern: "**/*" }, dir);
    const filePath = first.match(/offloaded to ([^\s\]]+)/)?.[1];
    expect(filePath).toBeTruthy();
    expect(filePath?.startsWith(dir)).toBe(true);
    expect(fs.readFileSync(filePath!, "utf8")).toBe(content);

    const duplicate = offloadIfLarge(content, "Glob", { pattern: "**/*" }, dir);
    expect(duplicate).toContain(filePath);

    const filesBeforeRead = new Set(fs.readdirSync(dir));
    const readResult = offloadIfLarge(
      `File: ${filePath}\n${"numbered output\n".repeat(2_500)}`,
      "Read",
      { file_path: filePath },
      dir,
    );
    const filesAfterRead = new Set(fs.readdirSync(dir));

    expect(readResult).toContain(`remains at ${filePath}`);
    expect(readResult).toContain("use Grep or Read with offset/limit");
    expect(filesAfterRead).toEqual(filesBeforeRead);
  });
});
