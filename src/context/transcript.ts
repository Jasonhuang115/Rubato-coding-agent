import type { Message, StreamRenderer } from "../shared/core-types.js";

export const MAX_TRANSCRIPT_CHARS = 80_000;

export function serializeMessages(
  messages: Message[],
  maxChars = MAX_TRANSCRIPT_CHARS,
): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      chunks.push(`${message.role}: ${message.content}`);
      continue;
    }
    const parts = message.content.map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") {
        return `[${block.name} ${JSON.stringify(block.input).slice(0, 400)}]`;
      }
      return `[tool_result ${(block.content ?? "").slice(0, 400)}]`;
    });
    chunks.push(`${message.role}: ${parts.join("\n")}`);
  }
  const text = chunks.join("\n\n");
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head - 28;
  return `${text.slice(0, head)}\n\n[...truncated...]\n\n${text.slice(-tail)}`;
}

export const SILENT_RENDERER: StreamRenderer = {
  renderUserMessage() {},
  renderAssistantMessage() {},
  renderThinking() {},
  renderSystemMessage() {},
  renderToolUse() {},
  renderToolResult() {},
  renderError() {},
  renderWarning() {},
  clear() {},
  flush() {},
};
