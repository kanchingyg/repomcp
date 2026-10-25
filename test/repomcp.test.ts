import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  generatePiMcpJson,
  generatePiExtension,
  emitOmpHostToolsFrame,
  generateHermesYamlBlock,
  generateCcSwitchSkill,
  generateKiloMcpJson,
  generateCursorMcpJson,
  generateClaudeMcpJson,
  initHarness,
  type InitOptions,
} from "../src/harnesses.js";
import {
  hijackStdoutForMcp,
  jsonRpcFrameLog,
  dispatchMcpMessage,
  setGuards,
  resetLoopBreaker,
  checkLoopBreaker,
  guardMutatingTool,
  windowsToWsl,
  wslToWindows,
  normalizeEmbedBatch,
  floatArrayToBase64,
  base64ToFloatArray,
  mrlSlice,
  assertDimensionFingerprint,
  readEmbedLock,
  writeEmbedLock,
  EMBED_LOCK,
} from "../src/bridge.js";
import {
  headTailTruncate,
  buildRecencyAnchor,
  anchorPromptTail,
  StreamToolJsonAbort,
} from "../src/checkpoints.js";
import { parseDirtyToolCall } from "../src/dirty-parser.js";
import {
  applyReasoningContentPolicy,
  createReasoningState,
  sanitizeRequestBody,
  normalizeToolChoice,
  detectProvider,
} from "../src/providers.js";
import { parseHelpText } from "../src/adapters/cli-crawler.js";
import { discoverPolyglotCode } from "../src/adapters/polyglot-code.js";
import { discoverApiRoutes } from "../src/adapters/api-routes.js";
import { discoverTaskRunners } from "../src/adapters/task-runners.js";
import {
  discoverDataSources,
  isMutatingSql,
} from "../src/adapters/data-sources.js";
import {
  discoverDocsIndex,
  buildBm25Index,
  bm25Search,
} from "../src/adapters/docs-bm25.js";
import {
  assertSafeFetchUrl,
  parseRemoteTarget,
  resolveRemoteTarget,
} from "../src/adapters/remote-target.js";
import { resolveCliBinary } from "../src/adapters/cli-crawler.js";

const baseOpts: InitOptions = {
  repoRoot: "C:\\proj",
  serverName: "demo",
  command: "npx",
  args: ["-y", "repomcp"],
  tools: [
    {
      name: "run_check",
      description: "Run deterministic repo check on target path.",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
        additionalProperties: false,
      },
    },
  ],
};

