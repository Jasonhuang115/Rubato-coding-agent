// Triple Extractor — post-session analysis
// Extracts (entity, relation, entity) triples from conversation history
// Uses a lightweight, rule-based approach for speed; LLM extraction as fallback

import type { MnemosyneStore } from "./store.js";
import type { Message } from "../core-types.js";

// ---- Types ----

export interface ExtractedTriple {
  sourceName: string;
  sourceType: string;
  relation: string;
  targetName: string;
  targetType: string;
  evidence: string; // excerpt from conversation
  confidence: number;
}

export interface ExtractionResult {
  triples: ExtractedTriple[];
  entityCount: number;
  relationCount: number;
}

// ---- Pattern-based extraction ----

interface ExtractionPattern {
  regex: RegExp;
  sourceHint: string;
  relation: string;
  targetHint: string;
}

const FILE_PATTERNS: ExtractionPattern[] = [
  // "src/auth.ts handles login" → file IMPLEMENTS concept
  {
    regex: /([\w./-]+\.(?:ts|js|py|rs|go|java|rb))[^.]*(?:handles|implements|provides|contains|defines)[^.]+?(\w+(?:\s+\w+){0,3})/gi,
    sourceHint: "file",
    relation: "IMPLEMENTS",
    targetHint: "concept",
  },
  // Import statements: import { X } from './y' → file DEPENDS_ON file
  {
    regex: /from\s+['"]([^'"]+)['"]/gi,
    sourceHint: "file",
    relation: "DEPENDS_ON",
    targetHint: "file",
  },
  // Error → FIXED_BY
  {
    regex: /(?:bug|error|issue|crash|fail|broken)[^.]*?(?:fix|resolved|solved|patched)[^.]*?by[^.]+?(\w+(?:\s+\w+){0,5})/gi,
    sourceHint: "error",
    relation: "FIXED_BY",
    targetHint: "concept",
  },
  // Test file → TESTED_BY
  {
    regex: /(test\S*\.(?:ts|js|py|rs))[^.]*?(?:tests?|covers?|verifies?)[^.]+?(\w+(?:\s+\w+){0,3})/gi,
    sourceHint: "test",
    relation: "TESTED_BY",
    targetHint: "function",
  },
  // Config → CONFIGURES
  {
    regex: /(?:config|\.env|settings|configuration)[^.]*?(?:sets?|configures?|defines?)[^.]+?(\w+(?:\s+\w+){0,3})/gi,
    sourceHint: "config",
    relation: "CONFIGURES",
    targetHint: "concept",
  },
];

const CODE_PATTERNS: ExtractionPattern[] = [
  // function/class definition
  {
    regex: /(?:function|class|const|let|var|interface|type)\s+(\w+)[^{]*\{/g,
    sourceHint: "file",
    relation: "MENTIONED_IN",
    targetHint: "function",
  },
];

// ---- Keyword-based concept extraction ----

const TECH_CONCEPTS = new Set([
  "JWT", "OAuth", "REST", "GraphQL", "SQL", "NoSQL", "Redis", "Docker",
  "Kubernetes", "React", "Vue", "Angular", "Node", "Express", "Fastify",
  "TypeScript", "JavaScript", "Python", "Rust", "PostgreSQL", "MySQL",
  "SQLite", "MongoDB", "Prisma", "Drizzle", "Tailwind", "CSS", "HTML",
  "API", "CLI", "CI", "CD", "Git", "GitHub", "NPM", "Yarn", "ESM",
  "CJS", "Webpack", "Vite", "ESBuild", "Jest", "Vitest", "Mocha",
  "auth", "login", "session", "token", "password", "hash", "bcrypt",
  "middleware", "router", "controller", "service", "repository",
  "migration", "seed", "backup", "deploy", "monitor", "log", "cache",
]);

function extractConcepts(text: string): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();

  for (const concept of TECH_CONCEPTS) {
    if (lower.includes(concept.toLowerCase())) {
      found.add(concept);
    }
  }

  // Also extract capitalized words that look like proper nouns
  const properNouns = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)*\b/g);
  if (properNouns) {
    for (const noun of properNouns) {
      if (noun.length > 3 && !["This", "That", "These", "Those", "When", "What", "Where", "Which", "There"].includes(noun)) {
        found.add(noun);
      }
    }
  }

  return Array.from(found);
}

// ---- Main extraction ----

