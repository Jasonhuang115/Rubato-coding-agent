// Git status source — provides repository context

import { spawn } from "child_process";
import type { ContextSource, ContextBlock, AgentContext } from "../core-types.js";

export class GitStatusSource implements ContextSource {
  readonly name = "git-status";
  readonly priority = 30;

  async fetch(_query: string, ctx: AgentContext): Promise<ContextBlock | null> {
    // Check if we're in a git repo
    const isRepo = await gitIsRepo(ctx.workingDir);
    if (!isRepo) return null;

    try {
      const [branch, status, log] = await Promise.all([
        gitBranch(ctx.workingDir),
        gitStatus(ctx.workingDir),
        gitRecentLog(ctx.workingDir, 5),
      ]);

      const parts: string[] = [];
      if (branch) parts.push(`**Branch:** ${branch}`);
      if (status) parts.push(`**Status:**\n${status}`);
      if (log) parts.push(`**Recent commits:**\n${log}`);

      if (parts.length === 0) return null;

      return {
        content: parts.join("\n\n"),
        priority: this.priority,
        source: this.name,
      };
    } catch {
      return null;
    }
  }
}

function gitExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.on("close", (code: number | null) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git exited with ${code}`));
    });

    child.on("error", reject);
  });
}

async function gitIsRepo(cwd: string): Promise<boolean> {
  try {
    await gitExec(["rev-parse", "--git-dir"], cwd);
    return true;
  } catch {
    return false;
  }
}

async function gitBranch(cwd: string): Promise<string | null> {
  try {
    return await gitExec(["branch", "--show-current"], cwd);
  } catch {
    return null;
  }
}

async function gitStatus(cwd: string): Promise<string | null> {
  try {
    return await gitExec(["status", "--short"], cwd);
  } catch {
    return null;
  }
}

async function gitRecentLog(cwd: string, count: number): Promise<string | null> {
  try {
    return await gitExec(
      ["log", `-${count}`, "--oneline", "--no-decorate"],
      cwd
    );
  } catch {
    return null;
  }
}
