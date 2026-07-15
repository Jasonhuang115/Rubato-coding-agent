// Journal Recall — triggered recall of relevant knowledge
// At session start: search journal for knowledge relevant to the current project
// During conversation: search when user asks "之前怎么解决的" or similar

import { getJournalStore } from "./store.js";
import type { JournalEntry } from "./store.js";

export interface RecallResult {
  query: string;
  entries: JournalEntry[];
  summary: string;
  /** Context block ready for injection into system prompt */
  contextBlock: string | null;
}

/** Search journal for knowledge relevant to the current query/project */
export function recallKnowledge(
  query: string,
  projectPath?: string,
  limit = 5
): RecallResult {
  const store = getJournalStore();
  const entries = store.search(query, limit);

  // Also search by project if specified
  let projectEntries: JournalEntry[] = [];
  if (projectPath) {
    projectEntries = store.getByProject(projectPath, limit);
  }

  // Merge and deduplicate
  const seen = new Set<number>();
  const merged: JournalEntry[] = [];
  for (const { entry } of entries) {
    if (!seen.has(entry.id!)) {
      seen.add(entry.id!);
      merged.push(entry);
    }
  }
  for (const entry of projectEntries) {
    if (!seen.has(entry.id!)) {
      seen.add(entry.id!);
      merged.push(entry);
    }
  }

  const topEntries = merged.slice(0, limit);

  const summary =
    topEntries.length > 0
      ? `从知识库中找到 ${topEntries.length} 条相关知识`
      : "知识库中没有找到相关内容";

  const contextBlock = buildContextBlock(topEntries);

  return {
    query,
    entries: topEntries,
    summary,
    contextBlock,
  };
}

/** Recall knowledge triggered by a user message */
export function recallOnMessage(
  message: string,
  projectPath?: string
): string | null {
  // Only recall when the message contains specific patterns
  if (!shouldRecall(message)) return null;

  const result = recallKnowledge(message, projectPath, 3);
  return result.contextBlock;
}

/** Check if a message warrants a journal recall */
function shouldRecall(message: string): boolean {
  const triggers = [
    /之前.*怎么/,
    /上次.*解决/,
    /我记得/,
    /之前遇到过/,
    /有什么.*经验/,
    /最佳实践/,
    /怎么处理/,
    /有什么.*建议/,
    /以前.*方案/,
    /之前.*bug/,
    /还记得.*吗/,
    /how did (we|you|i) (fix|solve|handle)/i,
    /any (tips|best practices|suggestions)/i,
    /remember when/i,
  ];

  return triggers.some((re) => re.test(message));
}

// ---- Session start recall ----

/** Called at session startup to inject relevant journal knowledge */
export function sessionStartRecall(
  projectPath: string,
  recentQueries: string[] = []
): string | null {
  const store = getJournalStore();

  // Get recent entries from this project
  const projectEntries = store.getByProject(projectPath, 5);

  // Get popular entries globally
  const popularEntries = store.getPopular(3);

  // Deduplicate
  const seen = new Set<number>();
  const merged: JournalEntry[] = [];
  for (const entry of [...projectEntries, ...popularEntries]) {
    if (!seen.has(entry.id!)) {
      seen.add(entry.id!);
      merged.push(entry);
    }
  }

  if (merged.length === 0) return null;

  return buildContextBlock(merged.slice(0, 5));
}

// ---- Formatting ----

function buildContextBlock(entries: JournalEntry[]): string | null {
  if (entries.length === 0) return null;

  const lines = [
    "## 📓 Personal Tech Journal — 相关知识",
    "",
  ];

  for (const entry of entries) {
    const typeIcon = getTypeIcon(entry.type);
    const tagsStr = entry.tags.length > 0 ? ` \`${entry.tags.join("` `")}\`` : "";

    lines.push(`### ${typeIcon} ${entry.title}${tagsStr}`);
    lines.push(`> ${entry.content.slice(0, 300)}`);
    lines.push("");
  }

  lines.push(
    "💡 这些知识来自你之前的学习记录。用 `/journal search <关键词>` 搜索更多。"
  );

  return lines.join("\n");
}

function getTypeIcon(type: JournalEntry["type"]): string {
  switch (type) {
    case "tip": return "💡";
    case "fix": return "🔧";
    case "concept": return "📖";
    case "snippet": return "📋";
    case "resource": return "🔗";
    case "note": return "📝";
    default: return "📌";
  }
}

// ---- Knowledge gap detection ----

/** Detect topics that the user keeps encountering but hasn't saved */
export function detectKnowledgeGaps(
  recentTopics: string[]
): Array<{ topic: string; suggestion: string }> {
  const store = getJournalStore();
  const gaps: Array<{ topic: string; suggestion: string }> = [];

  for (const topic of recentTopics) {
    const results = store.search(topic, 1);
    if (results.length === 0) {
      gaps.push({
        topic,
        suggestion: `你最近遇到了「${topic}」相关的问题，建议用 /remember 记录下来，下次遇到可以快速查阅。`,
      });
    }
  }

  return gaps;
}
