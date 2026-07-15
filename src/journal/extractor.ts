// Journal Extractor — auto-detects valuable knowledge in conversations
// Watches for signal phrases: "原来如此", "这个 bug 是因为", "解决方案是", etc.
// Extracts structured entries for the Personal Tech Journal

import type { Message } from "../core-types.js";
import type { JournalStore } from "./store.js";
import { getJournalStore } from "./store.js";
import type { JournalEntry } from "./store.js";

// ---- Signal detection ----

interface ExtractionSignal {
  phrase: string;
  type: JournalEntry["type"];
  /** How many messages around the signal to include as context */
  contextWindow: number;
}

const SIGNALS: ExtractionSignal[] = [
  { phrase: "原来如此", type: "concept", contextWindow: 3 },
  { phrase: "这个 bug 是因为", type: "fix", contextWindow: 5 },
  { phrase: "问题在于", type: "fix", contextWindow: 5 },
  { phrase: "解决方案是", type: "fix", contextWindow: 5 },
  { phrase: "关键是", type: "tip", contextWindow: 3 },
  { phrase: "最佳实践", type: "tip", contextWindow: 5 },
  { phrase: "建议用", type: "tip", contextWindow: 3 },
  { phrase: "不要用", type: "tip", contextWindow: 3 },
  { phrase: "坑：", type: "tip", contextWindow: 3 },
  { phrase: "注意", type: "tip", contextWindow: 3 },
  { phrase: "总结了", type: "note", contextWindow: 5 },
  { phrase: "经验", type: "note", contextWindow: 5 },
  { phrase: "记一下", type: "note", contextWindow: 5 },
  { phrase: "cool trick", type: "tip", contextWindow: 3 },
  { phrase: "TIL", type: "tip", contextWindow: 3 },
  { phrase: "today i learned", type: "tip", contextWindow: 3 },
  { phrase: "the fix was", type: "fix", contextWindow: 5 },
  { phrase: "the issue was", type: "fix", contextWindow: 5 },
  { phrase: "the solution is", type: "fix", contextWindow: 5 },
  { phrase: "code snippet", type: "snippet", contextWindow: 3 },
  { phrase: "参考", type: "resource", contextWindow: 3 },
  { phrase: "文档", type: "resource", contextWindow: 3 },
];

// ---- Extraction ----

export interface ExtractedKnowledge {
  title: string;
  content: string;
  tags: string[];
  type: JournalEntry["type"];
  /** Excerpt from conversation that triggered extraction */
  sourceQuote: string;
  confidence: number;
}

