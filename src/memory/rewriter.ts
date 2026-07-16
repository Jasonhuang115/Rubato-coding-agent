// Query Rewriter — learns from failed queries to improve future retrieval
import { getMnemosyneStore } from "./store.js";
import type { MnemosyneStore } from "./store.js";

export interface RewriteResult {
  originalQuery: string; variants: string[]; usedRewrite: boolean;
}

export function rewriteQuery(raw: string): RewriteResult {
  const store = getMnemosyneStore();
  const variants: string[] = [raw];

  for (const rewrite of store.getQueryRewrites(raw, 5))
    { if (!variants.includes(rewrite)) variants.push(rewrite); }

  for (const variant of generateRuleVariants(raw))
    { if (!variants.includes(variant)) variants.push(variant); }

  return { originalQuery: raw, variants: variants.slice(0, 5), usedRewrite: variants.length > 1 };
}

export function learnQueryRewrite(originalQuery: string, foundMemoryIds: number[], store?: MnemosyneStore): void {
  if (foundMemoryIds.length === 0) return;
  const s = store ?? getMnemosyneStore();
  const names: string[] = [];
  for (const id of foundMemoryIds) {
    const entity = s.getEntity(id);
    if (entity) { names.push(entity.name); names.push(...tokenize(entity.content.slice(0, 200)).slice(0, 5)); }
  }
  const rewrittenQuery = buildRewrittenQuery(originalQuery, names);
  if (rewrittenQuery && rewrittenQuery !== originalQuery) s.addQueryRewriteRule(originalQuery, rewrittenQuery);
}

export function learnFromRetrieval(originalQuery: string, retrievedIds: number[], wasHelpful: boolean): void {
  const store = getMnemosyneStore();
  store.updateStrategyWeight("fts5", wasHelpful);
  if (wasHelpful && retrievedIds.length > 0) learnQueryRewrite(originalQuery, retrievedIds);
}

function generateRuleVariants(query: string): string[] {
  const variants: string[] = [];
  const stripped = query.replace(/how (do|can|to|does|should|would) (i|we|you) /gi, "").replace(/what (is|are) /gi, "").replace(/tell me (about|how) /gi, "").replace(/explain /gi, "").replace(/please /gi, "").trim();
  if (stripped !== query && stripped.length > 3) variants.push(stripped);

  const synonymMap: Record<string, string[]> = {
    "db": ["database", "sqlite", "postgres"], "error": ["bug", "exception", "crash"],
    "fix": ["solve", "resolve", "patch"], "config": ["configuration", "settings"],
    "api": ["endpoint", "route", "interface"], "slow": ["performance", "latency", "timeout"],
    "memory": ["ram", "cache", "storage"], "test": ["testing", "spec", "verify"],
    "build": ["compile", "bundle", "package"], "deploy": ["release", "ship"],
    "auth": ["authentication", "login", "oauth"],
  };

  const lower = query.toLowerCase();
  for (const [term, synonyms] of Object.entries(synonymMap)) {
    if (lower.includes(term))
      for (const syn of synonyms) { const v = lower.replace(term, syn); if (v !== lower) variants.push(v); }
  }

  const techTokens = extractTechTokens(query);
  if (techTokens.length >= 2) { const kq = techTokens.join(" "); if (kq !== query && kq.length > 3) variants.push(kq); }

  return variants;
}

const TECH_TERMS = new Set([
  "typescript", "javascript", "python", "rust", "react", "vue", "node", "git", "docker",
  "sql", "sqlite", "postgres", "mysql", "api", "cli", "testing", "debug", "performance",
  "security", "refactoring", "architecture", "devops", "css", "html", "json", "yaml",
  "graphql", "rest", "linux", "macos", "bash", "zsh", "vscode", "eslint", "prettier",
  "webpack", "vite", "next.js", "tailwind", "prisma", "orm", "redis", "nginx",
]);

function extractTechTokens(text: string): string[] { return tokenize(text).filter((t) => TECH_TERMS.has(t)); }

function buildRewrittenQuery(original: string, foundNames: string[]): string {
  const wordFreq = new Map<string, number>();
  for (const name of foundNames) for (const word of tokenize(name)) { if (word.length > 2) wordFreq.set(word, (wordFreq.get(word) || 0) + 1); }
  const resultTokens = [...wordFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
  const combined = [...new Set([...extractTechTokens(original), ...resultTokens])];
  return combined.length > 0 ? combined.join(" ") : original;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s,.;:!?()[\]{}"'/\\|`~@#$%^&*+=<>]+/).filter((t) => t.length > 1);
}
