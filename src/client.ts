import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.ayinbox.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_AFTER_CAP_MS = 120_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** The twelve toolsets `GET /ai/tools?toolsets=` accepts. */
export type AyinboxToolset =
  | "inbox"
  | "campaigns"
  | "contacts"
  | "leads"
  | "crm"
  | "mailboxes"
  | "workspace"
  | "automation"
  | "forms"
  | "developer"
  | "research"
  | "analytics";

/** One tool as `GET /ai/tools` (format `ayinbox`) describes it. */
export interface AyinboxToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** The `data` object `POST /ai/tools/{name}/call` answers with. */
export interface AyinboxToolResult {
  name: string;
  /** The tool's output as JSON when it returned JSON, else a string. For your own code. */
  result: unknown;
  /** The same output as text, fenced as data when `untrusted` is true. This is what the model sees. */
  result_text: string;
  /** True when the result holds text written by people outside the workspace. */
  untrusted: boolean;
}

export interface ClientOptions {
  /** API key (`aybox_...`) or OAuth access token (`ayat_...`). Falls back to `AYINBOX_API_KEY`. */
  apiKey?: string;
  /** Defaults to `https://api.ayinbox.com/v1`, then `AYINBOX_BASE_URL`. */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Automatic retries on 429, 502, 503, 504 and network errors. Default 2, 0 disables. */
  maxRetries?: number;
  /** A fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** An error answered by the AY Inbox API. Never carries the credential. */
export class AyinboxApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  readonly requestId?: string;
  /** Seconds to wait before retrying, on 429 and some 503 answers. */
  readonly retryAfter?: number;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    reason?: string;
    requestId?: string;
    retryAfter?: number;
  }) {
    super(init.message);
    this.name = "AyinboxApiError";
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
  }
}

/** The request never got an HTTP answer: DNS, TLS, a dropped connection or a timeout. */
export class AyinboxConnectionError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, timedOut = false) {
    super(message);
    this.name = "AyinboxConnectionError";
    this.timedOut = timedOut;
  }
}

/** What a tool's execute throws, so the framework hands the model a short readable error. */
export class AyinboxToolError extends Error {
  readonly toolName: string;
  readonly status?: number;
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfter?: number;

  constructor(toolName: string, cause: unknown) {
    const parts: string[] = [];
    let status: number | undefined;
    let code = "connection_error";
    let requestId: string | undefined;
    let retryAfter: number | undefined;
    let message: string;
    if (cause instanceof AyinboxApiError) {
      status = cause.status;
      code = cause.code;
      requestId = cause.requestId;
      retryAfter = cause.retryAfter;
      message = cause.message;
      parts.push(`status ${status}`, `code ${code}`);
      if (cause.reason) parts.push(`reason ${cause.reason}`);
      if (requestId) parts.push(`request_id ${requestId}`);
      if (retryAfter !== undefined) parts.push(`retry after ${retryAfter}s`);
    } else if (cause instanceof AyinboxConnectionError) {
      code = cause.timedOut ? "timeout" : "connection_error";
      message = cause.message;
      parts.push(`code ${code}`);
    } else {
      code = "client_error";
      message = cause instanceof Error ? cause.message : String(cause);
      parts.push(`code ${code}`);
    }
    super(`AY Inbox tool ${toolName} failed: ${message} (${parts.join(", ")})`);
    this.name = "AyinboxToolError";
    this.toolName = toolName;
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

const CREDENTIAL_PATTERN = /\b(aybox|ayat)_[A-Za-z0-9_-]+/g;

/** Removes anything shaped like an AY Inbox credential from text that may reach a log or a model. */
export function redact(text: string, secret?: string): string {
  let out = text;
  if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(CREDENTIAL_PATTERN, "$1_[redacted]");
}

function env(name: string): string | undefined {
  const value = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  402: "insufficient_credits",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "unprocessable",
  429: "rate_limit_exceeded",
  500: "internal_error",
  501: "not_implemented",
  503: "service_unavailable",
};

function defaultCode(status: number): string {
  return DEFAULT_CODES[status] ?? (status >= 500 ? "internal_error" : "http_error");
}

function parseRetryAfter(header: string | null, body: Record<string, unknown>): number | undefined {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  if (typeof body.retry_after === "number") return body.retry_after;
  if (typeof body.retry_after_ms === "number") return Math.ceil(body.retry_after_ms / 1000);
  return undefined;
}

async function toApiError(res: Response, secret: string): Promise<AyinboxApiError> {
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // not JSON: keep the default code for the status
  }
  const errorField = typeof body.error === "string" ? body.error : undefined;
  const code =
    typeof body.code === "string"
      ? body.code
      : errorField && /^[a-z0-9_]+$/.test(errorField)
        ? errorField
        : defaultCode(res.status);
  const rawMessage =
    typeof body.message === "string" ? body.message : text.slice(0, 500) || `HTTP ${res.status}`;
  return new AyinboxApiError({
    status: res.status,
    code,
    message: redact(rawMessage, secret),
    reason: typeof body.reason === "string" ? body.reason : undefined,
    requestId:
      (typeof body.request_id === "string" ? body.request_id : undefined) ??
      res.headers.get("x-request-id") ??
      undefined,
    retryAfter: parseRetryAfter(res.headers.get("retry-after"), body),
  });
}

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  /** Retry 502, 503, 504 and network errors. 429 is always retried, since the API never runs a refused request. */
  retryUnsafe: boolean;
  signal?: AbortSignal;
}

