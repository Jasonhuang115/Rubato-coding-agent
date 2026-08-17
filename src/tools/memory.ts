import type { ToolDefinition } from "../shared/core-types.js";
import {
  MemoryStore,
  type MemoryNamespace,
} from "../memory/store.js";

export const memoryTool: ToolDefinition = {
  name: "Memory",
  description:
    "Write durable Markdown memory without user approval. " +
    "Read memory with native Read/Grep/Glob against the injected filesystem paths. " +
    "Use project memory for this repository's non-obvious decisions and rationale; " +
    "use user memory only for MEMORY.md, the long-term user portrait. " +
    "Do not write every session. Keep project MEMORY.md as a concise index and move details to topic files. " +
    "str_replace requires a unique old_str; prefer revising existing notes over creating new files.",
  inputSchema: {
    type: "object",
    properties: {
      namespace: { type: "string", enum: ["project", "user"] },
      command: {
        type: "string",
        enum: ["view", "create", "str_replace", "insert", "rename", "delete"],
      },
      path: { type: "string", description: "Relative path inside the selected namespace" },
      start_line: { type: "number", description: "First line for view (1-indexed)" },
      end_line: { type: "number", description: "Last line for view (inclusive)" },
      file_text: { type: "string" },
      old_str: { type: "string" },
      new_str: { type: "string" },
      insert_line: { type: "number", description: "Insert after this line; 0 inserts first" },
      insert_text: { type: "string" },
      new_path: { type: "string" },
    },
    required: ["namespace", "command", "path"],
  },
  type: "write",
  requiresApproval: false,
  isConcurrencySafe: false,
  async handler(input, ctx) {
    if (ctx.depth !== 0) {
      return { content: "Only the root agent may access durable memory.", isError: true };
    }
    try {
      const namespace = parseNamespace(input.namespace);
      const command = requiredString(input.command, "command");
      const relativePath = requiredString(input.path, "path", true);
      if (ctx.config.memory?.enabled === false) throw new Error("Memory is disabled.");
      if (namespace === "project" && ctx.config.memory?.projectEnabled === false) {
        throw new Error("Project memory is disabled.");
      }
      if (namespace === "user" && ctx.config.memory?.userEnabled === false) {
        throw new Error("User memory is disabled.");
      }
      if (!ctx.projectId) throw new Error("No root project identity is available.");
      const store = new MemoryStore({ projectId: ctx.projectId });

      if (command === "view") {
        const view = store.view(
          namespace,
          relativePath,
          optionalInteger(input.start_line, 1),
          typeof input.end_line === "number" ? Math.trunc(input.end_line) : undefined,
        );
        return { content: JSON.stringify(view, null, 2) };
      }

      const result = command === "create"
        ? store.create(namespace, relativePath, requiredString(input.file_text, "file_text", true))
        : command === "str_replace"
          ? store.replace(
              namespace,
              relativePath,
              requiredString(input.old_str, "old_str"),
              requiredString(input.new_str, "new_str", true),
            )
          : command === "insert"
            ? store.insert(
                namespace,
                relativePath,
                requiredInteger(input.insert_line, "insert_line"),
                requiredString(input.insert_text, "insert_text", true),
              )
            : command === "rename"
              ? store.rename(
                  namespace,
                  relativePath,
                  requiredString(input.new_path, "new_path"),
                )
              : command === "delete"
                ? store.delete(namespace, relativePath)
                : (() => { throw new Error(`Unsupported memory command: ${command}`); })();
      return { content: JSON.stringify(result, null, 2) };
    } catch (error) {
      return {
        content: `Memory operation failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

function parseNamespace(value: unknown): MemoryNamespace {
  if (value === "project" || value === "user") return value;
  throw new Error("namespace must be project or user.");
}

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be a string${allowEmpty ? "" : " and cannot be empty"}.`);
  }
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}

function optionalInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}
