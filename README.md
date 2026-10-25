# repomcp

[![ci](https://github.com/kanchingyg/repomcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/repomcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/repomcp)](https://www.npmjs.com/package/repomcp)
[![JSR](https://jsr.io/badges/@kanchingyg/repomcp)](https://jsr.io/@kanchingyg/repomcp)
[![Bun](https://img.shields.io/badge/runtime-Node_%7C_Bun-f9f1e1)](https://github.com/kanchingyg/repomcp)
[![license](https://img.shields.io/github/license/kanchingyg/repomcp)](https://github.com/kanchingyg/repomcp/blob/HEAD/LICENSE)

Universal repo-to-MCP bridge: introspect a repository, expose guarded MCP tools over stdio, generate multi-harness configs (Pi, OMP, Hermes, cc-switch, Claude Code, Kilo Code, Roo Code, Cursor, Cline, OpenCode), normalize embeddings for code indexers, and adapt tool-calling for Chinese providers and raw local checkpoints.

## Install

[Bun](https://bun.sh) / [npm](https://www.npmjs.com/package/repomcp):

```bash
bunx repomcp init --target all
npx repomcp init --target all

# or install in your project / globally
bun add -d repomcp
npm i -D repomcp
```

[JSR](https://jsr.io/@kanchingyg/repomcp):

```bash
bunx jsr add @kanchingyg/repomcp
npx jsr add @kanchingyg/repomcp
```

## Quick start

```bash
bunx repomcp init --target all
npx repomcp --mcp
npx repomcp embed --port 11435
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

## License

[MIT](./LICENSE)