/** A small fetch client for the two agent tool routes. */
export class AyinboxToolsClient {
  readonly baseUrl: string;
  readonly userAgent: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions & { userAgent: string }) {
    const apiKey = options.apiKey ?? env("AYINBOX_API_KEY");
    if (!apiKey) {
      throw new Error(
        "No AY Inbox credential: pass apiKey or set AYINBOX_API_KEY (an aybox_ API key or ayat_ OAuth token).",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? env("AYINBOX_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("No fetch implementation: pass one as the fetch option.");
    this.fetchImpl = fetchImpl;
    this.userAgent = options.userAgent;
  }

  /** `GET /ai/tools`: the tools this credential may call. */
  async listTools(options: { toolsets?: readonly string[]; signal?: AbortSignal } = {}): Promise<AyinboxToolDefinition[]> {
    const toolsets = options.toolsets && options.toolsets.length > 0 ? options.toolsets.join(",") : undefined;
    const body = (await this.request({
      method: "GET",
      path: "/ai/tools",
      query: { format: "ayinbox", toolsets },
      retryUnsafe: true,
      signal: options.signal,
    })) as { data?: unknown };
    if (!body || !Array.isArray(body.data)) {
      throw new Error("Unexpected answer from GET /ai/tools: no data array.");
    }
    return body.data.filter(
      (t): t is AyinboxToolDefinition =>
        !!t && typeof t === "object" && typeof (t as AyinboxToolDefinition).name === "string",
    );
  }

  /**
   * `POST /ai/tools/{name}/call`. A call carries an idempotency key on every attempt (the model's
   * `idempotency_key` argument, or a generated `Idempotency-Key` header), so a retry cannot run it twice.
   */
  async callTool(
    name: string,
    args: unknown,
    options: { signal?: AbortSignal; idempotencyKey?: string } = {},
  ): Promise<AyinboxToolResult> {
    const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const hasArgumentKey = typeof input.idempotency_key === "string" && input.idempotency_key !== "";
    const idempotencyKey = options.idempotencyKey ?? (hasArgumentKey ? undefined : newKey());
    const body = (await this.request({
      method: "POST",
      path: `/ai/tools/${encodeURIComponent(name)}/call`,
      body: input,
      idempotencyKey,
      retryUnsafe: hasArgumentKey || idempotencyKey !== undefined,
      signal: options.signal,
    })) as { data?: AyinboxToolResult };
    const data = body?.data;
    if (!data || typeof data !== "object") {
      throw new Error(`Unexpected answer from POST /ai/tools/${name}/call: no data object.`);
    }
    return {
      name: data.name ?? name,
      result: data.result,
      result_text:
        typeof data.result_text === "string" ? data.result_text : JSON.stringify(data.result ?? null),
      untrusted: data.untrusted !== false,
    };
  }

  private async request(opts: RequestOptions): Promise<unknown> {
    const url = new URL(this.baseUrl + opts.path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": this.userAgent,
      Accept: "application/json",
    };
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      try {
        res = await this.fetchImpl(url, { method: opts.method, headers, body: payload, signal });
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? err;
        const timedOut = timeout.aborted;
        const error = new AyinboxConnectionError(
          timedOut
            ? `Request to AY Inbox timed out after ${this.timeoutMs} ms.`
            : `Could not reach AY Inbox: ${redact(err instanceof Error ? err.message : String(err), this.apiKey)}`,
          timedOut,
        );
        if (opts.retryUnsafe && attempt < this.maxRetries) {
          await sleep(backoff(attempt), opts.signal);
          continue;
        }
        throw error;
      }

      if (res.ok) {
        const text = await res.text();
        if (text === "") return undefined;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      const error = await toApiError(res, this.apiKey);
      const retryable =
        RETRYABLE_STATUS.has(res.status) && (res.status === 429 || opts.retryUnsafe);
      if (retryable && attempt < this.maxRetries) {
        const wait =
          error.retryAfter !== undefined
            ? Math.min(error.retryAfter * 1000, RETRY_AFTER_CAP_MS)
            : backoff(attempt);
        await sleep(wait, opts.signal);
        continue;
      }
      throw error;
    }
  }
}

function backoff(attempt: number): number {
  return Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

function newKey(): string {
  return globalThis.crypto.randomUUID();
}

export { VERSION };
