import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AyinboxApiError,
  AyinboxToolError,
  VERSION,
  ayinboxMcp,
  ayinboxTools,
  type AyinboxToolResult,
} from "../src/index.js";
import { MockApi, fixture, toolList } from "./server.js";
import { standardSchemaToJSONSchema } from "@mastra/core/schema";

const KEY = "aybox_testKEYdoNotLeak0123456789abcdefghijklmnopq";
const api = new MockApi();

beforeAll(() => api.start());
afterAll(() => api.stop());
afterEach(() => {
  api.reset();
  delete process.env.AYINBOX_API_KEY;
});

const opts = () => ({ apiKey: KEY, baseUrl: api.baseUrl });
const execOpts = {};

type Executable = {
  id: string;
  description?: string;
  inputSchema: unknown;
  execute: (input: unknown, context: typeof execOpts) => Promise<AyinboxToolResult>;
  toModelOutput: (output: AyinboxToolResult) => unknown;
};
const asExec = (t: unknown) => t as Executable;

describe("ayinboxTools", () => {
  it("converts the tool list into Mastra tools", async () => {
    api.on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") });
    const tools = await ayinboxTools(opts());

    expect(Object.keys(tools)).toEqual(["list_campaigns"]);
    const t = asExec(tools.list_campaigns);
    expect(t.description).toBe("List the workspace's campaigns.");
    expect(t.id).toBe("list_campaigns");
    expect(standardSchemaToJSONSchema(t.inputSchema as Parameters<typeof standardSchemaToJSONSchema>[0])).toMatchObject({
      type: "object",
      properties: { limit: { type: "integer" } },
    });

    const [req] = api.calls("GET", "/v1/ai/tools");
    expect(req!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req!.headers["user-agent"]).toBe(`ayinbox-mastra/${VERSION}`);
    expect(req!.headers.accept).toBe("application/json");
    expect(req!.url.searchParams.get("format")).toBe("ayinbox");
    expect(req!.url.searchParams.has("toolsets")).toBe(false);
  });

  it("round-trips a tool call and gives the model result_text", async () => {
    api
      .on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") })
      .on("POST", "/v1/ai/tools/list_campaigns/call", { status: 200, body: fixture("ai_tool_call.json") });
    const tools = await ayinboxTools(opts());
    const t = asExec(tools.list_campaigns);

    const out = await t.execute({ limit: 5 }, execOpts);
    expect(out).toEqual({
      name: "list_campaigns",
      result: { campaigns: [] },
      result_text: '{"campaigns":[]}',
      untrusted: false,
    });

    const [req] = api.calls("POST", "/v1/ai/tools/list_campaigns/call");
    expect(JSON.parse(req!.body)).toEqual({ limit: 5 });
    expect(req!.headers["content-type"]).toBe("application/json");
    expect(req!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.toModelOutput(out)).toEqual({
      type: "text",
      value: '{"campaigns":[]}',
    });
  });

  it("sends an empty object when the model passes no arguments", async () => {
    api
      .on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") })
      .on("POST", "/v1/ai/tools/list_campaigns/call", { status: 200, body: fixture("ai_tool_call.json") });
    const tools = await ayinboxTools(opts());
    await asExec(tools.list_campaigns).execute(undefined, execOpts);
    expect(api.calls("POST", "/v1/ai/tools/list_campaigns/call")[0]!.body).toBe("{}");
  });

  it("leaves the idempotency header off when the model passed idempotency_key", async () => {
    api
      .on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") })
      .on("POST", "/v1/ai/tools/list_campaigns/call", { status: 200, body: fixture("ai_tool_call.json") });
    const tools = await ayinboxTools(opts());
    await asExec(tools.list_campaigns).execute({ idempotency_key: "k-1" }, execOpts);
    expect(api.calls("POST", "/v1/ai/tools/list_campaigns/call")[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("turns an API error into a tool error with code and request_id", async () => {
    api
      .on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") })
      .on("POST", "/v1/ai/tools/list_campaigns/call", {
        status: 403,
        body: fixture("errors/403_forbidden.json"),
      });
    const tools = await ayinboxTools(opts());
    const err = await asExec(tools.list_campaigns)
      .execute({}, execOpts)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AyinboxToolError);
    const toolErr = err as AyinboxToolError;
    expect(toolErr.code).toBe("forbidden");
    expect(toolErr.status).toBe(403);
    expect(toolErr.requestId).toBe("req-fixture-0001");
    expect(toolErr.message).toBe(
      "AY Inbox tool list_campaigns failed: insufficient API key permissions (status 403, code forbidden, request_id req-fixture-0001)",
    );
  });

  it("passes a 422 tool message through for the model to read", async () => {
    api
      .on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") })
      .on("POST", "/v1/ai/tools/list_campaigns/call", {
        status: 422,
        body: fixture("errors/422_unprocessable.json"),
      });
    const tools = await ayinboxTools(opts());
    const err = (await asExec(tools.list_campaigns)
      .execute({}, execOpts)
      .catch((e: unknown) => e)) as AyinboxToolError;
    expect(err.code).toBe("unprocessable");
    expect(err.message).toContain("validation failed");
  });

  it("never puts the key in an error", async () => {
    api
      .on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") })
      .on("POST", "/v1/ai/tools/list_campaigns/call", {
        status: 401,
        body: { ...(fixture("errors/401_unauthorized.json") as object), message: `Token ${KEY} not found.` },
      });
    const tools = await ayinboxTools(opts());
    const toolErr = (await asExec(tools.list_campaigns)
      .execute({}, execOpts)
      .catch((e: unknown) => e)) as AyinboxToolError;
    expect(toolErr.code).toBe("unauthorized");
    const dump = `${toolErr.message} ${toolErr.stack} ${JSON.stringify(toolErr)} ${String(toolErr)}`;
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("testKEYdoNotLeak");

    api.on("GET", "/v1/ai/tools", { status: 401, body: fixture("errors/401_unauthorized.json") });
    const listErr = (await ayinboxTools(opts()).catch((e: unknown) => e)) as AyinboxApiError;
    expect(listErr).toBeInstanceOf(AyinboxApiError);
    expect(`${listErr.message} ${listErr.stack} ${JSON.stringify(listErr)}`).not.toContain(KEY);

    const netErr = (await ayinboxTools({ apiKey: KEY, baseUrl: "http://127.0.0.1:1/v1", maxRetries: 0 }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(netErr.name).toBe("AyinboxConnectionError");
    expect(`${netErr.message} ${netErr.stack} ${JSON.stringify(netErr)}`).not.toContain(KEY);
  });

  it("asks the API for toolsets and filters by name on the client", async () => {
    api.on("GET", "/v1/ai/tools", { status: 200, body: toolList() });
    const all = await ayinboxTools({ ...opts(), toolsets: ["inbox", "campaigns"] });
    expect(Object.keys(all)).toEqual(["list_campaigns", "list_threads", "draft_reply"]);
    expect(api.calls("GET", "/v1/ai/tools")[0]!.url.searchParams.get("toolsets")).toBe("inbox,campaigns");

    const included = await ayinboxTools({ ...opts(), include: ["list_threads", "draft_reply", "not_listed"] });
    expect(Object.keys(included)).toEqual(["list_threads", "draft_reply"]);

    const excluded = await ayinboxTools({ ...opts(), exclude: ["draft_reply"] });
    expect(Object.keys(excluded)).toEqual(["list_campaigns", "list_threads"]);

    const both = await ayinboxTools({ ...opts(), include: ["list_threads", "draft_reply"], exclude: ["draft_reply"] });
    expect(Object.keys(both)).toEqual(["list_threads"]);
  });

  it("falls back to AYINBOX_API_KEY and refuses to start without a key", async () => {
    api.on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") });
    process.env.AYINBOX_API_KEY = KEY;
    await ayinboxTools({ baseUrl: api.baseUrl });
    expect(api.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);

    delete process.env.AYINBOX_API_KEY;
    await expect(ayinboxTools({ baseUrl: api.baseUrl })).rejects.toThrow(/AYINBOX_API_KEY/);
  });

  it("uses an injected fetch", async () => {
    const seen: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify(fixture("ai_tools_list.json")), { status: 200 });
    };
    const tools = await ayinboxTools({ apiKey: KEY, baseUrl: "https://example.test/v1/", fetch: fakeFetch });
    expect(Object.keys(tools)).toEqual(["list_campaigns"]);
    expect(seen).toEqual(["https://example.test/v1/ai/tools?format=ayinbox"]);
  });
});

describe("retries", () => {
  it("retries the list on 503 and honours Retry-After", async () => {
    api.on(
      "GET",
      "/v1/ai/tools",
      { status: 503, body: fixture("errors/503_service_unavailable.json"), headers: { "Retry-After": "0" } },
      { status: 200, body: fixture("ai_tools_list.json") },
    );
    const tools = await ayinboxTools(opts());
    expect(Object.keys(tools)).toEqual(["list_campaigns"]);
    expect(api.calls("GET", "/v1/ai/tools")).toHaveLength(2);
  });

  it("retries a tool call on 429 and 503 with the same idempotency key", async () => {
    api
      .on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") })
      .on(
        "POST",
        "/v1/ai/tools/list_campaigns/call",
        { status: 429, body: fixture("errors/429_api_key_rate_limited.json"), headers: { "Retry-After": "0" } },
        { status: 503, body: fixture("errors/503_service_unavailable.json"), headers: { "Retry-After": "0" } },
        { status: 200, body: fixture("ai_tool_call.json") },
      );
    const tools = await ayinboxTools(opts());
    await asExec(tools.list_campaigns).execute({}, execOpts);
    const calls = api.calls("POST", "/v1/ai/tools/list_campaigns/call");
    expect(calls).toHaveLength(3);
    const keys = new Set(calls.map((c) => c.headers["idempotency-key"]));
    expect(keys.size).toBe(1);
  });

  it("does not retry 500 or 409 idempotency_outcome_unknown", async () => {
    api
      .on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") })
      .on("POST", "/v1/ai/tools/list_campaigns/call", { status: 500, body: fixture("errors/500_internal_error.json") });
    const tools = await ayinboxTools(opts());
    const err = (await asExec(tools.list_campaigns)
      .execute({}, execOpts)
      .catch((e: unknown) => e)) as AyinboxToolError;
    expect(err.code).toBe("internal_error");
    expect(api.calls("POST", "/v1/ai/tools/list_campaigns/call")).toHaveLength(1);

    api.on("POST", "/v1/ai/tools/list_campaigns/call", {
      status: 409,
      body: fixture("errors/409_idempotency_outcome_unknown.json"),
    });
    const conflict = (await asExec(tools.list_campaigns)
      .execute({}, execOpts)
      .catch((e: unknown) => e)) as AyinboxToolError;
    expect(conflict.code).toBe("idempotency_outcome_unknown");
    expect(api.calls("POST", "/v1/ai/tools/list_campaigns/call")).toHaveLength(2);
  });

  it("reads the category limiter's 429 with no code and retry_after_ms", async () => {
    api.on("GET", "/v1/ai/tools", { status: 429, body: fixture("errors/429_category_rate_limited.json") });
    const err = (await ayinboxTools({ ...opts(), maxRetries: 0 }).catch((e: unknown) => e)) as AyinboxApiError;
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limit_exceeded");
    expect(err.retryAfter).toBe(12);
    expect(err.requestId).toBe("req-fixture-0001");
  });
});

describe("ayinboxMcp", () => {
  it("builds MCP client settings for the hosted server", () => {
    expect(ayinboxMcp({ apiKey: KEY })).toEqual({
      servers: {
        ayinbox: {
          url: new URL("https://api.ayinbox.com/v1/mcp"),
          requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
        },
      },
    });
  });
});

describe("package", () => {
  it("reports the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
