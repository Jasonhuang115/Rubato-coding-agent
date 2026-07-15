// ANSI StreamRenderer — renders agent output to the terminal
// Phase 1: Pure ANSI escape codes (no Ink dependency)
// Phase 2: Replaced by Ink TUI with full React component tree

import type { StreamRenderer } from "../core-types.js";
import chalk from "chalk";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET_BOLD = "\x1b[22m";

export class AnsiStreamRenderer implements StreamRenderer {
  private lineBuf = "";
  private thinkingMode = false;
  private inCodeBlock = false;
  private codeBlockLang = "";

  renderUserMessage(text: string): void {
    console.log(chalk.blue("\n▸ You:") + " " + text);
  }

  renderAssistantMessage(text: string): void {
    this.thinkingMode = false;
    this.lineBuf += text;
    this.drain();
  }

  /** Flush any pending line — call after streaming completes */
  flush(): void {
    // Close any open code block
    if (this.inCodeBlock) {
      this.inCodeBlock = false;
    }
    // Flush remaining buffer
    if (this.lineBuf) {
      process.stdout.write(formatInline(this.lineBuf));
      this.lineBuf = "";
    }
    // Ensure trailing newline
    if (!this.lineBuf.endsWith("\n")) {
      // nothing to do — drain already flushed
    }
    process.stdout.write("\n");
  }

  // ---- internal: line-buffered drain ----

  private drain(): void {
    while (true) {
      const nl = this.lineBuf.indexOf("\n");
      if (nl === -1) return; // wait for more
      const line = this.lineBuf.slice(0, nl + 1); // includes \n
      this.lineBuf = this.lineBuf.slice(nl + 1);
      this.emitLine(line);
    }
  }

  private emitLine(raw: string): void {
    const trimmed = raw.trimEnd(); // keep \n for writing
    const content = trimmed; // line without \n

    // Detect fenced code block start/end
    const fenceMatch = content.match(/^\s*```(\w*)\s*$/);
    if (fenceMatch) {
      if (!this.inCodeBlock) {
        this.inCodeBlock = true;
        this.codeBlockLang = fenceMatch[1] || "";
        // Emit a dimmed "─── {lang} ───" separator instead of the fence
        const label = this.codeBlockLang ? ` ${this.codeBlockLang} ` : "";
        process.stdout.write(chalk.dim(`\n  ┌${label.replace(/./g, "─")}┐\n`));
      } else {
        this.inCodeBlock = false;
        this.codeBlockLang = "";
        process.stdout.write(chalk.dim("  └───\n"));
      }
      return;
    }

    if (this.inCodeBlock) {
      // Code content: dim it, no inline formatting
      process.stdout.write(chalk.dim(`  │ ${content}`) + "\n");
      return;
    }

    // Blockquote: > text
    if (/^\s*>\s?/.test(content)) {
      const inner = content.replace(/^\s*>\s?/, "");
      process.stdout.write(chalk.dim("  ▏") + formatInline(inner) + "\n");
      return;
    }

    // Horizontal rule
    if (/^\s*[-*_]{3,}\s*$/.test(content)) {
      process.stdout.write(chalk.dim("  ─────────────────\n"));
      return;
    }

    // Normal line with inline formatting
    process.stdout.write(formatInline(content) + "\n");
  }

  renderThinking(_text: string): void {
    if (!this.thinkingMode) {
      console.log(chalk.dim("\n  ⟐ Thinking..."));
      this.thinkingMode = true;
    }
  }

  renderSystemMessage(text: string): void {
    console.log(chalk.gray("  • ") + chalk.gray(text));
  }

  renderToolUse(tool: string, input: unknown): void {
    const inputStr =
      typeof input === "object" && input !== null
        ? JSON.stringify(input, null, 0).substring(0, 200)
        : String(input);

    const icon = getToolIcon(tool);
    console.log(chalk.yellow(`\n  ${icon} ${tool}`) + chalk.dim(` — ${inputStr}`));
  }

  renderToolResult(result: string): void {
    const lines = result.split("\n");
    const preview =
      lines.slice(0, 3).join("\n") +
      (lines.length > 3 ? chalk.dim(`\n  ... (${lines.length - 3} more lines)`) : "");

    console.log(chalk.gray("  └─ ") + chalk.gray(preview.replace(/\n/g, "\n     ")));
  }

  renderError(error: string): void {
    console.log(chalk.red("\n  ✖ Error: ") + chalk.red(error));
  }

  renderWarning(warning: string): void {
    console.log(chalk.yellow("\n  ⚠ ") + chalk.yellow(warning));
  }

  clear(): void {
    console.clear();
  }
}

// ---- Markdown → ANSI (inline only; blocks handled by the line state machine) ----

function formatInline(text: string): string {
  // **bold**
  let result = text.replace(/\*\*(.+?)\*\*/g, (_, inner: string) => {
    return `${BOLD}${inner}${RESET_BOLD}`;
  });

  // *italic* (single *, not **)
  result = result.replace(
    /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
    (_, inner: string) => `${DIM}${inner}${RESET_BOLD}`
  );

  // `inline code`
  result = result.replace(/`([^`]+)`/g, (_, inner: string) => chalk.cyan(inner));

  // ~~strikethrough~~
  result = result.replace(/~~(.+?)~~/g, (_, inner: string) => chalk.strikethrough(inner));

  // [link text](url) → underlined text only
  result = result.replace(
    /\[([^\]]+)\]\([^)]+\)/g,
    (_, linkText: string) => chalk.underline(linkText)
  );

  // ### headings → bold
  result = result.replace(/^#{1,6}\s+(.+)$/, (_, h: string) => `${BOLD}${h}${RESET_BOLD}`);

  // Numbered list marker → dim it
  result = result.replace(/^(\s*\d+\.)\s/, (_, num: string) => `${chalk.dim(num)} `);

  // Bullet marker → dim it
  result = result.replace(/^(\s*[-*])\s/, (_, bullet: string) => `${chalk.dim(bullet)} `);

  return result;
}

// ---- Tool icons ----

function getToolIcon(tool: string): string {
  switch (tool.toLowerCase()) {
    case "read":
      return "📖";
    case "write":
      return "✏️";
    case "edit":
      return "🔧";
    case "bash":
      return "⚡";
    case "grep":
      return "🔍";
    case "glob":
      return "📂";
    case "todowrite":
      return "📋";
    case "webfetch":
      return "🌐";
    case "websearch":
      return "🔎";
    default:
      return "🔨";
  }
}
