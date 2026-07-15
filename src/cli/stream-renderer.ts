// ANSI StreamRenderer — renders agent output to the terminal
// Phase 1: Pure ANSI escape codes (no Ink dependency)
// Phase 2: Replaced by Ink TUI with full React component tree

import type { StreamRenderer } from "../core-types.js";
import chalk from "chalk";

export class AnsiStreamRenderer implements StreamRenderer {
  private currentLine = "";
  private thinkingMode = false;

  renderUserMessage(text: string): void {
    console.log(chalk.blue("\n▸ You:") + " " + text);
  }

  renderAssistantMessage(text: string): void {
    // Streaming text — write without newline, flush on newlines
    this.thinkingMode = false;
    for (const char of text) {
      if (char === "\n") {
        console.log(this.currentLine);
        this.currentLine = "";
      } else {
        this.currentLine += char;
      }
    }
    // Flush any remaining
    if (this.currentLine && text.endsWith("\n")) {
      console.log(this.currentLine);
      this.currentLine = "";
    }
  }

  renderThinking(text: string): void {
    if (!this.thinkingMode) {
      console.log(chalk.dim("\n  ⟐ Thinking..."));
      this.thinkingMode = true;
    }
    // Don't render individual thinking deltas — too noisy
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
