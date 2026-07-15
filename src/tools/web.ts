// Web tool — web fetch and search (Phase 1: stubs, Phase 2: full implementation)

import type { ToolDefinition, AgentContext } from "../core-types.js";

export const webFetchTool: ToolDefinition = {
  name: "WebFetch",
  description:
    "Fetch a URL and extract its content as markdown. " +
    "In Phase 1, this is a stub — web access is not yet available. " +
    "Use other tools (Read, Grep, Glob) to work with local files instead.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch",
      },
      prompt: {
        type: "string",
        description: "What to extract from the page",
      },
    },
    required: ["url", "prompt"],
  },
  type: "read",
  requiresApproval: true,
  isConcurrencySafe: true,
  async handler(input) {
    const url = input.url as string;
    return {
      content:
        `WebFetch is not available in Phase 1.\n` +
        `Requested URL: ${url}\n` +
        `In Phase 2, this will use an HTTP client to fetch and convert pages to markdown. ` +
        `For now, use Read, Grep, or Glob for local file access.`,
      isError: false,
    };
  },
};

export const webSearchTool: ToolDefinition = {
  name: "WebSearch",
  description:
    "Search the web and return results. " +
    "In Phase 1, this is a stub — web search is not yet available.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "Only include results from these domains",
      },
    },
    required: ["query"],
  },
  type: "read",
  requiresApproval: true,
  isConcurrencySafe: true,
  async handler(input) {
    const query = input.query as string;
    return {
      content:
        `WebSearch is not available in Phase 1.\n` +
        `Query: "${query}"\n` +
        `In Phase 2, this will use a search API to find relevant web pages. ` +
        `For now, use local tools (Read, Grep, Glob) for code exploration.`,
      isError: false,
    };
  },
};
