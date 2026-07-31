import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

export interface SessionCatalogRecord {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  firstMessage: string;
  model: string;
  messageCount: number;
  tokenCount: number;
  status: "active" | "ended";
  summary?: string;
}

const COLUMNS = [
  "session_id",
  "created_at",
  "last_active_at",
  "status",
  "model",
  "message_count",
  "token_count",
  "first_message",
  "summary",
  "transcript",
] as const;

export function sessionCatalogPath(projectBaseDir: string): string {
  return path.join(path.resolve(projectBaseDir), "session-catalog.tsv");
}

export function buildSessionCatalog(
  records: ReadonlyArray<SessionCatalogRecord>,
): string {
  const lines = [COLUMNS.join("\t")];
  for (const record of [...records].sort((left, right) =>
    right.lastActiveAt - left.lastActiveAt ||
    left.id.localeCompare(right.id))) {
    lines.push([
      record.id,
      new Date(record.createdAt).toISOString(),
      new Date(record.lastActiveAt).toISOString(),
      record.status,
      record.model,
      String(Math.max(0, Math.round(record.messageCount))),
      String(Math.max(0, Math.round(record.tokenCount))),
      record.firstMessage,
      record.summary ?? "",
      `sessions/${record.id}.jsonl`,
    ].map(escapeTsv).join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

export function writeSessionCatalog(
  projectBaseDir: string,
  records: ReadonlyArray<SessionCatalogRecord>,
): string {
  const filePath = sessionCatalogPath(projectBaseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp.${randomUUID()}`;
  fs.writeFileSync(temporary, buildSessionCatalog(records), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
  return filePath;
}

function escapeTsv(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\t/gu, "\\t")
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n");
}
