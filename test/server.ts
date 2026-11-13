import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (req: RecordedRequest) => Reply;

/** A local HTTP server answering like the AY Inbox API; handlers are queued per route and the last one repeats. */
export class MockApi {
  readonly requests: RecordedRequest[] = [];
  private readonly routes = new Map<string, Handler[]>();
  private server?: Server;
  baseUrl = "";

  on(method: string, path: string, ...handlers: Array<Handler | Reply>): this {
    this.routes.set(
      `${method} ${path}`,
      handlers.map((h) => (typeof h === "function" ? h : () => h)),
    );
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.routes.clear();
  }

  calls(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.url.pathname === path);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const recorded: RecordedRequest = {
          method: req.method ?? "GET",
          url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        this.requests.push(recorded);
        const queue = this.routes.get(`${recorded.method} ${url.pathname}`);
        const handler = queue && (queue.length > 1 ? queue.shift() : queue[0]);
        const reply: Reply = handler
          ? handler(recorded)
          : { status: 404, body: fixture("errors/404_not_found.json") };
        res.writeHead(reply.status, {
          "Content-Type": "application/json; charset=utf-8",
          "X-Request-Id": "req-fixture-0001",
          "API-Version": "v1",
          ...reply.headers,
        });
        res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}/v1`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

/** The spec fixture plus a few more tools, for filtering tests. */
export function toolList(): { data: Array<Record<string, unknown>> } {
  const base = fixture("ai_tools_list.json") as { data: Array<Record<string, unknown>> };
  return {
    data: [
      ...base.data,
      {
        name: "list_threads",
        description: "List unified-inbox conversation threads.",
        input_schema: {
          type: "object",
          properties: { folder: { type: "string" }, limit: { type: "integer" } },
        },
      },
      {
        name: "draft_reply",
        description: "Draft a reply to a thread.",
        input_schema: {
          type: "object",
          properties: { thread_id: { type: "string" } },
          required: ["thread_id"],
        },
      },
    ],
  };
}
