import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { RepomcpTool } from "./types.js";

const EXPORT_RE = /export\s+(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/g;
const EXPORT_CONST_RE = /export\s+const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g;

function parseTsExports(filePath: string): string[] {
    const text = readFileSync(filePath, "utf8");
    const names: string[] = [];
    let m: RegExpExecArray | null;
    EXPORT_RE.lastIndex = 0;
    while ((m = EXPORT_RE.exec(text)) !== null)
        names.push(m[1]);
    EXPORT_CONST_RE.lastIndex = 0;
    while ((m = EXPORT_CONST_RE.exec(text)) !== null)
        names.push(m[1]);
    return names;
}

function walkTsFiles(dir: string, max = 200): string[] {
    const out: string[] = [];
    if (!existsSync(dir))
        return out;
    const entries = readdirSync(dir);
    for (const e of entries) {
        if (out.length >= max)
            break;
        const p = join(dir, e);
        if (e === "node_modules" || e === "dist" || e.startsWith("."))
            continue;
        const st = statSync(p);
        if (st.isDirectory())
            out.push(...walkTsFiles(p, max - out.length));
        else if (/\.(ts|tsx|mts|cts)$/.test(e) && !e.endsWith(".d.ts"))
            out.push(p);
    }
    return out;
}

function nameToTool(name: string): RepomcpTool {
    const snake = name.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
    return {
        name: snake,
        description: `Invoke exported function ${name}`,
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: true,
        },
        mutates: /write|delete|remove|update|mutate|deploy/i.test(name),
        annotations: {
            readOnlyHint: !/write|delete|remove|update|mutate/i.test(name),
            destructiveHint: /delete|remove/i.test(name),
            idempotentHint: /get|read|list|fetch/i.test(name),
            openWorldHint: false,
        },
    };
}

export function scanRepoExports(repoRoot: string): RepomcpTool[] {
    const srcDir = join(repoRoot, "src");
    const files = existsSync(srcDir) ? walkTsFiles(srcDir) : walkTsFiles(repoRoot);
    const names = new Set<string>();
    for (const f of files) {
        for (const n of parseTsExports(f))
            names.add(n);
    }
    return [...names].map(nameToTool);
}

export function toolFromPackageBin(repoRoot: string): RepomcpTool[] {
    const pkgPath = join(repoRoot, "package.json");
    if (!existsSync(pkgPath))
        return [];
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        bin?: string | Record<string, string>;
        scripts?: Record<string, string>;
    };
    const tools: RepomcpTool[] = [];
    if (pkg.bin) {
        const bins = typeof pkg.bin === "string"
            ? { [basename(repoRoot)]: pkg.bin }
            : pkg.bin;
        for (const [name] of Object.entries(bins)) {
            tools.push({
                name: `cli_${name.replace(/[^a-z0-9_]/gi, "_")}`,
                description: `Run CLI binary ${name} (--help for args)`,
                inputSchema: {
                    type: "object",
                    properties: {
                        args: { type: "array", description: "CLI arguments" },
                    },
                    additionalProperties: false,
                },
                mutates: true,
                annotations: { destructiveHint: true, readOnlyHint: false },
            });
        }
    }
    if (pkg.scripts) {
        for (const script of Object.keys(pkg.scripts)) {
            tools.push({
                name: `npm_script_${script.replace(/[^a-z0-9_]/gi, "_")}`,
                description: `Run npm run ${script}`,
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                mutates: /deploy|publish|release/i.test(script),
                annotations: {
                    readOnlyHint: /test|lint|check/i.test(script),
                    destructiveHint: /deploy|publish/i.test(script),
                },
            });
        }
    }
    return tools;
}

export function introspectRepo(repoRoot: string): RepomcpTool[] {
    const byName = new Map<string, RepomcpTool>();
    for (const t of [...scanRepoExports(repoRoot), ...toolFromPackageBin(repoRoot)]) {
        if (!byName.has(t.name))
            byName.set(t.name, t);
    }
    return [...byName.values()];
}

export type IntrospectFullOptions = {
    allowWrite?: boolean;
    baseUrl?: string;
};

export type IntrospectFullResult = {
    tools: RepomcpTool[];
    handlers: Record<
        string,
        (args: Record<string, unknown>) => Promise<unknown> | unknown
    >;
};

export async function introspectRepoFull(
    repoRoot: string,
    opts?: IntrospectFullOptions,
): Promise<IntrospectFullResult> {
    const { discoverRepoAdapters } = await import("./adapters/index.js");
    return discoverRepoAdapters(repoRoot, opts);
}
