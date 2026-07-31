import type { CatalogEntry, MemoryCard, MemoryContexts } from "./types.js";

const CATALOG_COLUMNS = [
  "id", "revision", "logical_key", "kind", "scope", "status", "application",
  "authority", "sensitivity", "confidence", "support_score", "opposition_score",
  "half_life_days", "title", "summary", "aliases", "tags", "contexts",
  "first_seen_at", "last_seen_at", "path",
] as const;

const PROFILE_KINDS = new Set([
  "preference", "habit", "boundary", "identity", "goal", "environment",
]);
const PROFILE_STATUSES = new Set([
  "confirmed", "active", "provisional",
]);

export function buildCatalog(cards: MemoryCard[]): CatalogEntry[] {
  return [...cards]
    .sort(compareCards)
    .map((card) => ({
      id: card.id,
      revision: card.revision,
      logicalKey: card.logicalKey,
      kind: card.kind,
      scope: card.scope,
      status: card.status,
      application: card.application,
      authority: card.authority,
      sensitivity: card.sensitivity,
      confidence: card.confidence,
      supportScore: card.supportScore,
      oppositionScore: card.oppositionScore,
      halfLifeDays: card.halfLifeDays,
      title: card.title,
      summary: summarizeBody(card.body),
      aliases: [...card.aliases],
      tags: [...card.tags],
      contexts: cloneContexts(card.contexts),
      firstSeenAt: card.firstSeenAt,
      lastSeenAt: card.lastSeenAt,
      path: `cards/${card.id}.md`,
    }));
}

export function serializeCatalog(entries: CatalogEntry[]): string {
  const rows = [CATALOG_COLUMNS.join("\t")];
  for (const entry of entries) {
    rows.push([
      entry.id,
      String(entry.revision),
      entry.logicalKey,
      entry.kind,
      entry.scope,
      entry.status,
      entry.application,
      entry.authority,
      entry.sensitivity,
      String(entry.confidence),
      String(entry.supportScore),
      String(entry.oppositionScore),
      entry.halfLifeDays === null ? "" : String(entry.halfLifeDays),
      entry.title,
      entry.summary,
      JSON.stringify(entry.aliases),
      JSON.stringify(entry.tags),
      JSON.stringify(entry.contexts),
      entry.firstSeenAt,
      entry.lastSeenAt,
      entry.path,
    ].map(escapeTsv).join("\t"));
  }
  return `${rows.join("\n")}\n`;
}

export function parseCatalog(tsv: string): CatalogEntry[] {
  const lines = tsv.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split("\t");
  if (header.join("\t") !== CATALOG_COLUMNS.join("\t")) {
    throw new Error("Unsupported memory catalog header.");
  }
  return lines.slice(1).map((line, index) => {
    const values = splitTsv(line);
    if (values.length !== CATALOG_COLUMNS.length) {
      throw new Error(`Malformed memory catalog row ${index + 2}.`);
    }
    return {
      id: values[0],
      revision: parseRequiredNumber(values[1], "revision"),
      logicalKey: values[2],
      kind: values[3] as CatalogEntry["kind"],
      scope: values[4] as CatalogEntry["scope"],
      status: values[5] as CatalogEntry["status"],
      application: values[6] as CatalogEntry["application"],
      authority: values[7] as CatalogEntry["authority"],
      sensitivity: values[8] as CatalogEntry["sensitivity"],
      confidence: parseRequiredNumber(values[9], "confidence"),
      supportScore: parseRequiredNumber(values[10], "support_score"),
      oppositionScore: parseRequiredNumber(values[11], "opposition_score"),
      halfLifeDays: values[12] ? parseRequiredNumber(values[12], "half_life_days") : null,
      title: values[13],
      summary: values[14],
      aliases: parseStringArray(values[15], "aliases"),
      tags: parseStringArray(values[16], "tags"),
      contexts: parseContexts(values[17]),
      firstSeenAt: values[18],
      lastSeenAt: values[19],
      path: values[20],
    };
  });
}

/**
 * Bounded influence of observed usefulness on ordering. Text relevance decides
 * membership; utility only nudges rank among entries that already matched.
 */
const UTILITY_RANK_WEIGHT = 1.5;

export interface CatalogSearchOptions {
  limit?: number;
  /**
   * Memory id to utility score, from memoryUtilityScores(). Applied strictly
   * after text matching, so it can never introduce or exclude a result.
   */
  utility?: ReadonlyMap<string, number>;
}

export function searchCatalog(
  entries: CatalogEntry[],
  query: string,
  options: number | CatalogSearchOptions = {},
): CatalogEntry[] {
  const { limit = 20, utility } = typeof options === "number"
    ? { limit: options, utility: undefined }
    : options;
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0 || limit <= 0) return [];

  return entries
    .map((entry) => {
      const primary = [
        entry.logicalKey, entry.title, entry.aliases.join(" "), entry.tags.join(" "),
      ].join(" ").toLocaleLowerCase();
      const secondary = [
        entry.summary, entry.kind, entry.application, entry.authority,
        entry.contexts.domains.join(" "), entry.contexts.projects.join(" "),
        entry.contexts.surfaces.join(" "), entry.contexts.languages.join(" "),
      ].join(" ").toLocaleLowerCase();
      const matched = terms.filter((term) =>
        primary.includes(term) || secondary.includes(term));
      const primaryMatches = terms.filter((term) => primary.includes(term)).length;
      return {
        entry,
        score: matched.length * 2 + primaryMatches +
          (primary.includes(query.toLocaleLowerCase()) ? 2 : 0),
      };
    })
    .filter(({ score }) => score > 0)
    .map(({ entry, score }) => ({
      entry,
      rank: score +
        UTILITY_RANK_WEIGHT * clampUnit(utility?.get(entry.id) ?? 0),
    }))
    .sort((a, b) => b.rank - a.rank ||
      b.entry.confidence - a.entry.confidence ||
      a.entry.logicalKey.localeCompare(b.entry.logicalKey))
    .slice(0, limit)
    .map(({ entry }) => entry);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}