describe("harnesses", () => {
  it("generates Pi mcp.json and extension", () => {
    const json = generatePiMcpJson(baseOpts) as { mcpServers: Record<string, unknown> };
    expect(json.mcpServers.demo).toBeTruthy();
    const ext = generatePiExtension(baseOpts);
    expect(ext).toContain("registerMcpServer");
    expect(ext).toContain("session_start");
  });

  it("emits OMP set_host_tools NDJSON", () => {
    const line = emitOmpHostToolsFrame("req_3", baseOpts.tools);
    const frame = JSON.parse(line.trim());
    expect(frame.type).toBe("set_host_tools");
    expect(frame.tools[0].name).toBe("run_check");
    expect(frame.tools[0].description.length).toBeLessThanOrEqual(60);
  });

  it("generates Hermes yaml tier-1 description", () => {
    const yaml = generateHermesYamlBlock(baseOpts);
    expect(yaml).toContain("mcp");
    expect(yaml).toContain("--mcp");
  });

  it("generates cc-switch skill", () => {
    const md = generateCcSwitchSkill(baseOpts);
    expect(md).toContain("name: demo");
  });

  it("generates Kilo with embeddings profile", () => {
    const kilo = generateKiloMcpJson({ ...baseOpts, embedPort: 11435 }) as {
      codebaseIndexing: { openAiCompatible: { options: { dimensions: number } } };
    };
    expect(kilo.codebaseIndexing.openAiCompatible.options.dimensions).toBe(1024);
  });

  it("generates Cursor and Claude mcp configs", () => {
    expect(generateCursorMcpJson(baseOpts)).toHaveProperty("mcpServers");
    expect(generateClaudeMcpJson(baseOpts)).toHaveProperty("mcpServers");
  });

  it("init writes Pi and Cursor files", () => {
    const dir = mkdtempSync(join(tmpdir(), "repomcp-"));
    const opts = { ...baseOpts, repoRoot: dir };
    initHarness("pi", opts);
    initHarness("cursor", opts);
    expect(existsSync(join(dir, ".pi", "mcp.json"))).toBe(true);
    expect(existsSync(join(dir, ".cursor", "mcp.json"))).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

describe("MCP Blindaje 4", () => {
  let stderrChunks: string[];

  beforeEach(() => {
    stderrChunks = [];
    jsonRpcFrameLog.length = 0;
    const nativeStderr = process.stderr.write.bind(process.stderr);
    hijackStdoutForMcp();
    process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
      stderrChunks.push(String(chunk));
      return nativeStderr(chunk as Buffer, ...(args as [BufferEncoding?, (err?: Error) => void?]));
    }) as typeof process.stderr.write;
  });

  it("routes console.log noise to stderr and keeps JSON-RPC on stdout", async () => {
    const tool = {
      name: "echo_path",
      description: "echo",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    };
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { tools: [tool], handlers: {} },
    );
    dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "echo_path",
          arguments: { path: "C:\\proj\\foo.ts" },
        },
      },
      {
        tools: [tool],
        pathToWsl: true,
        handlers: {
          echo_path: async (args) => {
            process.stdout.write("NOISE\n");
            return args;
          },
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(jsonRpcFrameLog.join("")).toContain('"jsonrpc"');
    expect(stderrChunks.join("")).toContain("NOISE");
    const lastLine = jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim();
    const frame = JSON.parse(lastLine);
    expect(frame.result.content[0].text).toContain("/mnt/c/proj/foo.ts");
  });
});

describe("Blindaje 1", () => {
  beforeEach(() => {
    resetLoopBreaker();
    setGuards({ allowWrite: false, dryRun: false });
  });

  it("returns isError when tools/call has no handler", async () => {
    jsonRpcFrameLog.length = 0;
    hijackStdoutForMcp();
    const tool = {
      name: "orphan_tool",
      description: "no handler registered",
      inputSchema: { type: "object", properties: {} },
      mutates: false,
    };
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "orphan_tool", arguments: {} } },
      { tools: [tool], handlers: {} },
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(frame.result.isError).toBe(true);
    expect(frame.result.content[0].text).toBe("no handler");
  });

  it("dry-run blocks mutating tools but runs read-only tools", async () => {
    jsonRpcFrameLog.length = 0;
    setGuards({ dryRun: true, allowWrite: false });
    const readTool = {
      name: "read_one",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      mutates: false,
    };
    const writeTool = {
      name: "write_one",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      mutates: true,
    };
    dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "write_one", arguments: {} },
      },
      {
        tools: [readTool, writeTool],
        handlers: { read_one: async () => ({ ok: "read" }), write_one: async () => ({ ok: "write" }) },
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    const blocked = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(blocked.result.isError).toBe(true);
    expect(blocked.result.content[0].text).toMatch(/dry-run/);

    dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read_one", arguments: {} },
      },
      {
        tools: [readTool, writeTool],
        handlers: { read_one: async () => ({ ok: "read" }), write_one: async () => ({ ok: "write" }) },
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    const ran = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(ran.result.isError).toBeUndefined();
    expect(ran.result.content[0].text).toContain("read");
  });

  it("blocks mutating tools without allow-write", () => {
    const g = guardMutatingTool({
      name: "x",
      description: "d",
      inputSchema: { type: "object", properties: {} },
      mutates: true,
    });
    expect(g.blocked).toBe(true);
  });

  it("loop breaker on third identical call", () => {
    expect(checkLoopBreaker("t", { a: 1 })).toBeNull();
    expect(checkLoopBreaker("t", { a: 1 })).toBeNull();
    expect(checkLoopBreaker("t", { a: 1 })).toMatch(/LOOP_BREAKER/);
  });
});

