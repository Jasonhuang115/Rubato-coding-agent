import fs from "fs";
import path from "path";
import YAML from "yaml";
import { MemoryStore } from "../memory/store.js";
import { getRubatoHome } from "../shared/rubato-home.js";
import type { AgentConfig } from "../shared/core-types.js";

export function handleMemoryCommand(
  input: string,
  projectId: string,
  config: AgentConfig,
): void {
  const args = input.trim().split(/\s+/).slice(1);
  const action = args[0] ?? "status";
  const store = new MemoryStore({ projectId });

  if (action === "status") {
    console.log("\n  ── Agent-managed memory ──");
    console.log(`  enabled: ${config.memory?.enabled !== false}`);
    printNamespace("project", config.memory?.projectEnabled !== false, store.root("project"));
    printNamespace("user", config.memory?.userEnabled !== false, store.root("user"));
    return;
  }
  if (action === "paths") {
    console.log(`\n  Project memory: ${store.root("project")}`);
    console.log(`  User memory:    ${store.root("user")}`);
    return;
  }
  if (action === "on" || action === "off") {
    config.memory ??= { enabled: true, projectEnabled: true, userEnabled: true };
    config.memory.enabled = action === "on";
    persistMemoryConfig(config.memory);
    console.log(`\n  Memory ${action === "on" ? "enabled" : "disabled"}.`);
    return;
  }
  if ((action === "project" || action === "user") && ["on", "off"].includes(args[1])) {
    config.memory ??= { enabled: true, projectEnabled: true, userEnabled: true };
    const enabled = args[1] === "on";
    if (action === "project") config.memory.projectEnabled = enabled;
    else config.memory.userEnabled = enabled;
    persistMemoryConfig(config.memory);
    console.log(`\n  ${action} memory ${enabled ? "enabled" : "disabled"}.`);
    return;
  }
  console.log(
    "\n  Usage: /memory status | paths | on | off | project on|off | user on|off",
  );
}

export function handleLegacyMemoryCommand(command: string): void {
  console.log(
    `\n  ${command.split(/\s+/)[0]} belonged to the retired verified-memory system. ` +
      "Use /memory status or ask the Agent to remember, update, or forget information.",
  );
}

function printNamespace(label: string, enabled: boolean, root: string): void {
  console.log(
    `  ${label}: ${enabled ? "enabled" : "disabled"} | ${root} | ` +
      `${countMarkdownFiles(root)} files | ${directoryBytes(root)} bytes`,
  );
}

function countMarkdownFiles(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  walk(root, (filePath) => { if (filePath.endsWith(".md")) count++; });
  return count;
}

function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let bytes = 0;
  walk(root, (filePath) => { bytes += fs.statSync(filePath).size; });
  return bytes;
}

function walk(root: string, visit: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === ".memory.lock") continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) walk(entryPath, visit);
    else if (entry.isFile()) visit(entryPath);
  }
}

function persistMemoryConfig(memory: NonNullable<AgentConfig["memory"]>): void {
  const configPath = path.join(getRubatoHome(), "config.yml");
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      existing = YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {};
    }
  } catch {
    existing = {};
  }
  existing.memory = {
    enabled: memory.enabled,
    projectEnabled: memory.projectEnabled,
    userEnabled: memory.userEnabled,
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp`;
  fs.writeFileSync(temporary, YAML.stringify(existing), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, configPath);
}
