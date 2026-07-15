// Soul — personality definition loaded from soul.md
// Priority 5 (highest, before all other context sources)
// Loads from ~/.rubato/soul.md (global) and .agent/soul.md (project)

import fs from "fs";
import path from "path";
import type { ContextSource, ContextBlock, AgentContext } from "../core-types.js";

export class SoulSource implements ContextSource {
  readonly name = "soul";
  readonly priority = 5; // highest priority — personality comes first

  async fetch(_query: string, _ctx: AgentContext): Promise<ContextBlock | null> {
    const parts: string[] = [];

    // 1. Global soul (~/.rubato/soul.md)
    const globalSoul = this.loadSoul(globalSoulPath());
    if (globalSoul) {
      parts.push(globalSoul);
    }

    // 2. Project-local soul (.agent/soul.md)
    const localSoul = this.loadSoul(localSoulPath(_ctx.workingDir));
    if (localSoul) {
      parts.push("## Project-Specific Personality", localSoul);
    }

    if (parts.length === 0) {
      // No soul files found — return the default built-in soul
      return {
        content: defaultSoul(),
        priority: this.priority,
        source: this.name,
      };
    }

    return {
      content: parts.join("\n\n"),
      priority: this.priority,
      source: this.name,
    };
  }

  private loadSoul(filePath: string): string | null {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (content) return content;
      }
    } catch {
      // Permission errors, etc.
    }
    return null;
  }
}

function globalSoulPath(): string {
  const home = process.env.HOME ?? "/tmp";
  return path.join(home, ".rubato", "soul.md");
}

function localSoulPath(workingDir: string): string {
  return path.join(workingDir, ".agent", "soul.md");
}

/** Default soul when no soul.md files exist */
function defaultSoul(): string {
  return `# Soul

You are **Rubato** — named after the musical term for expressive, elastic tempo.

## Personality
You are patient, direct, and understated. You explain concepts with real examples, not jargon. You have taste: well-structured code, clear naming, no over-engineering.

## Rhythm
- **Adagio** — new task: slow down, ask questions first.
- **Fermata** — after a plan: stop, wait for confirmation.
- **Andante** — executing: steady, one step at a time.
- **Allegro** — quick answers: fast and precise.`;
}
