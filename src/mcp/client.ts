// MCP client — spawns a child process and communicates via JSON-RPC 2.0 over stdio
// Zero external dependencies: uses child_process.spawn + manual JSON framing

import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ListToolsResult,
  CallToolResult,
  McpServerConfig,
  InitializeResult,
} from "./types.js";

// ---- MCP Client ----

export class McpClient {
  private process: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<
    number | string,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (reason: Error) => void;
    }
  >();
  private nextId = 1;
  private serverCapabilities: Record<string, unknown> = {};
  private serverInfo: { name: string; version: string } = { name: "", version: "" };

  constructor(private config: McpServerConfig) {}

  /** Start the MCP server process and perform the initialize handshake. */
  async start(): Promise<InitializeResult> {
    if (this.process) {
      throw new Error("MCP client already started");
    }

    const child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
    });

    this.process = child;

    // Read JSON-RPC messages line by line from stdout
    child.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    // Log stderr for debugging
    child.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        console.error(`[MCP:${this.config.name}] ${msg}`);
      }
    });

    child.on("error", (err) => {
      console.error(`[MCP:${this.config.name}] Process error:`, err.message);
    });

    child.on("close", (code) => {
      // Reject all pending requests
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`MCP server "${this.config.name}" exited with code ${code}`));
      }
      this.pending.clear();
      this.process = null;
    });

    // Perform initialize handshake
    const initResult = await this.initialize();
    return initResult;
  }

  /** Stop the MCP server process. */
  stop(): void {
    if (!this.process) return;
    try {
      this.process.kill();
    } catch {
      // Process might already be dead
    }
    this.process = null;
    this.pending.clear();
  }

  /** Check if the client is connected. */
  isConnected(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /** List available tools from the server. */
  async listTools(): Promise<ListToolsResult> {
    const response = await this.sendRequest({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/list",
    });

    if (response.error) {
      throw new Error(
        `MCP tools/list error: ${response.error.message} (code ${response.error.code})`
      );
    }

    return response.result as ListToolsResult;
  }

  /** Call a tool on the server. */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const response = await this.sendRequest({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });

    if (response.error) {
      return {
        content: [
          {
            type: "text",
            text: `MCP tool "${name}" error: ${response.error.message}`,
          },
        ],
        isError: true,
      };
    }

    return response.result as CallToolResult;
  }

  getServerInfo(): { name: string; version: string } {
    return { ...this.serverInfo };
  }

  getCapabilities(): Record<string, unknown> {
    return { ...this.serverCapabilities };
  }

  // ---- Private ----

  private async initialize(): Promise<InitializeResult> {
    const response = await this.sendRequest({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "Rubato",
          version: "0.1.0",
        },
      },
    });

    if (response.error) {
      throw new Error(
        `MCP initialize error: ${response.error.message} (code ${response.error.code})`
      );
    }

    const result = response.result as InitializeResult;
    this.serverCapabilities = result.capabilities;
    this.serverInfo = result.serverInfo;

    // Send initialized notification (required by MCP spec)
    this.sendNotification({ jsonrpc: "2.0", method: "notifications/initialized" });

    return result;
  }

  private sendRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.process) {
      return Promise.reject(new Error("MCP client not started"));
    }

    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });

      const line = JSON.stringify(request) + "\n";
      this.process!.stdin?.write(line);
    });
  }

  private sendNotification(
    notification: { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> }
  ): void {
    if (!this.process) return;
    const line = JSON.stringify(notification) + "\n";
    this.process.stdin?.write(line);
  }

  private processBuffer(): void {
    // Process complete lines from the buffer
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx < 0) break;

      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line) as JsonRpcResponse;

        // Check if this is a response to a pending request
        if ("id" in message && this.pending.has(message.id)) {
          const { resolve } = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          resolve(message);
        }
        // Notifications and responses without a matching ID are ignored
      } catch {
        // Non-JSON line — could be log output from the server
        console.error(`[MCP:${this.config.name}] Non-JSON: ${line.slice(0, 200)}`);
      }
    }
  }
}
