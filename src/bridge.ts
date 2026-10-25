#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { introspectRepo } from "./introspect.js";
import { truncateToolOutput, DEFAULT_N_CTX } from "./checkpoints.js";
import type { RepomcpTool } from "./types.js";

export type GuardOptions = {
    allowWrite?: boolean;
    dryRun?: boolean;
};

export type FinalizeMcpToolTextOptions = {
    nCtx?: number;
    toWsl?: boolean;
};

export type EmbedLock = {
    provider: string;
    model: string;
    dimension: number;
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export type McpDispatchOptions = {
    repoRoot?: string;
    tools?: RepomcpTool[];
    handlers?: Record<string, ToolHandler>;
    pathToWsl?: boolean;
    nCtx?: number;
};

export type JsonRpcMessage = {
    jsonrpc?: string;
    id?: string | number;
    method?: string;
    params?: {
        name?: string;
        arguments?: Record<string, unknown>;
    };
};

export type EmbedUpstream = {
    name: string;
    maxBatch: number;
    embed: (input: string[], model: string, dimensions?: number) => Promise<number[][]>;
};

export type EmbedServerOptions = {
    port: number;
    repoRoot: string;
    upstream: EmbedUpstream;
    defaultModel: string;
};

type EmbeddingsRequestBody = {
    input?: string | string[];
    model?: string;
    dimensions?: number;
    encoding_format?: string;
};

type StdoutWriteCallback = (err?: Error | null) => void;
export { headTailTruncate, probeNCtx, truncateToolOutput, buildRecencyAnchor, anchorPromptTail, DEFAULT_N_CTX, } from "./checkpoints.js";
export { parseDirtyToolCall, stripRedactedThinking } from "./dirty-parser.js";
export { introspectRepo, introspectRepoFull } from "./introspect.js";
export { emitOmpHostToolsFrame } from "./harnesses.js";
export { initHarness } from "./harnesses.js";
export { applyReasoningContentPolicy, createReasoningState, sanitizeRequestBody, normalizeToolChoice, detectProvider, } from "./providers.js";
let allowWrite = false;
let dryRun = false;
export function setGuards(opts: GuardOptions): void {
    if (opts.allowWrite !== undefined) allowWrite = Boolean(opts.allowWrite);
    if (opts.dryRun !== undefined) dryRun = Boolean(opts.dryRun);
}
export function canonicalizeJson(value: unknown): string {
    if (value === null || value === undefined)
        return "null";
    if (typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(",")}}`;
}
export function loopBreakerHash(toolName: string, args: unknown): string {
    return createHash("sha256")
        .update(`${toolName}:${canonicalizeJson(args)}`)
        .digest("hex");
}
const loopState = { lastHash: "", repeatCount: 0 };
export function resetLoopBreaker() {
    loopState.lastHash = "";
    loopState.repeatCount = 0;
}
export function checkLoopBreaker(toolName: string, args: unknown): string | null {
    const h = loopBreakerHash(toolName, args);
    if (h === loopState.lastHash) {
        loopState.repeatCount++;
    }
    else {
        loopState.lastHash = h;
        loopState.repeatCount = 1;
    }
    if (loopState.repeatCount >= 3) {
        return "LOOP_BREAKER: Identical tool call repeated 2 times consecutively. Stop calling tools and return your final synthesis.";
    }
    return null;
}
export function guardMutatingTool(tool: RepomcpTool): { blocked: boolean; reason?: string } {
    if (!tool.mutates)
        return { blocked: false };
    if (dryRun) {
        return {
            blocked: true,
            reason: `[dry-run] Would call mutating tool ${tool.name}; pass --allow-write and omit --dry-run to execute.`,
        };
    }
    if (!allowWrite) {
        return {
            blocked: true,
            reason: "Read-only mode: pass --allow-write to enable mutating tools.",
        };
    }
    return { blocked: false };
}
const WIN_DRIVE_RE = /^([A-Za-z]):\\(.*)$/;
const WSL_RE = /^\/mnt\/([a-z])\/(.*)$/i;
export function windowsToWsl(p: string): string {
    const m = p.match(WIN_DRIVE_RE);
    if (!m)
        return p;
    const rest = m[2].replace(/\\/g, "/");
    return `/mnt/${m[1].toLowerCase()}/${rest}`;
}
export function wslToWindows(p: string): string {
    const m = p.match(WSL_RE);
    if (!m)
        return p;
    const rest = m[2].replace(/\//g, "\\");
    return `${m[1].toUpperCase()}:\\${rest}`;
}
export function normalizePathsDeep(value: unknown, toWsl: boolean): unknown {
    if (typeof value === "string") {
        if (toWsl && WIN_DRIVE_RE.test(value))
            return windowsToWsl(value);
        if (!toWsl && WSL_RE.test(value))
            return wslToWindows(value);
        if (value.startsWith("file:///")) {
            const raw = value.slice(8).replace(/\//g, "\\");
            return (toWsl ? windowsToWsl(raw) : raw);
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((v) => normalizePathsDeep(v, toWsl));
    }
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = normalizePathsDeep(v, toWsl);
        }
        return out;
    }
    return value;
}
export function redactSecrets(text: string): string {
    return String(text)
        .replace(/(api[_-]?key|token|password|secret)\s*[=:]\s*[^\s]+/gi, "$1=[REDACTED]")
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
        .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]");
}
export function finalizeMcpToolText(text: string, opts?: FinalizeMcpToolTextOptions): unknown {
    const nCtx = opts?.nCtx ?? DEFAULT_N_CTX;
    const toWsl = opts?.toWsl ?? false;
    return normalizePathsDeep(redactSecrets(truncateToolOutput(String(text), nCtx)), !toWsl);
}
let jsonRpcWrite: ((line: string) => void) | null = null;
let stdoutHijacked = false;
export function hijackStdoutForMcp(): void {
    if (stdoutHijacked)
        return;
    stdoutHijacked = true;
    const native = process.stdout.write.bind(process.stdout);
    jsonRpcWrite = (line: string) => {
        native(line);
    };
    process.stdout.write = ((
        chunk: string | Uint8Array,
        encoding?: BufferEncoding | StdoutWriteCallback,
        cb?: StdoutWriteCallback,
    ): boolean => {
        const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
        if (jsonRpcWrite && str.trim().startsWith("{") && str.includes('"jsonrpc"')) {
            if (typeof encoding === "function") {
                return native(chunk, encoding);
            }
            return native(chunk, encoding, cb);
        }
        process.stderr.write(str);
        return true;
    }) as typeof process.stdout.write;
}
export const jsonRpcFrameLog: string[] = [];
export function writeJsonRpcFrame(obj: Record<string, unknown>): void {
    const line = JSON.stringify(obj) + "\n";
    jsonRpcFrameLog.push(line);
    if (jsonRpcWrite)
        jsonRpcWrite(line);
    else
        process.stdout.write(line);
}
export function startMcpServer(opts: McpDispatchOptions = {}): void {
    hijackStdoutForMcp();
    const repoRoot = opts.repoRoot ?? process.cwd();
    const tools = opts.tools ?? introspectRepo(repoRoot);
    const handlers = opts.handlers ?? {};
    const toWsl = opts.pathToWsl ?? process.env.REPOMCP_PATH_WSL === "1";
    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    let buffer = "";
    stdin.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line)
                continue;
            let msg: JsonRpcMessage;
            try {
                msg = JSON.parse(line) as JsonRpcMessage;
            }
            catch {
                continue;
            }
            dispatchMcpMessage(msg, { repoRoot, tools, handlers, pathToWsl: toWsl, nCtx: opts.nCtx });
        }
    });
}
export function dispatchMcpMessage(msg: JsonRpcMessage, opts: McpDispatchOptions = {}): void {
    const repoRoot = opts.repoRoot ?? process.cwd();
    const tools = opts.tools ?? introspectRepo(repoRoot);
    const handlers = opts.handlers ?? {};
    const toWsl = opts.pathToWsl ?? process.env.REPOMCP_PATH_WSL === "1";
    const nCtx = opts.nCtx ?? DEFAULT_N_CTX;
    handleMessage(msg, tools, handlers, toWsl, nCtx);
}
function handleMessage(
    msg: JsonRpcMessage,
    tools: RepomcpTool[],
    handlers: Record<string, ToolHandler>,
    toWsl: boolean,
    nCtx: number,
): void {
    const { id, method, params } = msg;
    if (method === "initialize") {
        writeJsonRpcFrame({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "repomcp", version: "0.1.0" },
            },
        });
        return;
    }
    if (method === "notifications/initialized")
        return;
    if (method === "tools/list") {
        writeJsonRpcFrame({
            jsonrpc: "2.0",
            id,
            result: {
                tools: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                    annotations: t.annotations,
                })),
            },
        });
        return;
    }
    if (method === "tools/call") {
        const name = params?.name ?? "";
        const args = normalizePathsDeep(params?.arguments ?? {}, toWsl) as Record<string, unknown>;
        const tool = tools.find((t) => t.name === name);
        const loopErr = checkLoopBreaker(name, args);
        if (loopErr) {
            writeJsonRpcFrame({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: loopErr }], isError: true },
            });
            return;
        }
        if (tool) {
            const guard = guardMutatingTool(tool);
            if (guard.blocked) {
                writeJsonRpcFrame({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: guard.reason ?? "blocked" }],
                        isError: true,
                    },
                });
                return;
            }
        }
        const handler = handlers[name];
        void (async () => {
            try {
                if (!handler) {
                    writeJsonRpcFrame({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: "no handler" }],
                            isError: true,
                        },
                    });
                    return;
                }
                let result = await handler(args);
                const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
                writeJsonRpcFrame({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: finalizeMcpToolText(text, { nCtx, toWsl }) }],
                    },
                });
            }
            catch (e) {
                writeJsonRpcFrame({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: finalizeMcpToolText(String(e), { nCtx, toWsl }) }],
                        isError: true,
                    },
                });
            }
        })();
        return;
    }
    if (id !== undefined) {
        writeJsonRpcFrame({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
}
export const EMBED_LOCK = ".repomcp-embed-lock.json";
export const KNOWN_DIMENSIONS = [384, 768, 1024, 1536, 2560, 3072, 4096];
export function readEmbedLock(repoRoot: string): EmbedLock | null {
    const p = join(repoRoot, EMBED_LOCK);
    if (!existsSync(p))
        return null;
    return JSON.parse(readFileSync(p, "utf8")) as EmbedLock;
}
export function writeEmbedLock(repoRoot: string, lock: EmbedLock): void {
    writeFileSync(join(repoRoot, EMBED_LOCK), JSON.stringify(lock, null, 2));
}
export function assertDimensionFingerprint(lock: EmbedLock | null, dim: number): void {
    if (!lock)
        return;
    if (lock.dimension !== dim) {
        throw new Error(`Dimension fingerprint mismatch: lock expects ${lock.dimension}, got ${dim}`);
    }
}
export function l2Normalize(vec: number[]): number[] {
    let sum = 0;
    for (const v of vec)
        sum += v * v;
    const norm = Math.sqrt(sum) || 1;
    return vec.map((v) => v / norm);
}
export function mrlSlice(vec: number[], dimensions: number): number[] {
    const sliced = vec.slice(0, dimensions);
    return l2Normalize(sliced);
}
export function floatArrayToBase64(vec: number[]): string {
    const buf = Buffer.alloc(vec.length * 4);
    for (let i = 0; i < vec.length; i++)
        buf.writeFloatLE(vec[i], i * 4);
    return buf.toString("base64");
}
export function base64ToFloatArray(b64: string): number[] {
    const buf = Buffer.from(b64, "base64");
    const out = [];
    for (let i = 0; i < buf.length; i += 4) {
        out.push(buf.readFloatLE(i));
    }
    return out;
}
export function chunkArray<T>(arr: T[], size: number): T[][] {
    const out = [];
    for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
    return out;
}
export async function normalizeEmbedBatch(
    inputs: string[],
    options: {
        dimensions?: number;
        upstream: EmbedUpstream;
        model: string;
        lock?: EmbedLock | null;
    },
): Promise<{ embeddings: number[][]; indices: number[] }> {
    const dimensions = options.dimensions;
    const indexed = inputs.map((text, i) => ({ text, i }));
    const nonEmpty = indexed.filter((x) => x.text.trim().length > 0);
    const batches = chunkArray(nonEmpty, options.upstream.maxBatch);
    const vectors = new Map<number, number[]>();
    for (const batch of batches) {
        const texts = batch.map((b) => b.text);
        const got = await options.upstream.embed(texts, options.model, dimensions);
        for (let j = 0; j < batch.length; j++) {
            let vec = got[j] ?? [];
            if (dimensions && vec.length > dimensions)
                vec = mrlSlice(vec, dimensions);
            else if (dimensions && vec.length === dimensions)
                vec = l2Normalize(vec);
            if (dimensions)
                assertDimensionFingerprint(options.lock ?? null, vec.length);
            vectors.set(batch[j].i, vec);
        }
    }
    const dim = dimensions ?? (vectors.values().next().value?.length ?? 0);
    const embeddings = [];
    const indices = [];
    for (let i = 0; i < inputs.length; i++) {
        indices.push(i);
        embeddings.push(vectors.get(i) ?? new Array(dim).fill(0));
    }
    return { embeddings, indices };
}
export function createEmbedRequestHandler(opts: EmbedServerOptions) {
    return async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST" || !req.url?.startsWith("/v1/embeddings")) {
            res.writeHead(404);
            res.end();
            return;
        }
        const body = await readBody(req);
        let parsed: EmbeddingsRequestBody;
        try {
            parsed = JSON.parse(body) as EmbeddingsRequestBody;
        }
        catch {
            res.writeHead(400);
            res.end("Invalid JSON");
            return;
        }
        const input = Array.isArray(parsed.input)
            ? parsed.input
            : parsed.input
                ? [parsed.input]
                : [];
        const lock = readEmbedLock(opts.repoRoot);
        try {
            const { embeddings } = await normalizeEmbedBatch(input, {
                dimensions: parsed.dimensions,
                upstream: opts.upstream,
                model: parsed.model ?? opts.defaultModel,
                lock,
            });
            if (parsed.dimensions && !lock) {
                writeEmbedLock(opts.repoRoot, {
                    provider: opts.upstream.name,
                    model: parsed.model ?? opts.defaultModel,
                    dimension: parsed.dimensions,
                });
            }
            const data = embeddings.map((embedding, index) => {
                if (parsed.encoding_format === "base64") {
                    return { object: "embedding", index, embedding: floatArrayToBase64(embedding) };
                }
                return { object: "embedding", index, embedding };
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ object: "list", data, model: parsed.model, usage: {} }));
        }
        catch (e) {
            res.writeHead(400);
            res.end(String(e));
        }
    };
}
function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
        req.on("error", reject);
    });
}
export function startEmbedServer(opts: EmbedServerOptions) {
    const server = createServer(createEmbedRequestHandler(opts));
    server.listen(opts.port, "127.0.0.1");
    return server;
}
export function createDashScopeUpstream(
    fetchImpl: typeof fetch = fetch,
    opts?: { apiKey?: string },
): EmbedUpstream {
    return {
        name: "dashscope",
        maxBatch: 10,
        embed: async (input: string[], model: string, dimensions?: number) => {
            const key = opts?.apiKey ?? process.env.DASHSCOPE_API_KEY;
            if (!key) {
                throw new Error("DASHSCOPE_API_KEY is required for DashScope embed upstream");
            }
            const res = await fetchImpl("https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
                body: JSON.stringify({ model, input, dimensions }),
            });
            const j = (await res.json()) as { data?: { embedding: number[] }[] };
            return (j.data ?? []).map((d) => d.embedding);
        },
    };
}