export function extractTriples(
  messages: Message[],
  sessionId: string,
  workingDir: string
): ExtractionResult {
  const triples: ExtractedTriple[] = [];
  const seen = new Set<string>(); // dedup by triple signature

  // Concatenate all user + assistant text
  const allText = messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
    )
    .join("\n");

  // Extract file references
  const fileRefs = allText.match(/[\w./-]+\.(?:ts|js|py|rs|go|java|rb|css|html|json|yml|yaml|md|sql)/gi) ?? [];
  const uniqueFiles = [...new Set(fileRefs)];

  // For each file, create a file entity
  for (const file of uniqueFiles) {
    // File → concept relations
    const concepts = extractConcepts(
      messages
        .filter((m) => {
          const text = typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
          return text.includes(file);
        })
        .map((m) => (typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")))
        .join("\n")
    );

    for (const concept of concepts) {
      const sig = `FILE:${file}|IMPLEMENTS|CONCEPT:${concept}`;
      if (seen.has(sig)) continue;
      seen.add(sig);

      triples.push({
        sourceName: file,
        sourceType: "file",
        relation: "IMPLEMENTS",
        targetName: concept,
        targetType: "concept",
        evidence: `File ${file} relates to concept ${concept}`,
        confidence: 0.7,
      });
    }
  }

  // Apply extraction patterns
  for (const pattern of [...FILE_PATTERNS, ...CODE_PATTERNS]) {
    let match: RegExpExecArray | null;
    pattern.regex.lastIndex = 0;

    while ((match = pattern.regex.exec(allText)) !== null) {
      const source = match[1]?.trim();
      const target = match[2]?.trim();
      if (!source || !target || source === target) continue;

      const sig = `${pattern.sourceHint}:${source}|${pattern.relation}|${pattern.targetHint}:${target}`;
      if (seen.has(sig)) continue;
      seen.add(sig);

      triples.push({
        sourceName: source,
        sourceType: pattern.sourceHint,
        relation: pattern.relation,
        targetName: target,
        targetType: pattern.targetHint,
        evidence: match[0].trim(),
        confidence: 0.6,
      });
    }
  }

  // Extract cross-file imports → DEPENDS_ON
  const importPattern = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
  let importMatch: RegExpExecArray | null;
  for (const file of uniqueFiles) {
    const fileText = messages
      .filter((m) => {
        const text = typeof m.content === "string" ? m.content : "";
        return text.includes(file);
      })
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    importPattern.lastIndex = 0;
    while ((importMatch = importPattern.exec(fileText)) !== null) {
      const imported = importMatch[1];
      const sig = `FILE:${file}|DEPENDS_ON|FILE:${imported}`;
      if (seen.has(sig)) continue;
      seen.add(sig);

      triples.push({
        sourceName: file,
        sourceType: "file",
        relation: "DEPENDS_ON",
        targetName: imported,
        targetType: "file",
        evidence: `import ... from '${imported}'`,
        confidence: 0.9,
      });
    }
  }

  return {
    triples,
    entityCount: new Set(triples.flatMap((t) => [t.sourceName, t.targetName])).size,
    relationCount: triples.length,
  };
}

/** Persist extracted triples into the Mnemosyne store */
export function persistTriples(
  store: MnemosyneStore,
  triples: ExtractedTriple[],
  sessionId: string
): { entities: number; relations: number } {
  let entityCount = 0;
  let relationCount = 0;
  const entityIds = new Map<string, number>();

  for (const triple of triples) {
    // Upsert source entity
    const sourceKey = `${triple.sourceType}:${triple.sourceName}`;
    if (!entityIds.has(sourceKey)) {
      entityIds.set(
        sourceKey,
        store.upsertEntity(
          triple.sourceName,
          triple.sourceType as any,
          triple.evidence,
          sessionId,
          triple.confidence
        )
      );
      entityCount++;
    }

    // Upsert target entity
    const targetKey = `${triple.targetType}:${triple.targetName}`;
    if (!entityIds.has(targetKey)) {
      entityIds.set(
        targetKey,
        store.upsertEntity(
          triple.targetName,
          triple.targetType as any,
          "",
          sessionId,
          triple.confidence
        )
      );
      entityCount++;
    }

    // Create relation
    const sourceId = entityIds.get(sourceKey)!;
    const targetId = entityIds.get(targetKey)!;
    store.addRelation(
      sourceId,
      targetId,
      triple.relation as any,
      triple.confidence,
      triple.evidence
    );
    relationCount++;
  }

  return { entities: entityCount, relations: relationCount };
}
