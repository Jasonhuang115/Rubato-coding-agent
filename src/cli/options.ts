import path from "path";
import fs from "fs";
import type { McpServerConfig } from "../tools/mcp/types.js";
import { warnRecoverable } from "../shared/diagnostics.js";

// ---- Argument parsing ----

export function parseArgs(): {
  prompt: string;
  workdir: string;
  model?: string;
  provider?: string;
  interactive: boolean;
  continueSession: boolean;
  resumeSession?: string;
} {
  const args = process.argv.slice(2);
  let workdir = process.cwd();
  let model: string | undefined;
  let provider: string | undefined;
  let interactive = true;   // default: interactive
  let oneShot = false;
  let continueSession = false;
  let resumeSession: string | undefined;
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
      case "-n":
      case "--one-shot":
        oneShot = true;
        interactive = false;
        break;
      case "-c":
      case "--continue":
        continueSession = true;
        break;
      case "-r":
      case "--resume":
        resumeSession = args[++i] ?? "";
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

  // Pipe input → one-shot (can't do REPL over pipe)
  if (!process.stdin.isTTY) {
    interactive = false;
  }

  // Explicit -n overrides
  if (oneShot) {
    interactive = false;
  }

  return { prompt, workdir, model, provider, interactive, continueSession, resumeSession };
}

function getStdinPrompt(): string {
  // Check if there's piped input
  try {
    const { stdin } = process;
    if (!stdin.isTTY) {
      // Synchronous read for piped content
      
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

export function printHelp(): void {
  console.log(`
rubato — elastic tempo for your code

Usage:
  rubato [options] [prompt]       Interactive by default (REPL after answer)
  rubato -n [prompt]              One-shot: answer and exit
  echo "your prompt" | rubato -n [options]

Options:
  -d, --dir <path>    Working directory (default: current directory)
  -m, --model <name>  Model override (e.g. "deepseek-chat", "claude-sonnet-4-20250514")
  -p, --provider <n>  Provider override (e.g. "deepseek", "openai", "anthropic")
  -c, --continue      Resume the most recent session in this project
  -r, --resume [id]   Resume a specific session by ID (or show picker)
  -n, --one-shot      Run once and exit (no REPL)
  -h, --help          Show this help

API Keys:
  Set API keys in .env, .env.local (working dir or ~/.rubato/).
  Shell environment variables override .env files.
  Supported: DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY

REPL Commands:
  /exit, /quit         Exit the chat
  /paste               Send the full clipboard as one prompt
  /clear               Start a fresh session (saves current)
  /sessions            List project sessions
  /sessions resume <n> Resume a past session
  /scrub --dry-run     Audit persisted traces/sessions/artifacts for secrets
  /scrub [path]        Redact secrets from persisted Rubato data
  /help                Show REPL help
  Ctrl+C               Interrupt output / Exit when idle

Config:
  Place .rubato.yml in your project root or ~/.rubato/config.yml
`);
}

// ---- MCP Config Loader ----

export function loadMcpConfigs(workingDir: string): McpServerConfig[] {
  const configs: McpServerConfig[] = [];
  const paths = [
    path.join(workingDir, ".agent", "mcp.json"),
    path.join(process.env.HOME ?? "/tmp", ".rubato", "mcp.json"),
  ];

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
        const servers = (raw.servers ?? raw) as McpServerConfig[] | Record<string, Omit<McpServerConfig, "name">>;
        if (Array.isArray(servers)) {
          configs.push(...servers);
        } else {
          for (const [name, cfg] of Object.entries(servers)) {
            configs.push({ name, ...cfg });
          }
        }
      }
    } catch (error) {
      warnRecoverable(`mcp-config:${p}:load`, error);
    }
  }

  return configs;
}
