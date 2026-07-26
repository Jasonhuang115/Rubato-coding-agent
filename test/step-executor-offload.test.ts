import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { offloadIfLarge } from "../src/runtime/step-executor.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const filePath of createdFiles.splice(0)) {
    fs.rmSync(filePath, { force: true });
  }
});

describe("large tool-result offloading", () => {
  it("deduplicates identical output and does not offload an offloaded Read again", () => {
    const content = `unique-${Date.now()}-${"x".repeat(31_000)}`;
    const first = offloadIfLarge(content, "Glob", { pattern: "**/*" });
    const filePath = first.match(/offloaded to (\/tmp\/rubato-tool-results\/[^}\]\n]+)/)?.[1];
    expect(filePath).toBeTruthy();
    createdFiles.push(filePath!);
    expect(fs.readFileSync(filePath!, "utf8")).toBe(content);

    const duplicate = offloadIfLarge(content, "Glob", { pattern: "**/*" });
    expect(duplicate).toContain(filePath);

    const filesBeforeRead = new Set(fs.readdirSync(path.dirname(filePath!)));
    const readResult = offloadIfLarge(
      `File: ${filePath}\n${"numbered output\n".repeat(2_500)}`,
      "Read",
      { file_path: filePath },
    );
    const filesAfterRead = new Set(fs.readdirSync(path.dirname(filePath!)));

    expect(readResult).toContain(`remains at ${filePath}`);
    expect(readResult).toContain("use Grep or Read with offset/limit");
    expect(filesAfterRead).toEqual(filesBeforeRead);
  });
});