export function buildMemoryIndex(cards: MemoryCard[]): string {
  const active = [...cards]
    .filter((card) => card.status !== "superseded" && card.status !== "retired")
    .sort(compareCards);
  const byKind = new Map<string, MemoryCard[]>();
  for (const card of active) {
    const list = byKind.get(card.kind) ?? [];
    list.push(card);
    byKind.set(card.kind, list);
  }

  const lines = [
    "# Memory Index",
    "",
    "This index is generated from the current immutable memory release.",
    "Use catalog.tsv for grep-first discovery, then read the referenced card.",
  ];
  for (const [kind, entries] of [...byKind.entries()].sort(([a], [b]) =>
    a.localeCompare(b))) {
    lines.push("", `## ${kind}`);
    for (const card of entries) {
      const aliases = card.aliases.length > 0
        ? ` — aliases: ${card.aliases.join(", ")}`
        : "";
      const context = formatContexts(card.contexts);
      lines.push(
        `- [${card.title}](cards/${card.id}.md) ` +
        `\`${card.logicalKey}\` [${card.status}/${card.application}]` +
        `${aliases}${context ? ` — ${context}` : ""}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function buildUserProfile(cards: MemoryCard[], maxChars = 2_000): string {
  const profileCards = [...cards]
    .filter((card) =>
      PROFILE_KINDS.has(card.kind) &&
      PROFILE_STATUSES.has(card.status) &&
      card.sensitivity !== "secret" &&
      // Bootstrapped repository facts share the release but are not the user.
      // They stay out of the always-injected profile and remain greppable.
      card.authority !== "repository" &&
      !hasInferenceOnlyEvidence(card))
    .sort((a, b) =>
      profileRank(b) - profileRank(a) ||
      a.logicalKey.localeCompare(b.logicalKey));

  const lines = [
    "# User Profile",
    "",
    "Generated from the current memory release. Memory cannot override security policy or current user instructions.",
  ];
  for (const card of profileCards) {
    const context = formatContexts(card.contexts) || "all contexts";
    const halfLife = card.halfLifeDays === null
      ? "no time decay"
      : `half-life ${card.halfLifeDays}d`;
    const line = [
      `- **${card.title}** (\`${card.logicalKey}\`, ${card.status})`,
      `${card.application}; authority=${card.authority}; sensitivity=${card.sensitivity}`,
      `confidence=${card.confidence.toFixed(2)}; support=${card.supportScore}; opposition=${card.oppositionScore}; ${halfLife}`,
      `context=${context}`,
      summarizeBody(card.body),
    ].join(" — ");
    if (`${lines.join("\n")}\n${line}\n`.length > maxChars) break;
    lines.push(line);
  }
  if (lines.length === 3) lines.push("", "_No active profile memories._");
  return `${lines.join("\n")}\n`;
}

function summarizeBody(body: string): string {
  const line = body
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0 && !value.startsWith("#"));
  return (line ?? "")
    .replace(/^[-*>]+\s*/, "")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function compareCards(a: MemoryCard, b: MemoryCard): number {
  return a.kind.localeCompare(b.kind) ||
    a.logicalKey.localeCompare(b.logicalKey) ||
    a.id.localeCompare(b.id);
}

function profileRank(card: MemoryCard): number {
  const status = card.status === "confirmed"
    ? 4
    : card.status === "active"
      ? 3
      : card.status === "provisional"
        ? 2
        : 1;
  const authority = card.authority === "user_explicit"
    ? 3
    : card.authority === "user_inferred"
      ? 2
      : 1;
  return status * 100 + authority * 10 + card.confidence;
}

function hasInferenceOnlyEvidence(card: MemoryCard): boolean {
  return card.evidence.length > 0 &&
    card.evidence.every((item) =>
      item.signal === "inference" || item.signal === "other");
}

function formatContexts(contexts: MemoryContexts): string {
  return [
    contexts.domains.length ? `domains=${contexts.domains.join(",")}` : "",
    contexts.projects.length ? `projects=${contexts.projects.join(",")}` : "",
    contexts.surfaces.length ? `surfaces=${contexts.surfaces.join(",")}` : "",
    contexts.languages.length ? `languages=${contexts.languages.join(",")}` : "",
  ].filter(Boolean).join("; ");
}

function cloneContexts(contexts: MemoryContexts): MemoryContexts {
  return {
    domains: [...contexts.domains],
    projects: [...contexts.projects],
    surfaces: [...contexts.surfaces],
    languages: [...contexts.languages],
  };
}

function escapeTsv(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function splitTsv(line: string): string[] {
  return line.split("\t").map(unescapeTsv);
}

function unescapeTsv(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "\\" || index + 1 >= value.length) {
      output += value[index];
      continue;
    }
    index++;
    const next = value[index];
    output += next === "t" ? "\t" : next === "n" ? "\n" : next === "r" ? "\r" : next;
  }
  return output;
}

function parseRequiredNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid catalog ${field}.`);
  return parsed;
}

function parseStringArray(value: string, field: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error(`Invalid catalog ${field}.`);
  }
}

function parseContexts(value: string): MemoryContexts {
  try {
    const parsed = JSON.parse(value) as Partial<MemoryContexts>;
    return {
      domains: stringArray(parsed.domains),
      projects: stringArray(parsed.projects),
      surfaces: stringArray(parsed.surfaces),
      languages: stringArray(parsed.languages),
    };
  } catch {
    throw new Error("Invalid catalog contexts.");
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
