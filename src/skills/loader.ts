// Skill loader — scans directories, parses skill files, watches for changes
// Primary format: skill-name/SKILL.md (directory with resources)
// Legacy format: single .md file (still supported, lower priority)
// Plugin format: .ts/.js file (loaded via dynamic import)

import fs from "fs";
import path from "path";
import { parseSimpleYaml } from "../agent/agent-defs.js";
import type { SkillDefinition } from "./types.js";
import { getSkillRegistry } from "./registry.js";

// ---- Directory priority (later overrides earlier) ----

/**
 * Returns the list of skill directories to scan, in priority order.
 * Later directories override earlier ones for same-named skills.
 */
export function getSkillDirs(projectDir: string): string[] {
  const dirs: string[] = [];

  // 1. Built-in skills (lowest priority)
  const builtinDir = path.resolve(
    new URL(".", import.meta.url).pathname,
    "builtin"
  );
  if (fs.existsSync(builtinDir)) {
    dirs.push(builtinDir);
  }

  // 2. Global user skills
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const globalDir = path.join(homeDir, ".rubato", "skills");
  if (fs.existsSync(globalDir)) {
    dirs.push(globalDir);
  }

  // 3. Project skills (highest priority)
  const projectSkillsDir = path.join(projectDir, ".rubato", "skills");
  if (fs.existsSync(projectSkillsDir)) {
    dirs.push(projectSkillsDir);
  }

  return dirs;
}

// ---- Main load function ----

/**
 * Load all skills from all directories. Later dirs override earlier ones.
 * Returns the list of loaded skill names.
 */
export function loadAllSkills(projectDir: string): string[] {
  const dirs = getSkillDirs(projectDir);
  const registry = getSkillRegistry();
  const loaded: string[] = [];

  for (const dir of dirs) {
    try {
      const skills = scanSkillsDir(dir);
      for (const skill of skills) {
        try {
          // If a skill with the same name was already loaded from a lower-priority dir,
          // unregister it first so the higher-priority one takes over.
          if (registry.getSkill(skill.name)) {
            registry.unregisterSkill(skill.name);
          }
          registry.registerSkill(skill);
          loaded.push(skill.name);
        } catch (err) {
          // Duplicate registration or other error — skip this skill
          console.error(
            `[SkillLoader] Failed to register skill "${skill.name}" from ${dir}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    } catch (err) {
      console.error(
        `[SkillLoader] Failed to scan directory ${dir}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return loaded;
}

// ---- Directory scanner ----

/**
 * Scan a single directory for skill files.
 * Primary format: subdirectory/SKILL.md (e.g. `code-review/SKILL.md`)
 * Legacy format: single .md file (e.g. `code-review.md`) — lower priority
 * Plugin format: .ts/.js files (Level 3, deferred)
 *
 * Directory format wins over single-file format when both exist with the same name.
 */
export function scanSkillsDir(dir: string): SkillDefinition[] {
  if (!fs.existsSync(dir)) return [];

  const skills: SkillDefinition[] = [];
  const seen = new Set<string>();

  try {
    // First pass: directory format (primary — wins over same-named .md files)
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) continue;

        const skillMdPath = path.join(fullPath, "SKILL.md");
        if (fs.existsSync(skillMdPath)) {
          const def = parseSkillFile(skillMdPath);
          if (def) {
            def.sourcePath = skillMdPath;
            def.resourceDir = fullPath;
            skills.push(def);
            seen.add(def.name);
          }
        }
      } catch { /* skip unreadable entries */ }
    }

    // Second pass: legacy single .md files (only if not already seen)
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const skillName = entry.slice(0, -3); // strip .md
      if (seen.has(skillName)) continue; // directory format already covered this

      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        const def = parseSkillFile(fullPath);
        if (def) {
          def.sourcePath = fullPath;
          skills.push(def);
          seen.add(def.name);
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    console.error(
      `[SkillLoader] Error reading directory ${dir}:`,
      err instanceof Error ? err.message : err
    );
  }

  return skills;
}

// ---- File parser ----

/**
 * Parse a single skill SKILL.md file.
 * Format:
 *   ---
 *   name: my-skill
 *   description: Does something useful
 *   tools: Read, Grep, Glob, Bash
 *   model: inherit
 *   context: inline           # inline (default) | fork
 *   maxTurns: 15              # fork-mode only
 *   allowed-tools: Bash(git add *) Bash(git commit *)
 *   disable-model-invocation: false
 *   ---
 *   System prompt body...
 */
export function parseSkillFile(filePath: string): SkillDefinition | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.startsWith("---")) return null;

    const endIdx = content.indexOf("---", 3);
    if (endIdx < 0) return null;

    const fm = parseSimpleYaml(content.slice(3, endIdx).trim());
    const fName = fm.name as string | undefined;

    // name is the only required field
    if (!fName) return null;

    const systemPrompt = content.slice(endIdx + 3).trim() || undefined;

    return {
      name: fName,
      description: (fm.description as string) ?? undefined,
      systemPrompt,
      tools: parseToolsField(fm.tools),
      model: (fm.model as string) ?? "inherit",
      context: parseContextField(fm.context),       // undefined → default "inline"
      allowModelInvocation: fm["disable-model-invocation"] !== undefined
        ? !(fm["disable-model-invocation"] as boolean)
        : true,
      maxTurns:
        fm.maxTurns !== undefined ? (fm.maxTurns as number) : undefined,
      allowedTools: parseAllowedTools(fm["allowed-tools"]),
    };
  } catch {
    return null;
  }
}

