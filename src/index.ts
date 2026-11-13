import { createTool } from "@mastra/core/tools";
import {
  AyinboxToolError,
  AyinboxToolsClient,
  type AyinboxToolDefinition,
  type AyinboxToolResult,
  type AyinboxToolset,
  type ClientOptions,
} from "./client.js";
import { VERSION } from "./version.js";

export {
  AyinboxApiError,
  AyinboxConnectionError,
  AyinboxToolError,
  AyinboxToolsClient,
  DEFAULT_BASE_URL,
  type AyinboxToolDefinition,
  type AyinboxToolResult,
  type AyinboxToolset,
  type ClientOptions,
} from "./client.js";
export { VERSION };

export const MCP_URL = "https://api.ayinbox.com/v1/mcp";

export interface AyinboxToolsOptions extends ClientOptions {
  /** Ask the API for these toolsets only (`GET /ai/tools?toolsets=`). */
  toolsets?: readonly AyinboxToolset[];
  /** Keep only tools with these names. */
  include?: readonly string[];
  /** Drop tools with these names. Applied after `include`. */
  exclude?: readonly string[];
}

/** One AY Inbox tool as a Mastra tool. */
export type AyinboxMastraTool = ReturnType<typeof makeTool>;

/** A record of Mastra tools keyed by AY Inbox tool name, ready for `new Agent({ tools })`. */
export type AyinboxToolSet = Record<string, AyinboxMastraTool>;

function inputSchemaOf(def: AyinboxToolDefinition): Record<string, unknown> {
  const schema = def.input_schema && typeof def.input_schema === "object" ? def.input_schema : {};
  return { type: "object", properties: {}, ...schema };
}

/** Narrows a tool list by name, keeping the API's order. */
export function filterTools(
  tools: readonly AyinboxToolDefinition[],
  options: { include?: readonly string[]; exclude?: readonly string[] },
): AyinboxToolDefinition[] {
  const include = options.include ? new Set(options.include) : undefined;
  const exclude = new Set(options.exclude ?? []);
  return tools.filter((t) => (!include || include.has(t.name)) && !exclude.has(t.name));
}

function makeTool(client: AyinboxToolsClient, def: AyinboxToolDefinition) {
  return createTool({
    id: def.name,
    description: def.description,
    inputSchema: inputSchemaOf(def) as Parameters<typeof createTool>[0]["inputSchema"],
    execute: async (input: unknown, context?: { abortSignal?: AbortSignal }): Promise<AyinboxToolResult> => {
      const signal = context?.abortSignal;
      try {
        return await client.callTool(def.name, input, { signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new AyinboxToolError(def.name, err);
      }
    },
    // The model reads result_text, which the API fences as data when people outside the workspace wrote it.
    toModelOutput: (output: unknown) => ({
      type: "text",
      value: (output as AyinboxToolResult).result_text,
    }),
  });
}

/**
 * Fetches the tools this credential may call (`GET /ai/tools`, once) and turns each into a
 * Mastra tool whose `execute` runs `POST /ai/tools/{name}/call`.
 */
export async function ayinboxTools(options: AyinboxToolsOptions = {}): Promise<AyinboxToolSet> {
  const client = new AyinboxToolsClient({ ...options, userAgent: `ayinbox-mastra/${VERSION}` });
  const definitions = filterTools(await client.listTools({ toolsets: options.toolsets }), options);
  const tools: AyinboxToolSet = {};
  for (const def of definitions) tools[def.name] = makeTool(client, def);
  return tools;
}

/**
 * Settings for Mastra's `MCPClient` (from `@mastra/mcp`) pointed at the AY Inbox MCP server,
 * as an alternative to `ayinboxTools`.
 */
export function ayinboxMcp(options: { apiKey?: string; url?: string; id?: string } = {}): {
  id?: string;
  servers: { ayinbox: { url: URL; requestInit: { headers: Record<string, string> } } };
} {
  const apiKey = options.apiKey ?? process.env.AYINBOX_API_KEY;
  if (!apiKey) throw new Error("No AY Inbox credential: pass apiKey or set AYINBOX_API_KEY.");
  return {
    ...(options.id ? { id: options.id } : {}),
    servers: {
      ayinbox: {
        url: new URL(options.url ?? MCP_URL),
        requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
      },
    },
  };
}
