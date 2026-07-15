// Bash tool — executes shell commands

import { exec, spawn } from "child_process";
import type { ToolDefinition, AgentContext } from "../core-types.js";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes

export const bashTool: ToolDefinition = {
  name: "Bash",
  description:
    "Execute a shell command in the working directory. Returns stdout and stderr. " +
    "Long-running commands are killed after the timeout. " +
    "Use this for git operations, npm/yarn, builds, tests, and file system tasks.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      timeout: {
        type: "number",
        description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})`,
      },
      description: {
        type: "string",
        description: "Short description of what this command does",
      },
      workdir: {
        type: "string",
        description: "Working directory override (defaults to session working directory)",
      },
    },
    required: ["command"],
  },
  type: "write",
  requiresApproval: true,
  isConcurrencySafe: false, // bash commands should not run concurrently
  async handler(input) {
    const command = input.command as string;
    const timeout = Math.min(
      (input.timeout as number) ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    );
    const workdir = (input.workdir as string) ?? process.cwd();

    return new Promise((resolve) => {
      // Use spawn with shell for proper handling of pipes, redirects, etc.
      const child = spawn(command, {
        shell: true,
        cwd: workdir,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        // Give it 2 seconds, then SIGKILL
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 2000);
      }, timeout);

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);

        let content = "";
        if (stdout) content += stdout;
        if (stderr) content += (content ? "\n[stderr]\n" : "") + stderr;

        if (killed) {
          content += `\n[Command killed after ${timeout}ms timeout]`;
        }

        if (!content) {
          content = `[Command exited with code ${code}]`;
        }

        resolve({
          content,
          isError: killed || (code !== 0 && code !== null),
        });
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve({
          content: `Failed to execute command: ${err.message}`,
          isError: true,
        });
      });
    });
  },
};
