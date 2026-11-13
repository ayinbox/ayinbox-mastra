# Changelog

## 0.1.0 (unreleased)

- First version: `ayinboxTools()` loads the tools a credential may call from `GET /v1/ai/tools` and turns each into a Mastra tool that runs `POST /v1/ai/tools/{name}/call`.
- `toolsets`, `include` and `exclude` filtering.
- The model reads `result_text`; API errors become `AyinboxToolError` with the API's `code` and `request_id`.
- Retries on 429, 502, 503, 504 and network errors, with an idempotency key on every tool call.
- `ayinboxMcp()` settings for `MCPClient` from `@mastra/mcp` and the hosted MCP server.
- Supports `@mastra/core` 1.20 and later in the 1.x line.
