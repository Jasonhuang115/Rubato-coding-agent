import type { Message } from "../shared/core-types.js";
import type { InjectedMemory, MnemosyneStore } from "./store.js";

export interface MemoryAttribution {
  memoryId: number;
  referenced: boolean;
  confidence: number;
  evidence: string;
  retrievalSource: string;
}

const STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "been", "before", "being", "can",
  "config", "could", "does", "error", "file", "from", "have", "into", "memory",
  "more", "note", "only", "should", "that", "their", "then", "there", "these",
  "this", "through", "using", "when", "where", "which", "with", "would",
  "一个", "以及", "使用", "可以", "如果", "如何", "已经", "应该", "这个", "进行",
]);

export function attributeMemoryReferences(
  messages: Message[],
  memories: InjectedMemory[],
): MemoryAttribution[] {
  const response = normalize(extractAssistantText(messages));
  if (!response) {
    return memories.map((memory) => noMatch(memory));
  }

  const responseTokens = new Set(tokenize(response));
  return memories.map((memory) => attributeOne(memory, response, responseTokens));
}

export function hasAssistantResponse(messages: Message[]): boolean {
  return normalize(extractAssistantText(messages)).length > 0;
}

export function recordAttributedMemoryReferences(
  messages: Message[],
  sessionId: string,
  store: MnemosyneStore,
): MemoryAttribution[] {
  const results = attributeMemoryReferences(messages, store.getInjectedMemoriesForSession(sessionId));
  for (const result of results) {
    if (!result.referenced) continue;
    store.markReferenced(result.memoryId, sessionId, result.retrievalSource, {
      attribution: "deterministic",
      confidence: result.confidence,
      evidence: result.evidence,
    });
  }
  return results;
}

function attributeOne(
  memory: InjectedMemory,
  response: string,
  responseTokens: Set<string>,
): MemoryAttribution {
  const name = normalize(memory.entity.name);
  if (name.length >= 4 && response.includes(name)) {
    return match(memory, 0.98, `name:${memory.entity.name.slice(0, 80)}`);
  }

  for (const phrase of contentPhrases(memory.entity.content)) {
    if (response.includes(phrase)) {
      return match(memory, 0.95, `content:${phrase.slice(0, 80)}`);
    }
  }

  const queryTokens = new Set(tokenize(normalize(memory.query)));
  const memoryTokens = tokenize(normalize(`${memory.entity.name} ${memory.entity.content}`))
    .filter((token) => !queryTokens.has(token));
  const distinctive = [...new Set(memoryTokens)].filter(isDistinctiveToken);
  const overlaps = distinctive.filter((token) => responseTokens.has(token));

  const codeEvidence = overlaps.find(isCodeLikeToken);
  if (codeEvidence && codeEvidence.length >= 5) {
    return match(memory, 0.9, `token:${codeEvidence}`);
  }

  const coverage = distinctive.length > 0 ? overlaps.length / Math.min(distinctive.length, 6) : 0;
  if (overlaps.length >= 2 && coverage >= 0.34) {
    return match(memory, Math.min(0.92, 0.8 + coverage * 0.15), `tokens:${overlaps.slice(0, 4).join(",")}`);
  }

  return noMatch(memory);
}

function extractAssistantText(messages: Message[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") {
      chunks.push(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") chunks.push(block.text);
    }
  }
  return chunks.join("\n");
}

function contentPhrases(content: string): string[] {
  return content
    .split(/[\n.!?。！？；;]+/)
    .map(normalize)
    .filter((phrase) => phrase.length >= 16)
    .slice(0, 8);
}

function tokenize(text: string): string[] {
  return text.match(/[a-z_$][a-z0-9_$./:@-]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function isDistinctiveToken(token: string): boolean {
  if (STOP_WORDS.has(token)) return false;
  if (/^[\p{Script=Han}]+$/u.test(token)) return token.length >= 3;
  return token.length >= 4 && !/^\d+$/.test(token);
}

function isCodeLikeToken(token: string): boolean {
  return /[./_:@$-]/.test(token) || /\d/.test(token);
}

function match(memory: InjectedMemory, confidence: number, evidence: string): MemoryAttribution {
  return {
    memoryId: memory.entity.id,
    referenced: true,
    confidence,
    evidence,
    retrievalSource: memory.retrievalSource,
  };
}

function noMatch(memory: InjectedMemory): MemoryAttribution {
  return {
    memoryId: memory.entity.id,
    referenced: false,
    confidence: 0,
    evidence: "",
    retrievalSource: memory.retrievalSource,
  };
}
