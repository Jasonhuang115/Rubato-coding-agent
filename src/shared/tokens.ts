import type { Message } from "./core-types.js";

/** Rough CJK-aware token estimate used for context budgeting. */
export function roughTokenEstimate(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      tokens += 1.5;
    } else {
      tokens += 0.25;
    }
  }
  return tokens;
}

/** Estimate tokens for a message array. Pads by 4/3 for safety. */
export function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += roughTokenEstimate(msg.content);
      continue;
    }
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          total += roughTokenEstimate(block.text);
          break;
        case "tool_result":
          total += roughTokenEstimate(block.content ?? "");
          break;
        case "tool_use":
          total += roughTokenEstimate(block.name + JSON.stringify(block.input));
          break;
      }
    }
  }
  return Math.ceil(total * (4 / 3));
}
