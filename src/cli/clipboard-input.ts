import { execFileSync } from "child_process";

export type ClipboardReader = () => string;

function readMacClipboard(): string {
  return execFileSync("pbpaste", [], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Read a prompt only after the user explicitly invokes `/paste`.
 * Clipboard contents are never accessed during ordinary CLI input.
 */
export function readClipboardPrompt(
  read: ClipboardReader = readMacClipboard,
): string {
  const prompt = read()
    .replace(/\r\n?/g, "\n")
    .trimEnd();

  if (!prompt.trim()) {
    throw new Error("Clipboard does not contain any text.");
  }

  return prompt;
}
