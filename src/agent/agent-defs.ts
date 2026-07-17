// Custom agent definitions — load from .rubato/agents/*.md
// YAML frontmatter + markdown body (system prompt)

import fs from "fs";
import path from "path";
import type { SubagentDefinition } from "../core-types.js";

let customDefs: SubagentDefinition[] = [];

export function loadCustomDefinitions(projectDir: string): SubagentDefinition[] {
  const agentsDir = path.join(projectDir, ".rubato", "agents");
  if (!fs.existsSync(agentsDir)) return [];
  const definitions: SubagentDefinition[] = [];
  try {
    for (const file of fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"))) {
      try { const def = parseAgentFile(path.join(agentsDir, file)); if (def) definitions.push(def); } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return definitions;
}

function parseAgentFile(filePath: string): SubagentDefinition | null {
  const content = fs.readFileSync(filePath, "utf-8");
  if (!content.startsWith("---")) return null;
  const endIdx = content.indexOf("---", 3);
  if (endIdx < 0) return null;

  const fm = parseSimpleYaml(content.slice(3, endIdx).trim());
  const fName = fm.name as string | undefined;
  const fDesc = fm.description as string | undefined;
  if (!fName || !fDesc) return null;

  const systemPrompt = content.slice(endIdx + 3).trim() || `You are the "${fName}" agent. ${fDesc}`;

  return {
    name: fName,
    description: fDesc,
    systemPrompt,
    tools: (fm.tools as string[]) ?? ["*"],
    model: (fm.model as string) ?? "inherit",
    readonly: (fm.readonly as boolean) ?? false,
    maxTurns: (fm.maxTurns as number) ?? 15,
  };
}

export function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value: unknown = trimmed.slice(colonIdx + 1).trim();
    if (typeof value === "string") {
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (value === "true") value = true;
      else if (value === "false") value = false;
      // Guards: after boolean coercion, value may no longer be a string
      if (typeof value === "string") {
        // Array check before number check — parseInt would change the type
        if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1).split(",").map((s) => s.trim().replace(/['"]/g, ""));
        else if (/^\d+$/.test(value)) value = parseInt(value, 10);
      }
    }
    result[key] = value;
  }
  return result;
}

export function initCustomDefinitions(projectDir: string): void {
  customDefs = loadCustomDefinitions(projectDir);
}

export async function getAllDefinitions(): Promise<SubagentDefinition[]> {
  const { getBuiltinDefinition } = await import("./subagent.js");
  return ["explore", "general", "verify"].map((n) => getBuiltinDefinition(n)).concat(customDefs);
}

export async function findDefinition(name: string): Promise<SubagentDefinition | null> {
  try { const { getBuiltinDefinition } = await import("./subagent.js"); return getBuiltinDefinition(name); } catch { /* not built-in */ }
  return customDefs.find((d) => d.name === name) ?? null;
}

export function getCustomDefinitions(): SubagentDefinition[] { return [...customDefs]; }