/** Scan messages for valuable knowledge */
export function extractKnowledge(
  messages: Message[],
  sessionId: string,
  projectPath: string
): ExtractedKnowledge[] {
  const results: ExtractedKnowledge[] = [];

  // Concatenate into a searchable text
  const texts = messages.map((m, idx) => ({
    index: idx,
    text: typeof m.content === "string"
      ? m.content
      : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
  }));

  for (const signal of SIGNALS) {
    for (const { index, text } of texts) {
      if (text.includes(signal.phrase)) {
        const knowledge = extractAroundSignal(
          texts,
          index,
          signal,
          sessionId,
          projectPath
        );
        if (knowledge) {
          results.push(knowledge);
        }
      }
    }
  }

  // Deduplicate by title
  const seen = new Set<string>();
  return results.filter((k) => {
    const key = k.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractAroundSignal(
  texts: Array<{ index: number; text: string }>,
  signalIndex: number,
  signal: ExtractionSignal,
  sessionId: string,
  projectPath: string
): ExtractedKnowledge | null {
  // Get context: N messages around the signal
  const start = Math.max(0, signalIndex - signal.contextWindow);
  const end = Math.min(texts.length, signalIndex + signal.contextWindow + 1);
  const context = texts.slice(start, end);

  const sourceQuote = texts[signalIndex].text.slice(
    Math.max(0, texts[signalIndex].text.indexOf(signal.phrase) - 50),
    Math.min(texts[signalIndex].text.length, texts[signalIndex].text.indexOf(signal.phrase) + 200)
  ).trim();

  // Generate title from the most descriptive sentence
  const title = generateTitle(context, signal);

  // Extract code blocks as content
  const codeBlocks = extractCodeBlocks(context);
  const description = context
    .map((t) => t.text)
    .join("\n")
    .slice(0, 1000);

  const content = codeBlocks.length > 0
    ? `${description}\n\n### 相关代码\n\n${codeBlocks.join("\n\n")}`
    : description;

  // Extract tags from the context
  const tags = extractTags(context);

  return {
    title,
    content,
    tags,
    type: signal.type,
    sourceQuote,
    confidence: 0.6, // rule-based, moderate confidence
  };
}

// ---- Helpers ----

function generateTitle(
  context: Array<{ index: number; text: string }>,
  signal: ExtractionSignal
): string {
  const fullText = context.map((t) => t.text).join(" ");

  // Try to find a declarative sentence with the signal word
  const sentences = fullText.split(/[。.!！?？\n]/);
  const signalSentence = sentences.find((s) =>
    s.includes(signal.phrase)
  );

  if (signalSentence && signalSentence.length <= 80) {
    return signalSentence.trim();
  }

  // Fallback: first sentence that looks like a statement
  for (const s of sentences) {
    const trimmed = s.trim();
    if (trimmed.length > 10 && trimmed.length <= 80) {
      return trimmed;
    }
  }

  // Last resort
  return `Knowledge from session (${signal.type})`;
}

function extractCodeBlocks(
  context: Array<{ index: number; text: string }>
): string[] {
  const blocks: string[] = [];
  const fullText = context.map((t) => t.text).join("\n");

  const codeRegex = /```(\w*)\n([\s\S]*?)```/g;
  let match;

  while ((match = codeRegex.exec(fullText)) !== null) {
    const lang = match[1] || "";
    const code = match[2].trim();
    if (code.length > 20 && code.length < 2000) {
      blocks.push(`\`\`\`${lang}\n${code}\n\`\`\``);
    }
  }

  return blocks.slice(0, 3); // max 3 code blocks
}

function extractTags(
  context: Array<{ index: number; text: string }>
): string[] {
  const fullText = context.map((t) => t.text).join(" ").toLowerCase();
  const tags = new Set<string>();

  const techTerms = [
    "typescript", "javascript", "python", "rust", "react", "vue", "node",
    "git", "docker", "sql", "api", "cli", "testing", "debug", "performance",
    "security", "refactoring", "architecture", "devops", "ci/cd",
  ];

  for (const term of techTerms) {
    if (fullText.includes(term)) {
      tags.add(term);
    }
  }

  return Array.from(tags).slice(0, 5);
}

// ---- Persist ----

/** Extract and persist knowledge from a conversation */
export function persistKnowledge(
  messages: Message[],
  sessionId: string,
  projectPath: string
): { saved: number } {
  const extracted = extractKnowledge(messages, sessionId, projectPath);

  if (extracted.length === 0) return { saved: 0 };

  const store = getJournalStore();
  let saved = 0;

  for (const knowledge of extracted) {
    try {
      store.addEntry({
        title: knowledge.title,
        content: knowledge.content,
        tags: knowledge.tags,
        sourceSession: sessionId,
        projectPath,
        type: knowledge.type,
      });
      saved++;
    } catch {
      // skip duplicates or db errors
    }
  }

  return { saved };
}

/** Manual save: "/remember [title]" */
export function manualRemember(
  title: string,
  content: string,
  tags: string[],
  sessionId: string,
  projectPath: string
): number {
  const store = getJournalStore();
  return store.addEntry({
    title,
    content,
    tags,
    sourceSession: sessionId,
    projectPath,
    type: "note",
  });
}
