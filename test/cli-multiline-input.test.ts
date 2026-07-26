import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { readMultiLineInput } from "../src/cli/multiline-input.js";

class FakeReadline extends EventEmitter {
  promptText = "";
  promptCalls = 0;

  setPrompt(value: string): void {
    this.promptText = value;
  }

  prompt(): void {
    this.promptCalls += 1;
  }
}

describe("readMultiLineInput", () => {
  it("collects every line of a fast multi-line paste, including blank lines", async () => {
    vi.useFakeTimers();
    const rl = new FakeReadline();
    const result = readMultiLineInput(rl, "\n▸ You: ", undefined, { pasteSettleMs: 25 });

    rl.emit("line", "first line");
    rl.emit("line", "");
    rl.emit("line", "third line");
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toBe("first line\n\nthird line");
    expect(rl.listenerCount("line")).toBe(0);
    vi.useRealTimers();
  });

  it("submits a normal single line after the quiet window", async () => {
    vi.useFakeTimers();
    const rl = new FakeReadline();
    const result = readMultiLineInput(rl, "prompt", undefined, { pasteSettleMs: 25 });

    rl.emit("line", "hello");
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toBe("hello");
    vi.useRealTimers();
  });

  it("does not split a terminal paste that emits continuation lines slowly", async () => {
    vi.useFakeTimers();
    const rl = new FakeReadline();
    const result = readMultiLineInput(rl, "prompt", undefined, { pasteSettleMs: 500 });

    rl.emit("line", "heading");
    await vi.advanceTimersByTimeAsync(180);
    rl.emit("line", "");
    await vi.advanceTimersByTimeAsync(180);
    rl.emit("line", "1. first requirement");
    await vi.advanceTimersByTimeAsync(499);

    let resolved = false;
    void result.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("heading\n\n1. first requirement");
    vi.useRealTimers();
  });

  it("uses bracketed-paste boundaries instead of timing for arbitrarily slow pastes", async () => {
    vi.useFakeTimers();
    const rl = new FakeReadline();
    const input = new EventEmitter() as EventEmitter & { isTTY?: boolean };
    input.isTTY = true;
    const writes: string[] = [];
    const output = {
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk);
      },
    };
    const result = readMultiLineInput(rl, "prompt", undefined, {
      pasteSettleMs: 25,
      input,
      output,
    });

    input.emit("keypress", undefined, { name: "paste-start" });
    rl.emit("line", "heading");
    await vi.advanceTimersByTimeAsync(2_000);
    rl.emit("line", "");
    await vi.advanceTimersByTimeAsync(2_000);
    rl.emit("line", "last requirement");

    let resolved = false;
    void result.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    input.emit("keypress", undefined, { name: "paste-end" });
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toBe("heading\n\nlast requirement");
    expect(writes).toEqual(["\u001b[?2004h", "\u001b[?2004l"]);
    vi.useRealTimers();
  });

  it("submits slash commands immediately", async () => {
    const rl = new FakeReadline();
    const result = readMultiLineInput(rl, "prompt");

    rl.emit("line", "  /tasks  ");

    await expect(result).resolves.toBe("/tasks");
  });

  it("returns null when aborted without leaving a line listener", async () => {
    const rl = new FakeReadline();
    const controller = new AbortController();
    const result = readMultiLineInput(rl, "prompt", controller.signal);

    controller.abort();

    await expect(result).resolves.toBeNull();
    expect(rl.listenerCount("line")).toBe(0);
  });
});