describe("Blindaje 2", () => {
  it("head+tail truncation", () => {
    const long = "H".repeat(200) + "T".repeat(200);
    const out = headTailTruncate(long, 200);
    expect(out).toContain("TRUNCATED");
    expect(out.startsWith("HHH")).toBe(true);
    expect(out.endsWith("TTT")).toBe(true);
  });

  it("recency anchor at end of prompt", () => {
    const anchor = buildRecencyAnchor([
      { name: "run_check", summary: "Run repo check" },
    ]);
    const prompt = "SYSTEM\n...\nASSISTANT:";
    const anchored = anchorPromptTail(prompt, anchor);
    expect(anchored.indexOf(anchor)).toBeLessThan(anchored.lastIndexOf("ASSISTANT:"));
  });
});

describe("Blindaje 5", () => {
  it("reasoning_content replay vs strip", () => {
    let state = createReasoningState();
    const msgs = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "ok",
        reasoning_content: "think",
        tool_calls: [{}],
      },
      { role: "tool", content: "{}" },
    ];
    const r1 = applyReasoningContentPolicy(msgs, state);
    expect(r1.messages[1].reasoning_content).toBe("think");
    state = r1.state;
    const msgs2 = [
      ...msgs,
      { role: "user", content: "next" },
      { role: "assistant", content: "done", reasoning_content: "old" },
    ];
    const r2 = applyReasoningContentPolicy(msgs2, state);
    expect(r2.messages[1].reasoning_content).toBeUndefined();
  });

  it("parses Kimi GLM Qwen and IQ1 broken JSON", () => {
    const kimi =
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.run:0<|tool_call_argument_begin|>{"target":"x"}<|tool_call_end|><|tool_calls_section_end|>';
    expect(parseDirtyToolCall(kimi)?.name).toBe("run");

    const glm =
      '<|tool_call_begin|>run_check<|tool_call_sep|>{"target":"a"}<|tool_call_end|>';
    expect(parseDirtyToolCall(glm)?.arguments.target).toBe("a");

    const qwen = "✿FUNCTION✿: run_check\n✿ARGS✿: {'target': 'z'}\n";
    expect(parseDirtyToolCall(qwen)?.name).toBe("run_check");

    const iq = "{'cmd': 'ls'}";
    expect(parseDirtyToolCall(iq)?.arguments).toEqual({ cmd: "ls" });
  });

  it("stream abort when tool JSON closes", () => {
    const guard = new StreamToolJsonAbort();
    expect(guard.feed('<tool_call>{"name":"t","arguments":{')).toBe(false);
    expect(guard.feed("}}")).toBe(true);
  });

  it("provider sanitization", () => {
    const body = sanitizeRequestBody(
      { temperature: 0.2, top_p: 0.9, model: "deepseek-reasoner" },
      "deepseek-reasoner",
    );
    expect(body.temperature).toBeUndefined();
    expect(normalizeToolChoice("required", detectProvider("https://dashscope.aliyuncs.com"))).toBe(
      "auto",
    );
  });
});

