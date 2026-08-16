import fs from "node:fs";
import path from "node:path";
import { getRubatoHome } from "../shared/rubato-home.js";

const FLUSH_MS = 100;
const FLUSH_BYTES = 4 * 1024;

export class AssistantDraftWriter {
  readonly filePath: string;
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(projectId: string, runId: string) {
    this.filePath = path.join(
      getRubatoHome(),
      "projects",
      projectId,
      "runs",
      safeSegment(runId),
      "assistant-draft.md",
    );
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.closeSync(fs.openSync(this.filePath, "a"));
  }

  append(text: string): void {
    if (!text) return;
    this.buffer += text;
    if (Buffer.byteLength(this.buffer, "utf8") >= FLUSH_BYTES) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
  }

  boundary(label?: "turn_complete" | "interrupted"): void {
    this.flush();
    if (label) {
      fs.appendFileSync(this.filePath, `\n\n<!-- Rubato ${label} -->\n\n`, "utf8");
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.buffer) return;
    fs.appendFileSync(this.filePath, this.buffer, "utf8");
    this.buffer = "";
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
