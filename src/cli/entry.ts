#!/usr/bin/env node
// CLI entry point — parses arguments, loads config, runs the agent

import path from "path";
import { loadConfig } from "./config-loader.js";
import { AnsiStreamRenderer } from "./stream-renderer.js";
import { agentLoop } from "../agent/loop.js";
import {
  register,
  getTool,
  getAllTools,
} from "../tools/registry.js";
import { bashTool } from "../tools/bash.js";
import { readTool } from "../tools/read.js";
import { writeTool } from "../tools/write.js";
import { editTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { webFetchTool, webSearchTool } from "../tools/web.js";
import { todoWriteTool } from "../tools/todo.js";

// Register all tools
register(readTool);
register(writeTool);
register(editTool);
register(bashTool);
register(grepTool);
register(globTool);
register(webFetchTool);
register(webSearchTool);
register(todoWriteTool);

// ---- Argument parsing ----

function parseArgs(): {
  prompt: string;
  workdir: string;
  model?: string;
  provider?: string;
} {
  const args = process.argv.slice(2);
  let workdir = process.cwd();
  let model: string | undefined;
  let provider: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-d":
      case "--dir":
        workdir = path.resolve(args[++i] ?? workdir);
        break;
      case "-m":
      case "--model":
        model = args[++i];
        break;
      case "-p":
      case "--provider":
        provider = args[++i];
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        if (!args[i].startsWith("-")) {
          positional.push(args[i]);
        }
    }
  }

  const prompt = positional.join(" ") || getStdinPrompt();

  return { prompt, workdir, model, provider };
}

function getStdinPrompt(): string {
  // Check if there's piped input
  try {
    const { stdin } = process;
    if (!stdin.isTTY) {
      // Synchronous read for piped content
      const fs = require("fs");
      const fd = fs.openSync("/dev/stdin", "r");
      const buffer = Buffer.alloc(1024 * 1024); // 1MB max
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      if (bytesRead > 0) {
        return buffer.toString("utf-8", 0, bytesRead).trim();
      }
    }
  } catch {
    // Not available
  }
  return "";
}

function printHelp(): void {
  console.log(`
coding-agent — A custom coding agent built from scratch

Usage:
  coding-agent [options] <prompt>
  echo "your prompt" | coding-agent [options]

Options:
  -d, --dir <path>    Working directory (default: current directory)
  -m, --model <name>  Model override (e.g. "deepseek-chat", "claude-sonnet-4-20250514")
  -p, --provider <n>  Provider override (e.g. "deepseek", "openai", "anthropic")
  -h, --help          Show this help

Environment:
  DEEPSEEK_API_KEY     DeepSeek API key
  ANTHROPIC_API_KEY    Anthropic API key
  OPENAI_API_KEY       OpenAI API key
  CODING_AGENT_PROVIDER  Default provider
  CODING_AGENT_MODEL     Default model
  CODING_AGENT_BASE_URL  Custom API base URL
  CODING_AGENT_API_KEY   API key override

Config:
  Place .coding-agent.yml in your project root or ~/.coding-agent/config.yml
`);
}

// ---- Main ----

async function main(): Promise<void> {
  const { prompt, workdir, model, provider } = parseArgs();

  if (!prompt) {
    console.log("Usage: coding-agent [options] <prompt>");
    console.log("Try 'coding-agent --help' for more information.");
    process.exit(1);
  }

  const config = loadConfig(workdir);

  // CLI overrides
  if (model) config.model.model = model;
  if (provider) config.model.provider = provider;

  const renderer = new AnsiStreamRenderer();

  console.log(`coding-agent v0.1.0`);
  console.log(`Provider: ${config.model.provider} | Model: ${config.model.model}`);
  console.log(`Working dir: ${workdir}`);
  console.log(`Tools: ${getAllTools().length} registered`);

  renderer.renderUserMessage(prompt);

  try {
    for await (const event of agentLoop({
      config,
      workingDir: workdir,
      prompt,
      renderer,
    })) {
      switch (event.type) {
        case "turn_start":
          // Silent progress
          break;

        case "text":
          // Already rendered by stream
          break;

        case "thinking":
          break;

        case "tool_result":
          renderer.renderToolResult(
            `${event.name}: ${event.isError ? "✖" : "✓"} ${event.result.substring(0, 200)}`
          );
          break;

        case "error":
          renderer.renderError(event.message);
          break;

        case "warning":
          renderer.renderWarning(event.message);
          break;

        case "compacting":
          renderer.renderSystemMessage(`Compacting context: ${event.reason}`);
          break;

        case "done":
          console.log(`\n[Session ended: ${event.reason}]`);
          break;

        case "turn_end":
          // Could show token usage here
          break;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    renderer.renderError(`Fatal: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