describe("Blindaje 3 embed", () => {
  it("splits 60 into batches of 10 for DashScope", async () => {
    const calls: number[] = [];
    const upstream = {
      name: "dashscope",
      maxBatch: 10,
      embed: async (input: string[]) => {
        calls.push(input.length);
        return input.map(() => [1, 0, 0]);
      },
    };
    const inputs = Array.from({ length: 60 }, (_, i) => `text-${i}`);
    await normalizeEmbedBatch(inputs, { upstream, model: "text-embedding-v3", dimensions: 3 });
    expect(calls.length).toBe(6);
    expect(calls.every((n) => n === 10)).toBe(true);
  });

  it("filters empty strings and preserves indices", async () => {
    const upstream = {
      name: "test",
      maxBatch: 32,
      embed: async (input: string[]) => input.map(() => [0.5, 0.5]),
    };
    const { embeddings } = await normalizeEmbedBatch(["", "hello", "   "], {
      upstream,
      model: "m",
      dimensions: 2,
    });
    expect(embeddings[0]).toEqual([0, 0]);
    expect(embeddings[1].length).toBe(2);
  });

  it("float base64 roundtrip and MRL L2", () => {
    const vec = [3, 4];
    const b64 = floatArrayToBase64(vec);
    const back = base64ToFloatArray(b64);
    expect(back[0]).toBeCloseTo(3);
    const sliced = mrlSlice([3, 4, 0], 2);
    const norm = Math.hypot(sliced[0], sliced[1]);
    expect(norm).toBeCloseTo(1);
  });

  it("rejects dimension fingerprint mismatch", () => {
    const lock = { provider: "x", model: "m", dimension: 1024 };
    expect(() => assertDimensionFingerprint(lock, 768)).toThrow(/fingerprint/);
  });

  it("writes embed lock file", () => {
    const dir = mkdtempSync(join(tmpdir(), "repomcp-embed-"));
    writeEmbedLock(dir, { provider: "p", model: "m", dimension: 1024 });
    expect(readEmbedLock(dir)?.dimension).toBe(1024);
    expect(existsSync(join(dir, EMBED_LOCK))).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

describe("path normalize", () => {
  it("translates windows and wsl", () => {
    expect(windowsToWsl("C:\\proj\\foo.ts")).toBe("/mnt/c/proj/foo.ts");
    expect(wslToWindows("/mnt/c/proj/foo.ts")).toBe("C:\\proj\\foo.ts");
  });
});

describe("MCP Anything adapters", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "repomcp-adapt-"));
    tempDirs.push(dir);
    return dir;
  }

  it("cli-crawler parseHelpText extracts commands and flags", () => {
    const help = `Demo CLI

Commands:
  build    Compile sources
  serve    Start server

Options:
  -h, --help       Show help
  -v, --verbose    Verbose logging
  --port PORT      Listen port
`;
    const parsed = parseHelpText(help);
    expect(parsed.subcommands).toContain("build");
    expect(parsed.subcommands).toContain("serve");
    const longs = parsed.flags.map((f) => f.long);
    expect(longs).toContain("help");
    expect(longs).toContain("verbose");
    expect(longs.some((l) => l === "port")).toBe(true);
  });

  it("polyglot discovers click python and ts export", () => {
    const dir = mkRepo();
    writeFileSync(
      join(dir, "tooling.py"),
      `import click\n\n@click.command()\ndef greet():\n    """Say hi"""\n    pass\n`,
    );
    writeFileSync(
      join(dir, "lib.ts"),
      `export async function fetchWidget(id: string) { return id; }\n`,
    );
    const { tools } = discoverPolyglotCode(dir);
    expect(tools.some((t) => t.name.includes("greet") || t.description.includes("greet"))).toBe(
      true,
    );
    expect(
      tools.some(
        (t) => t.name.includes("fetchwidget") || t.description.includes("fetchWidget"),
      ),
    ).toBe(true);
  });

  it("api-routes finds openapi.json and Next route.ts", async () => {
    const dir = mkRepo();
    writeFileSync(
      join(dir, "openapi.json"),
      JSON.stringify({
        paths: {
          "/pets": {
            get: { summary: "List pets", operationId: "listPets" },
          },
        },
      }),
    );
    mkdirSync(join(dir, "app", "api", "hello"), { recursive: true });
    writeFileSync(
      join(dir, "app", "api", "hello", "route.ts"),
      `export async function GET() { return new Response("ok"); }\n`,
    );
    const { tools } = await discoverApiRoutes(dir);
    expect(tools.some((t) => t.description.includes("openapi") || t.name.includes("pets"))).toBe(
      true,
    );
    expect(tools.some((t) => t.description.includes("Next.js") || t.name.includes("hello"))).toBe(
      true,
    );
  });

  it("task-runners discovers Makefile and package.json scripts", () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "Makefile"), "test:\n\t@echo ok\n\nbuild:\n\t@echo build\n");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { test: "vitest run", lint: "eslint ." } }),
    );
    const { tools } = discoverTaskRunners(dir);
    expect(tools.some((t) => t.name.includes("make_test") || t.name.includes("test"))).toBe(true);
    expect(tools.some((t) => t.name.includes("npm_script"))).toBe(true);
  });

  it("data-sources discovers csv/sql and blocks mutating SQL", () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "data.csv"), "id,name\n1,alpha\n");
    writeFileSync(join(dir, "schema.sql"), "CREATE TABLE items(id INTEGER);\n");
    expect(isMutatingSql("INSERT INTO t VALUES (1)")).toBe(true);
    expect(isMutatingSql("SELECT 1")).toBe(false);
    expect(isMutatingSql("VACUUM")).toBe(true);
    expect(isMutatingSql("REINDEX idx")).toBe(true);
    expect(isMutatingSql("PRAGMA journal_mode=WAL")).toBe(true);
    expect(isMutatingSql("PRAGMA table_info(users)")).toBe(false);
    const { tools, handlers } = discoverDataSources(dir, { allowWrite: false });
    expect(tools.some((t) => t.name === "db_schema")).toBe(true);
    expect(tools.some((t) => t.name === "csv_filter")).toBe(true);
    expect(handlers.db_query_readonly).toBeUndefined();
  });

  it("docs-bm25 search_repo_docs and bm25 ranking", () => {
    const dir = mkRepo();
    writeFileSync(
      join(dir, "README.md"),
      "# Widget manual\n\nUniqueZephyrToken appears only in the widget documentation.\n",
    );
    const { handlers } = discoverDocsIndex(dir);
    const result = handlers.search_repo_docs({ query: "UniqueZephyrToken", limit: 5 }) as {
      hits: { path: string }[];
    };
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].path).toContain("README");

    const index = buildBm25Index([
      { id: "a", path: "a.md", kind: "doc", title: "Alpha", text: "banana fruit salad" },
      { id: "b", path: "b.md", kind: "doc", title: "Beta", text: "banana banana smoothie" },
    ]);
    const hits = bm25Search(index, "banana", 2);
    expect(hits[0].path).toBe("b.md");
  });

  it("wrap allow-write guard blocks mutating cli tools", () => {
    setGuards({ allowWrite: false, dryRun: false });
    const blocked = guardMutatingTool({
      name: "cli_rm_files",
      description: "remove files",
      inputSchema: { type: "object", properties: {} },
      mutates: true,
    });
    expect(blocked.blocked).toBe(true);
    setGuards({ allowWrite: true, dryRun: false });
    const allowed = guardMutatingTool({
      name: "cli_rm_files",
      description: "remove files",
      inputSchema: { type: "object", properties: {} },
      mutates: true,
    });
    expect(allowed.blocked).toBe(false);
  });

  it("resolveCliBinary finds node on PATH", () => {
    expect(resolveCliBinary("node")).toMatch(/node(\.exe)?$/i);
  });

  it("SSRF rejects 127.0.0.1 OpenAPI URL", async () => {
    await expect(assertSafeFetchUrl("https://127.0.0.1/openapi.json")).rejects.toThrow(/SSRF/);
  });

  it("remote-target parses github slug and resolves openapi via fetchImpl", async () => {
    const gh = parseRemoteTarget("github:acme/widget");
    expect(gh.kind).toBe("github");
    expect(gh.owner).toBe("acme");
    expect(gh.repo).toBe("widget");

    const cacheDir = mkRepo();
    const openapiBody = JSON.stringify({
      openapi: "3.0.0",
      paths: { "/health": { get: { summary: "Health" } } },
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      body: null,
      async arrayBuffer() {
        return Buffer.from(openapiBody, "utf8");
      },
    })) as typeof fetch;

    const resolved = await resolveRemoteTarget("https://example.com/openapi.json", {
      cacheDir,
      fetchImpl,
    });
    expect(resolved.kind).toBe("openapi-url");
    expect(readFileSync(resolved.localPath, "utf8")).toContain("/health");
    expect(fetchImpl).toHaveBeenCalled();
  });
});
