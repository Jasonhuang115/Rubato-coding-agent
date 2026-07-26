import type { Interface as ReadlineInterface } from "readline";
import { emitKeypressEvents } from "readline";
import type { EventEmitter } from "events";

type LineInput = Pick<
  ReadlineInterface,
  "on" | "removeListener" | "setPrompt" | "prompt"
>;

export interface MultiLineInputOptions {
  /**
   * A terminal paste emits all of its `line` events in one short burst. Waiting
   * for a small quiet window lets us collect the whole paste while preserving
   * the normal one-line Enter-to-send interaction.
   */
  pasteSettleMs?: number;
  /** Override streams for tests or non-standard terminals. */
  input?: EventEmitter & { isTTY?: boolean };
  output?: { write(chunk: string): unknown; isTTY?: boolean };
}

/**
 * Read one interactive submission, including a multi-line terminal paste.
 *
 * The line listener is installed before the prompt is rendered. This is
 * important: `readline.question()` invokes its callback after the first line,
 * by which time the remaining lines of a fast paste may already have been
 * emitted and lost.
 */
export function readMultiLineInput(
  rl: LineInput,
  promptText: string,
  signal?: AbortSignal,
  options: MultiLineInputOptions = {},
): Promise<string | null> {
  // Some terminals throttle large Unicode pastes and can leave more than
  // 100 ms between emitted lines. A half-second quiet window is still
  // effectively immediate for a single Enter, while avoiding partial submits.
  const pasteSettleMs = options.pasteSettleMs ?? 500;
  const pasteInput = options.input ??
    (process.stdin.isTTY ? process.stdin : undefined);
  const pasteOutput = options.output ??
    (process.stdout.isTTY ? process.stdout : undefined);

  return new Promise((resolve) => {
    let settled = false;
    let bracketedPaste = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const lines: string[] = [];

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (settleTimer) clearTimeout(settleTimer);
      rl.removeListener("line", onLine);
      pasteInput?.removeListener("keypress", onKeypress);
      if (pasteOutput) pasteOutput.write("\u001b[?2004l");
      signal?.removeEventListener("abort", onAbort);
      rl.setPrompt("");
      resolve(value);
    };

    const scheduleFinish = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => finish(lines.join("\n")), pasteSettleMs);
    };

    const onLine = (raw: string) => {
      const line = raw.trimEnd();

      if (lines.length === 0 && !line.trim()) {
        finish("");
        return;
      }

      if (lines.length === 0 && line.trim().startsWith("/")) {
        finish(line.trim());
        return;
      }

      // Preserve blank lines inside a pasted prompt. The quiet window, rather
      // than the first blank line, marks the end of the submission.
      lines.push(line);
      if (!bracketedPaste) scheduleFinish();
    };

    const onKeypress = (
      _character: string | undefined,
      key: { name?: string } | undefined,
    ) => {
      if (key?.name === "paste-start") {
        bracketedPaste = true;
        if (settleTimer) clearTimeout(settleTimer);
      } else if (key?.name === "paste-end") {
        bracketedPaste = false;
        // The final pasted line may still be waiting for Enter, so retain the
        // quiet-window fallback after the deterministic paste boundary.
        if (lines.length > 0) scheduleFinish();
      }
    };

    const onAbort = () => finish(null);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      finish(null);
      return;
    }

    // Register first so no continuation line from a fast paste can race ahead
    // of the listener.
    rl.on("line", onLine);
    if (pasteInput && pasteOutput) {
      emitKeypressEvents(pasteInput as NodeJS.ReadableStream);
      pasteInput.on("keypress", onKeypress);
      pasteOutput.write("\u001b[?2004h");
    }
    rl.setPrompt(promptText);
    rl.prompt();
  });
}
