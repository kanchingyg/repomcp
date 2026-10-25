#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { crawlCliBinary, discoverFromRemote, discoverRepoAdapters } from "./adapters/index.js";
import {
    createDashScopeUpstream,
    setGuards,
    startEmbedServer,
    startMcpServer,
} from "./bridge.js";
import { initHarness } from "./harnesses.js";
import { introspectRepoFull } from "./introspect.js";
import { parseRemoteTarget } from "./adapters/remote-target.js";

function looksLikeRemoteTarget(arg: string): boolean {
    const trimmed = arg.trim();
    if (trimmed.toLowerCase().startsWith("github:")) return true;
    if (/^https?:\/\//i.test(trimmed)) return true;
    const parsed = parseRemoteTarget(trimmed);
    return parsed.kind === "github" || parsed.kind === "openapi-url";
}

function resolveRepoRootFromArg(arg: string): string | null {
    const abs = resolve(arg);
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    if (st.isDirectory()) return abs;
    return null;
}

async function startMcpForRoot(
    repoRoot: string,
    argv: string[],
): Promise<void> {
    setGuards({
        allowWrite: argv.includes("--allow-write"),
        dryRun: argv.includes("--dry-run"),
    });
    const { tools, handlers } = await introspectRepoFull(repoRoot, {
        allowWrite: argv.includes("--allow-write"),
    });
    startMcpServer({ repoRoot, tools, handlers });
}

export async function runCli(argv: string[]): Promise<void> {
    if (argv.length === 0) {
        process.stderr.write(
            "Usage: repomcp [--mcp] | wrap <binary> | init | embed | <path> | github:owner/repo | <url>\n",
        );
        return;
    }

    if (argv.includes("--mcp") && argv[0] !== "wrap") {
        await startMcpForRoot(process.cwd(), argv);
        return;
    }

    if (argv[0] === "wrap") {
        const binary = argv[1];
        if (!binary) {
            process.stderr.write("Usage: repomcp wrap <binary> [--depth N] [--mcp]\n");
            process.exitCode = 1;
            return;
        }
        const depthIdx = argv.indexOf("--depth");
        const depth =
            depthIdx >= 0 ? parseInt(argv[depthIdx + 1] ?? "2", 10) : undefined;
        setGuards({
            allowWrite: argv.includes("--allow-write"),
            dryRun: argv.includes("--dry-run"),
        });
        const discovery = await crawlCliBinary(binary, { depth });
        if (argv.includes("--mcp")) {
            startMcpServer({ tools: discovery.tools, handlers: discovery.handlers });
            return;
        }
        process.stdout.write(`${discovery.tools.length} tools\n`);
        return;
    }

    if (argv[0] === "embed" || argv.includes("embed")) {
        const portIdx = argv.indexOf("--port");
        const port = portIdx >= 0 ? parseInt(argv[portIdx + 1], 10) : 11435;
        startEmbedServer({
            port,
            repoRoot: process.cwd(),
            upstream: createDashScopeUpstream(),
            defaultModel: "text-embedding-v3",
        });
        return;
    }

    if (argv[0] === "init" || argv.includes("init")) {
        const targetIdx = argv.indexOf("--target");
        const target = targetIdx >= 0 ? argv[targetIdx + 1] : "all";
        const repoRoot = process.cwd();
        const { tools } = await discoverRepoAdapters(repoRoot);
        initHarness(target ?? "all", {
            repoRoot,
            serverName: "repomcp",
            command: "npx",
            args: ["-y", "repomcp"],
            tools,
        });
        return;
    }

    const first = argv[0];
    if (first && looksLikeRemoteTarget(first)) {
        const { root, kind } = await discoverFromRemote(first);
        if (argv.includes("--mcp")) {
            await startMcpForRoot(root, argv);
            return;
        }
        process.stdout.write(`${root}\n`);
        if (kind) process.stderr.write(`kind: ${kind}\n`);
        return;
    }

    const localRoot = first ? resolveRepoRootFromArg(first) : null;
    if (localRoot) {
        if (argv.includes("--mcp")) {
            await startMcpForRoot(localRoot, argv);
            return;
        }
        const { tools } = await discoverRepoAdapters(localRoot);
        process.stdout.write(`${localRoot}\n${tools.length} tools\n`);
        return;
    }

    process.stderr.write(`Unknown target or path: ${first ?? ""}\n`);
    process.exitCode = 1;
}

const isMain =
    process.argv[1]?.includes("cli") || process.argv[1]?.endsWith("repomcp");
if (isMain && process.argv.length > 2) {
    const sub = process.argv.slice(2);
    if (sub[0] !== "test") {
        void runCli(sub);
    }
}
