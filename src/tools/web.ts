// Web tool — web fetch and search (Tavily API)
import type { ToolDefinition, AgentContext } from "../core-types.js";

// ---- WebFetch ----

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_SIZE = 500_000; // 500KB

export const webFetchTool: ToolDefinition = {
  name: "WebFetch",
  description:
    "Fetch a URL and convert its content to markdown. " +
    "Returns the page content as text, with basic HTML stripped. " +
    "Useful for reading documentation, articles, and web pages.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch (http/https)",
      },
      prompt: {
        type: "string",
        description: "What information to extract from the page",
      },
    },
    required: ["url", "prompt"],
  },
  type: "read",
  requiresApproval: true,
  isConcurrencySafe: true,
  async handler(input) {
    const url = (input.url as string).trim();
    const prompt = input.prompt as string;

    // Validate URL
    let fetchUrl: string;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return {
          content: `Unsupported protocol: "${parsed.protocol}". Only http/https are allowed.`,
          isError: true,
        };
      }
      fetchUrl = parsed.toString();
    } catch {
      return {
        content: `Invalid URL: "${url}". Provide a full URL including https://.`,
        isError: true,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(fetchUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "coding-agent/0.1 (web-fetch)",
          Accept: "text/html, text/plain, application/xhtml+xml, */*",
        },
        redirect: "follow",
      });

      clearTimeout(timer);

      if (!response.ok) {
        return {
          content: `HTTP ${response.status} ${response.statusText} for ${fetchUrl}`,
          isError: true,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const text = await response.text();

      if (text.length > MAX_RESPONSE_SIZE) {
        const truncated = text.substring(0, MAX_RESPONSE_SIZE);
        const omitted = text.length - MAX_RESPONSE_SIZE;
        const markdown = contentType.includes("text/html")
          ? htmlToMarkdown(truncated)
          : truncated;
        return {
          content:
            markdown +
            `\n\n[Response truncated: ${(omitted / 1024).toFixed(0)}KB omitted]`,
        };
      }

      const markdown = contentType.includes("text/html")
        ? htmlToMarkdown(text)
        : text;

      // Include a header so the agent knows what prompt to answer against
      const header =
        `## WebFetch Result\n` +
        `**URL:** ${fetchUrl}\n` +
        `**Query:** ${prompt}\n` +
        `**Size:** ${(text.length / 1024).toFixed(1)}KB\n\n` +
        `---\n\n`;

      return { content: header + markdown };
    } catch (err: unknown) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === "AbortError") {
        return {
          content: `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${fetchUrl}`,
          isError: true,
        };
      }
      return {
        content: `Fetch failed for ${fetchUrl}: ${message}`,
        isError: true,
      };
    }
  },
};

// ---- WebSearch (Tavily) ----

const TAVILY_API_URL = "https://api.tavily.com/search";

export const webSearchTool: ToolDefinition = {
  name: "WebSearch",
  description:
    "Search the web using Tavily Search API and return results. " +
    "Set TAVILY_API_KEY in .env or environment. " +
    "Returns relevant web pages with titles, URLs, and content snippets.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
      max_results: {
        type: "number",
        description: "Maximum number of results to return (default: 5, max: 10)",
      },
      search_depth: {
        type: "string",
        description: "Search depth: 'basic' (faster) or 'advanced' (more comprehensive)",
        enum: ["basic", "advanced"],
      },
      include_domains: {
        type: "array",
        items: { type: "string" },
        description: "Only include results from these domains",
      },
      exclude_domains: {
        type: "array",
        items: { type: "string" },
        description: "Exclude results from these domains",
      },
    },
    required: ["query"],
  },
  type: "read",
  requiresApproval: true,
  isConcurrencySafe: true,
  async handler(input) {
    const query = input.query as string;
    const maxResults = Math.min((input.max_results as number) ?? 5, 10);
    const searchDepth =
      (input.search_depth as "basic" | "advanced") ?? "basic";
    const includeDomains = input.include_domains as string[] | undefined;
    const excludeDomains = input.exclude_domains as string[] | undefined;

    const apiKey =
      process.env.TAVILY_API_KEY ?? process.env.TAVILY_API_KEY_ALT ?? "";

    if (!apiKey) {
      return {
        content:
          "Tavily API key not found. Set TAVILY_API_KEY in your .env file.\n" +
          "Get a free key at https://tavily.com",
        isError: true,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);

    try {
      const body: Record<string, unknown> = {
        api_key: apiKey,
        query,
        search_depth: searchDepth,
        max_results: maxResults,
        include_answer: true,
      };
      if (includeDomains?.length) body.include_domains = includeDomains;
      if (excludeDomains?.length) body.exclude_domains = excludeDomains;

      const response = await fetch(TAVILY_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return {
          content: `Tavily API error: HTTP ${response.status} — ${errorText || response.statusText}`,
          isError: true,
        };
      }

      const data = (await response.json()) as TavilyResponse;

      // Format results
      const parts: string[] = [];
      parts.push(
        `## Web Search Results\n` +
          `**Query:** "${data.query ?? query}"\n` +
          `**Results:** ${data.results?.length ?? 0} | ` +
          `**Response time:** ${data.response_time ? data.response_time.toFixed(2) + "s" : "N/A"}\n`
      );

      // AI-generated answer (if available)
      if (data.answer) {
        parts.push(`\n### Summary Answer\n${data.answer}`);
      }

      // Individual results
      if (data.results?.length) {
        parts.push(`\n### Top Results\n`);
        for (let i = 0; i < data.results.length; i++) {
          const r = data.results[i];
          parts.push(
            `**${i + 1}. [${r.title}](${r.url})**` +
              (r.score ? ` _(relevance: ${(r.score * 100).toFixed(0)}%)_` : "") +
              `\n${r.content}\n`
          );
        }
      }

      return { content: parts.join("\n") };
    } catch (err: unknown) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === "AbortError") {
        return {
          content: `Search timed out for query: "${query}"`,
          isError: true,
        };
      }
      return {
        content: `Search failed for "${query}": ${message}`,
        isError: true,
      };
    }
  },
};

