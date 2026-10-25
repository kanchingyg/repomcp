---
name: repomcp
description: Turn any repo into MCP tools with multi-harness configs and model bridges.
---

# repomcp

Use `npx repomcp init` to generate orchestrator-specific MCP and skill files, then run `npx repomcp --mcp` for the stdio server.

For Kilo Code / Roo Code indexing issues (batch limits, dimensions, base64), run `npx repomcp embed --port 11435` and point the indexer at `http://127.0.0.1:11435/v1`.
