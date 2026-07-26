import { describe, expect, it } from "vitest";
import { readClipboardPrompt } from "../src/cli/clipboard-input.js";

describe("readClipboardPrompt", () => {
  it("preserves a complete multi-line prompt and internal blank lines", () => {
    const prompt = readClipboardPrompt(() =>
      "heading\r\n\r\n1. alpha\r\n2. beta\r\n",
    );

    expect(prompt).toBe("heading\n\n1. alpha\n2. beta");
  });

  it("rejects an empty clipboard", () => {
    expect(() => readClipboardPrompt(() => " \n\n")).toThrow(
      "Clipboard does not contain any text.",
    );
  });
});