// ---- Tavily types ----

interface TavilyResponse {
  query?: string;
  answer?: string;
  results?: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
  }>;
  response_time?: number;
}

// ---- HTML to markdown converter (lightweight, no dependencies) ----

function htmlToMarkdown(html: string): string {
  let text = html;

  // 1. Remove unwanted sections
  const removals = [
    /<script[\s\S]*?<\/script>/gi,
    /<style[\s\S]*?<\/style>/gi,
    /<noscript[\s\S]*?<\/noscript>/gi,
    /<!--[\s\S]*?-->/g,
    /<head[\s\S]*?<\/head>/gi,
    /<nav[\s\S]*?<\/nav>/gi,
    /<footer[\s\S]*?<\/footer>/gi,
    /<svg[\s\S]*?<\/svg>/gi,
  ];
  for (const re of removals) {
    text = text.replace(re, "");
  }

  // 2. Block elements → newlines
  const blocks = [
    /<\/?br\s*\/?>/gi,
    /<\/p>/gi,
    /<\/div>/gi,
    /<\/li>/gi,
    /<\/h[1-6]>/gi,
    /<\/tr>/gi,
    /<\/section>/gi,
    /<\/article>/gi,
    /<\/aside>/gi,
    /<\/main>/gi,
    /<\/header>/gi,
    /<hr\s*\/?>/gi,
  ];
  for (const re of blocks) {
    text = text.replace(re, "\n");
  }

  // 3. Headings
  text = text.replace(/<h1[^>]*>/gi, "\n# ");
  text = text.replace(/<h2[^>]*>/gi, "\n## ");
  text = text.replace(/<h3[^>]*>/gi, "\n### ");
  text = text.replace(/<h4[^>]*>/gi, "\n#### ");
  text = text.replace(/<h5[^>]*>/gi, "\n##### ");
  text = text.replace(/<h6[^>]*>/gi, "\n###### ");

  // 4. Inline formatting
  text = text.replace(/<strong[^>]*>/gi, "**");
  text = text.replace(/<\/strong>/gi, "**");
  text = text.replace(/<b[^>]*>/gi, "**");
  text = text.replace(/<\/b>/gi, "**");
  text = text.replace(/<em[^>]*>/gi, "*");
  text = text.replace(/<\/em>/gi, "*");
  text = text.replace(/<i[^>]*>/gi, "*");
  text = text.replace(/<\/i>/gi, "*");
  text = text.replace(/<code[^>]*>/gi, "`");
  text = text.replace(/<\/code>/gi, "`");

  // 5. Links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
    const cleanHref = href.replace(/&amp;/g, "&");
    const cleanContent = stripTags(content).trim();
    return `[${cleanContent}](${cleanHref})`;
  });

  // 6. Lists
  text = text.replace(/<li[^>]*>/gi, "\n- ");

  // 7. Remove all remaining HTML tags
  text = stripTags(text);

  // 8. Decode HTML entities
  text = decodeEntities(text);

  // 9. Collapse whitespace (but keep blank lines)
  text = text
    .split("\n")
    .map((line) => line.trim())
    .map((line, i, arr) => {
      // Remove consecutive blank lines (>2)
      if (!line && i > 0 && !arr[i - 1]) return null;
      return line;
    })
    .filter((line) => line !== null)
    .join("\n");

  return text.trim();
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&copy;": "©",
    "&reg;": "®",
    "&mdash;": "—",
    "&ndash;": "–",
    "&#x27;": "'",
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.split(entity).join(char);
  }
  // Numeric entities
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
  return text;
}
