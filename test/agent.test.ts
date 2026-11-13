import { Agent } from "@mastra/core/agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ayinboxTools } from "../src/index.js";
import { MockApi, fixture } from "./server.js";

const KEY = "aybox_agentKEYneverLeaks0123456789abcdefghijklmnopq";
const api = new MockApi();

beforeAll(() => api.start());
afterAll(() => api.stop());
afterEach(() => api.reset());

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function stream(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

/** A minimal AI SDK v2 language model: first turn calls list_campaigns, second answers. */
function scriptedModel(prompts: unknown[]) {
  let turn = 0;
  const respond = (prompt: unknown): Array<Record<string, unknown> & { type: string }> => {
    prompts.push(prompt);
    turn++;
    return turn === 1
      ? [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call_1", toolName: "list_campaigns", input: '{"limit":5}' },
          { type: "finish", finishReason: "tool-calls", usage },
        ]
      : [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "done" },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop", usage },
        ];
  };
  return {
    specificationVersion: "v2" as const,
    provider: "mock",
    modelId: "mock-model",
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown }) {
      const parts = respond(options.prompt);
      const finish = parts.find((p) => p.type === "finish") as unknown as { finishReason: string };
      const content = parts.flatMap((p) =>
        p.type === "tool-call" ? [p] : p.type === "text-delta" ? [{ type: "text", text: p.delta }] : [],
      );
      return { content, finishReason: finish.finishReason, usage, warnings: [] };
    },
    async doStream(options: { prompt: unknown }) {
      return { stream: stream(respond(options.prompt)) };
    },
  };
}

function agentWith(tools: Awaited<ReturnType<typeof ayinboxTools>>, prompts: unknown[]) {
  return new Agent({
    id: "test-agent",
    name: "test agent",
    instructions: "Use the tools.",
    model: scriptedModel(prompts) as unknown as ConstructorParameters<typeof Agent>[0]["model"],
    tools,
  });
}

describe("a Mastra agent with AY Inbox tools", () => {
  it("runs a tool and gives the model result_text", async () => {
    api
      .on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") })
      .on("POST", "/v1/ai/tools/list_campaigns/call", { status: 200, body: fixture("ai_tool_call.json") });
    const tools = await ayinboxTools({ apiKey: KEY, baseUrl: api.baseUrl });
    const prompts: unknown[] = [];

    const result = await agentWith(tools, prompts).generate("List my campaigns.", { maxSteps: 3 });

    expect(result.text).toBe("done");
    expect(JSON.parse(api.calls("POST", "/v1/ai/tools/list_campaigns/call")[0]!.body)).toEqual({ limit: 5 });
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain('{\\"campaigns\\":[]}');
  });

  it("reports an API error to the model without the key", async () => {
    api
      .on("GET", "/v1/ai/tools", { status: 200, body: fixture("ai_tools_list.json") })
      .on("POST", "/v1/ai/tools/list_campaigns/call", {
        status: 402,
        body: fixture("errors/402_insufficient_credits.json"),
      });
    const tools = await ayinboxTools({ apiKey: KEY, baseUrl: api.baseUrl });
    const prompts: unknown[] = [];

    const result = await agentWith(tools, prompts).generate("List my campaigns.", { maxSteps: 3 });

    expect(prompts).toHaveLength(2);
    const second = JSON.stringify(prompts[1]);
    expect(second).toContain("insufficient_credits");
    expect(second).toContain("request_id req-fixture-0001");
    expect(second).not.toContain(KEY);
    expect(JSON.stringify(result.steps ?? [])).not.toContain(KEY);
  });
});
