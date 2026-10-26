# repomcp

[![ci](https://github.com/kanchingyg/repomcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/repomcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40kanchingyg%2Frepomcp/latest?label=npm)](https://www.npmjs.com/package/@kanchingyg/repomcp)
[![JSR](https://jsr.io/badges/@kanchingyg/repomcp)](https://jsr.io/@kanchingyg/repomcp)
[![JSR Score](https://jsr.io/badges/@kanchingyg/repomcp/score)](https://jsr.io/@kanchingyg/repomcp/score)
[![Runtime](https://img.shields.io/badge/runtime-Node_%7C_Bun_%7C_Deno-f9f1e1)](https://github.com/kanchingyg/repomcp)
[![license](https://img.shields.io/github/license/kanchingyg/repomcp)](https://github.com/kanchingyg/repomcp/blob/HEAD/LICENSE)
[![npm](https://img.shields.io/npm/v/repomcp)](https://www.npmjs.com/package/@kanchingyg/repomcp)
[![JSR](https://jsr.io/badges/@kanchingyg/repomcp)](https://jsr.io/@kanchingyg/repomcp)
[![Bun](https://img.shields.io/badge/runtime-Node_%7C_Bun-f9f1e1)](https://github.com/kanchingyg/repomcp)
[![license](https://img.shields.io/github/license/kanchingyg/repomcp)](https://github.com/kanchingyg/repomcp/blob/HEAD/LICENSE)

Universal repo-to-MCP bridge: introspect a repository, expose guarded MCP tools over stdio, generate multi-harness configs (Pi, OMP, Hermes, cc-switch, Claude Code, Kilo Code, Roo Code, Cursor, Cline, OpenCode), normalize embeddings for code indexers, and adapt tool-calling for Chinese providers and raw local checkpoints.

## Install

[Bun](https://bun.sh) / [npm](https://www.npmjs.com/package/@kanchingyg/repomcp):

```bash
bunx @kanchingyg/repomcp init --target all
npx @kanchingyg/repomcp init --target all

# or install in your project / globally
bun add -d @kanchingyg/repomcp
npm i -D @kanchingyg/repomcp
```

[JSR](https://jsr.io/@kanchingyg/repomcp):

```bash
bunx jsr add @kanchingyg/repomcp
npx jsr add @kanchingyg/repomcp
```

## Quick start

```bash
bunx @kanchingyg/repomcp init --target all
npx @kanchingyg/repomcp --mcp
npx @kanchingyg/repomcp embed --port 11435
```

## Architecture

```text
+--------+    +-------------+    +------------------+
|  repo  |--->| introspect  |--->| MCP tools (stdio)|
+--------+    +-------------+    +------------------+
     |                |                    |
     v                v                    v
+--------+    +-------------+    +------------------+
| harness|    | dirty-parser|    | embed normalizer |
| configs|    | checkpoints |    | (Kilo/Roo dims)  |
+--------+    +-------------+    +------------------+
     |                |                    |
     v                v                    v
 Pi OMP Hermes   Chinese providers    LanceDB/Qdrant
 Cursor Kilo     raw checkpoint EOS
```

## Flags

| Flag | Purpose |
| --- | --- |
| `--mcp` | Run stdio MCP server (stdout JSON-RPC guard enabled) |
| `--allow-write` | Enable mutating tools (read-only by default) |
| `--dry-run` | Simulate tool calls without side effects |

## Programmatic API

The package exports the runtime from `repomcp`, `repomcp/bridge`, and `repomcp/runtime` (also available on JSR as `@kanchingyg/repomcp`): MCP server, harness generators, provider/checkpoint helpers, dirty tool-call parser, and embedding normalizer.

## MCP Tools Reference

| Tool | Mutates | Description |
| --- | --- | --- |
| `repo_status` | `false` | Inspect repository git status, tracked languages, and detected scripts. |
| `run_script` | `true` | Run a package.json, Cargo, or Makefile script inside the workspace (requires `--allow-write`). |
| `search_code` | `false` | Search repository source files with context-window budget truncation. |

## Editor and Agent Integration

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "repomcp": {
      "command": "npx",
      "args": ["-y", "@kanchingyg/repomcp", "--mcp"]
    }
  }
}
```

### Claude Code CLI

```bash
claude mcp add repomcp -- npx -y @kanchingyg/repomcp --mcp
```

### Programmatic Usage (JSR / TypeScript)

```ts
import * as bridge from "jsr:@kanchingyg/repomcp/bridge";
```

## Runtime Safety and Guardrails

- **Stdio frame isolation**: When `--mcp` is active, `hijackStdoutForMcp()` redirects accidental `console.log` calls to `stderr` so JSON-RPC 2.0 frames on `stdout` never corrupt.
- **Read-only by default**: Mutating tools (`mutates: true`) are blocked in `--dry-run` mode and require explicit `--allow-write` authorization.
- **Loop breaker**: Repeated identical `(toolName, args)` invocations are hashed with SHA-256 and halted after 3 consecutive repeats to prevent runaway agent loops.
- **Context budget truncation**: Tool outputs are middle-truncated (`60%` head / `40%` tail) scaled to the probed local model `n_ctx` (Ollama `/api/show`, llama.cpp `/props`, vLLM `/v1/models`).
- **Secret redaction and path normalization**: AWS keys (`AKIA*`, `ASIA*`), bearer tokens, and `sk-*` keys are scrubbed before returning tool output, and Windows drive paths (`C:\...`) translate cleanly to `/mnt/c/...` when WSL mode is enabled.

## License

[MIT](./LICENSE)
