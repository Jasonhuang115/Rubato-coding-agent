// MCP (Model Context Protocol) — JSON-RPC 2.0 types
// Implements the minimum subset: tools/list + tools/call
// Spec: https://spec.modelcontextprotocol.io/

// ---- JSON-RPC 2.0 ----

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification;

// ---- MCP protocol messages ----

/** Server → Client: list available tools */
export interface ListToolsRequest extends JsonRpcRequest {
  method: "tools/list";
}

export interface ListToolsResult {
  tools: McpTool[];
}

/** Client → Server: call a tool */
export interface CallToolRequest extends JsonRpcRequest {
  method: "tools/call";
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface CallToolResult {
  content: McpContent[];
  isError?: boolean;
}

// ---- MCP tool definition ----

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ---- MCP content types ----

export type McpContent =
  | McpTextContent
  | McpImageContent
  | McpResourceContent;

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface McpResourceContent {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string; // base64
  };
}

// ---- MCP server config ----

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ---- Initialize ----

export interface InitializeRequest extends JsonRpcRequest {
  method: "initialize";
  params: {
    protocolVersion: string;
    capabilities: Record<string, unknown>;
    clientInfo: {
      name: string;
      version: string;
    };
  };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: {
    name: string;
    version: string;
  };
}