// ---- Field parsers ----

function parseToolsField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  if (Array.isArray(val)) {
    const tools = val.map((s) => String(s).trim()).filter((s) => s.length > 0);
    return tools.length > 0 ? tools : undefined;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed === "" || trimmed === "*") return ["*"];
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
}

function parseContextField(val: unknown): "inline" | "fork" | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim().toLowerCase();
  if (s === "inline") return "inline";
  if (s === "fork") return "fork";
  return undefined;
}

/**
 * Parse allowed-tools field. Supports two formats:
 *   - YAML list: ["Bash(git add *)", "Bash(git commit *)"]
 *   - YAML string: "Bash(git add *), Bash(git commit *)"
 *   - Single string: "Bash(git add *)"
 * Returns undefined if not specified.
 */
function parseAllowedTools(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  if (Array.isArray(val)) {
    const rules = val.map((s) => String(s).trim()).filter((s) => s.length > 0);
    return rules.length > 0 ? rules : undefined;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return undefined;
    // Could be comma-separated
    const rules = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return rules.length > 0 ? rules : undefined;
  }
  return undefined;
}

// ---- Hot-reload (fs.watch) ----

/**
 * Watch skill directories for changes and reload when files are added/removed.
 * Debounces rapid changes to avoid repeated reloads.
 *
 * Returns a cleanup function that closes all watchers.
 */
export function watchSkills(
  projectDir: string,
  onChange: (added: string[], removed: string[]) => void,
  debounceMs: number = 200
): () => void {
  const dirs = getSkillDirs(projectDir);
  const watchers: fs.FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const scheduleReload = () => {
    if (pending) return;
    pending = true;
    timer = setTimeout(() => {
      pending = false;
      try {
        const prevSkills = new Set(
          getSkillRegistry()
            .listSkills()
            .map((s) => s.name)
        );
        loadAllSkills(projectDir);
        const newSkills = new Set(
          getSkillRegistry()
            .listSkills()
            .map((s) => s.name)
        );

        const added = [...newSkills].filter((n) => !prevSkills.has(n));
        const removed = [...prevSkills].filter((n) => !newSkills.has(n));

        if (added.length > 0 || removed.length > 0) {
          onChange(added, removed);
        }
      } catch (err) {
        console.error(
          "[SkillLoader] Hot-reload failed:",
          err instanceof Error ? err.message : err
        );
      }
    }, debounceMs);
  };

  for (const dir of dirs) {
    try {
      const watcher = fs.watch(dir, { persistent: false }, (eventType) => {
        if (eventType === "rename") {
          // File added or removed
          scheduleReload();
        }
      });
      watcher.on("error", () => {
        // Watcher can fail on some platforms — ignore
      });
      watchers.push(watcher);
    } catch {
      // Directory might not exist or be unwatchable
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}

// ---- Level 3 plugin loader (deferred) ----

/**
 * Load a Level 3 skill plugin (.ts/.js file).
 * Requires the plugin to default-export a SkillPlugin object.
 *
 * NOTE: This uses dynamic import(), which requires the runtime to support
 * transpiling TypeScript on-the-fly (e.g., tsx, ts-node) or be pre-compiled.
 * For now, Level 3 plugins should be compiled to .js before loading.
 */
export async function loadSkillPlugin(
  filePath: string
): Promise<SkillDefinition | null> {
  try {
    const mod = await import(filePath);
    const plugin = mod.default ?? mod;

    if (!plugin || typeof plugin.name !== "string") {
      console.error(`[SkillLoader] Plugin at ${filePath} has no "name" export`);
      return null;
    }

    return {
      name: plugin.name as string,
      description: plugin.description as string | undefined,
      systemPrompt: plugin.systemPrompt as string | undefined,
      tools: parseToolsField(plugin.tools),
      model: (plugin.model as string) ?? "inherit",
      context: parseContextField(plugin.context),
      allowModelInvocation:
        plugin.allowModelInvocation !== undefined
          ? (plugin.allowModelInvocation as boolean)
          : true,
      sourcePath: filePath,
      onLoad: plugin.onLoad as SkillDefinition["onLoad"],
      onUnload: plugin.onUnload as SkillDefinition["onUnload"],
    };
  } catch (err) {
    console.error(
      `[SkillLoader] Failed to load plugin ${filePath}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
