// MCP adapter — converts MCP tools into Rubato ToolDefinition format
// Allows MCP servers to be used as regular tools in the agent loop

import type { ToolDefinition, AgentContext } from "../core-types.js";
import type { McpTool, CallToolResult } from "./types.js";
import type { McpClient } from "./client.js";

// ---- MCP Server Manager ----

interface McpServerEntry {
  client: McpClient;
  tools: string[]; // tool names registered from this server
}

const mcpServers = new Map<string, McpServerEntry>();

/** Start an MCP server and register all its tools. */
export async function connectMcpServer(
  client: McpClient,
  serverName: string
): Promise<string[]> {
  if (mcpServers.has(serverName)) {
    throw new Error(`MCP server "${serverName}" is already connected`);
  }

  await client.start();

  const { tools } = await client.listTools();
  const registered: string[] = [];

  for (const mcpTool of tools) {
    const toolDef = adaptMcpTool(mcpTool, client);
    // Tool registration is done by the caller (entry.ts) to avoid circular import issues.
    // We just return the tool names so the caller knows what to register.
    registered.push(mcpTool.name);
  }

  mcpServers.set(serverName, {
    client,
    tools: registered.map((n) => `mcp:${serverName}:${n}`),
  });

  return registered;
}

/** Disconnect an MCP server and unregister all its tools. */
export function disconnectMcpServer(serverName: string): string[] {
  const entry = mcpServers.get(serverName);
  if (!entry) return [];

  entry.client.stop();
  const toolNames = [...entry.tools];
  mcpServers.delete(serverName);
  return toolNames;
}

/** Get a connected MCP client by server name. */
export function getMcpClient(serverName: string): McpClient | undefined {
  const entry = mcpServers.get(serverName);
  return entry?.client;
}

/** List all connected MCP server names. */
export function listMcpServers(): string[] {
  return Array.from(mcpServers.keys());
}

// ---- Tool adaptation ----

/**
 * Convert an MCP tool definition into a Rubato ToolDefinition.
 * The tool's handler delegates to client.callTool().
 */
export function adaptMcpTool(
  mcpTool: McpTool,
  client: McpClient
): ToolDefinition {
  const toolName = mcpTool.name;

  return {
    name: toolName,
    description: mcpTool.description ?? `MCP tool: ${toolName}`,
    inputSchema: mcpTool.inputSchema,
    type: "write", // MCP tools are treated as write tools (side effects possible)
    requiresApproval: true,
    isConcurrencySafe: false,
    handler: async (input: Record<string, unknown>) => {
      const result: CallToolResult = await client.callTool(toolName, input);
      return {
        content: stringifyMcpContent(result.content),
        isError: result.isError ?? false,
      };
    },
  };
}

/**
 * Convert MCP content blocks to a single string.
 */
function stringifyMcpContent(
  content: CallToolResult["content"]
): string {
  return content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "image":
          return `[Image: ${block.mimeType}, ${block.data.length} bytes base64]`;
        case "resource":
          return block.resource.text ?? `[Resource: ${block.resource.uri}]`;
        default:
          return JSON.stringify(block);
      }
    })
    .join("\n");
}

// ---- Batch tool creation for a server ----

/**
 * Create prefixed tool definitions for all tools on an MCP server.
 * Names are prefixed as `mcp:<serverName>:<toolName>` to avoid collisions.
 */
export function adaptMcpServerTools(
  serverName: string,
  mcpTools: McpTool[],
  client: McpClient
): ToolDefinition[] {
  return mcpTools.map((t) => {
    const adapted = adaptMcpTool(t, client);
    return {
      ...adapted,
      name: `mcp:${serverName}:${t.name}`,
      description: `[MCP:${serverName}] ${adapted.description}`,
    };
  });
}
