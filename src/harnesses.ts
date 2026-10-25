import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { InitOptions, RepomcpTool } from "./types.js";

export type { InitOptions } from "./types.js";

function ensureDir(p: string): void {
    if (!existsSync(p))
        mkdirSync(p, { recursive: true });
}
function tier1Description(text: string): string {
    const first = text.split(/[.!?]/)[0]?.trim() ?? text;
    return first.length <= 60 ? first : first.slice(0, 57) + "...";
}
export function generatePiMcpJson(opts: InitOptions) {
    return {
        mcpServers: {
            [opts.serverName]: {
                command: opts.command,
                args: [...opts.args, "--mcp"],
            },
        },
    };
}
export function generatePiExtension(opts: InitOptions): string {
    return `/** Pi extension - register MCP server on session_start */
export default function register(pi: {
  on: (ev: string, fn: () => void) => void;
  registerMcpServer: (name: string, cfg: object) => void;
}) {
  pi.on("session_start", () => {
    pi.registerMcpServer("${opts.serverName}", {
      command: "${opts.command}",
      args: ${JSON.stringify([...opts.args, "--mcp"])},
      exposure: "codemode",
      toolExposure: "discoverable",
    });
  });
  pi.on("mcp_servers_change", () => {
    pi.registerMcpServer("${opts.serverName}", {
      command: "${opts.command}",
      args: ${JSON.stringify([...opts.args, "--mcp"])},
      exposure: "codemode",
      toolExposure: "discoverable",
    });
  });
}
`;
}
export function emitOmpHostToolsFrame(id: string, tools: RepomcpTool[]): string {
    const payload = {
        id,
        type: "set_host_tools",
        tools: tools.map((t) => ({
            name: t.name,
            label: t.name.replace(/_/g, " "),
            description: tier1Description(t.description),
            loadMode: "essential",
            readsSkillUris: true,
            parameters: {
                ...t.inputSchema,
                additionalProperties: t.inputSchema.additionalProperties ?? false,
            },
        })),
    };
    return JSON.stringify(payload) + "\n";
}
export function generateOmpSkillMd(opts: InitOptions): string {
    return `---
name: ${opts.serverName}
description: ${tier1Description(`MCP tools for ${opts.serverName}`)}
---
# ${opts.serverName}

Repo MCP tools via repomcp.
`;
}
export function generateHermesYamlBlock(opts: InitOptions): string {
    const lines = [
        `  ${opts.serverName}:`,
        `    command: ${opts.command}`,
        `    args:`,
        ...opts.args.map((a) => `      - ${JSON.stringify(a)}`),
        `      - "--mcp"`,
    ];
    return lines.join("\n");
}
export function generateCcSwitchSkill(opts: InitOptions): string {
    return `---
name: ${opts.serverName}
description: ${tier1Description(opts.serverName + " MCP bridge")}
---
# ${opts.serverName}

Synced via repomcp for cc-switch.
`;
}
export function generateClaudeMcpJson(opts: InitOptions) {
    return generatePiMcpJson(opts);
}
export function generateKiloMcpJson(opts: InitOptions) {
    const port = opts.embedPort ?? 11435;
    return {
        mcpServers: {
            [opts.serverName]: {
                command: opts.command,
                args: [...opts.args, "--mcp"],
            },
        },
        codebaseIndexing: {
            embeddingsProvider: "openai-compatible",
            openAiCompatible: {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                apiKey: "repomcp",
                modelId: "repomcp-normalized",
                options: { dimensions: 1024 },
            },
            embeddingBatchSize: 60,
        },
    };
}
export function generateCursorMcpJson(opts: InitOptions) {
    return {
        mcpServers: {
            [opts.serverName]: {
                command: opts.command,
                args: [...opts.args, "--mcp"],
            },
        },
    };
}
export function generateRooMcpJson(opts: InitOptions) {
    return generateCursorMcpJson(opts);
}
export function generateClineMcpJson(opts: InitOptions) {
    return {
        mcpServers: {
            [opts.serverName]: {
                command: opts.command,
                args: [...opts.args, "--mcp"],
            },
        },
    };
}
export function generateOpenCodeMcpJson(opts: InitOptions) {
    return generateCursorMcpJson(opts);
}
const TARGET_WRITERS = {
    pi: (opts: InitOptions, repoRoot: string) => {
        const dir = join(repoRoot, ".pi");
        ensureDir(dir);
        writeFileSync(join(dir, "mcp.json"), JSON.stringify(generatePiMcpJson(opts), null, 2));
        writeFileSync(join(dir, "register-mcp.ts"), generatePiExtension(opts));
    },
    omp: (opts: InitOptions, repoRoot: string) => {
        const skillDir = join(repoRoot, ".omp", "skills", opts.serverName);
        ensureDir(skillDir);
        writeFileSync(join(skillDir, "SKILL.md"), generateOmpSkillMd(opts));
    },
    hermes: (_opts: InitOptions, repoRoot: string) => {
        const snippet = join(repoRoot, ".repomcp", "hermes-mcp-snippet.yaml");
        ensureDir(join(repoRoot, ".repomcp"));
        writeFileSync(snippet, "# Paste under mcp_servers:\n" + generateHermesYamlBlock(_opts));
    },
    "cc-switch": (opts: InitOptions, repoRoot: string) => {
        const skillDir = join(repoRoot, ".agents", "skills", opts.serverName);
        ensureDir(skillDir);
        writeFileSync(join(skillDir, "SKILL.md"), generateCcSwitchSkill(opts));
    },
    claude: (opts: InitOptions, repoRoot: string) => {
        writeFileSync(join(repoRoot, ".mcp.json"), JSON.stringify(generateClaudeMcpJson(opts), null, 2));
    },
    kilo: (opts: InitOptions, repoRoot: string) => {
        const dir = join(repoRoot, ".kilocode");
        ensureDir(dir);
        writeFileSync(join(dir, "mcp.json"), JSON.stringify(generateKiloMcpJson(opts), null, 2));
    },
    roo: (opts: InitOptions, repoRoot: string) => {
        const dir = join(repoRoot, ".roo");
        ensureDir(dir);
        writeFileSync(join(dir, "mcp.json"), JSON.stringify(generateRooMcpJson(opts), null, 2));
    },
    cline: (opts: InitOptions, repoRoot: string) => {
        writeFileSync(join(repoRoot, "cline_mcp_settings.json"), JSON.stringify(generateClineMcpJson(opts), null, 2));
    },
    opencode: (opts: InitOptions, repoRoot: string) => {
        writeFileSync(join(repoRoot, "opencode.json"), JSON.stringify({ mcp: generateOpenCodeMcpJson(opts) }, null, 2));
    },
    cursor: (opts: InitOptions, repoRoot: string) => {
        const dir = join(repoRoot, ".cursor");
        ensureDir(dir);
        writeFileSync(join(dir, "mcp.json"), JSON.stringify(generateCursorMcpJson(opts), null, 2));
    },
};
type HarnessTarget = keyof typeof TARGET_WRITERS;

export function initHarness(target: HarnessTarget | "all" | string, opts: InitOptions): string[] {
    const written: string[] = [];
    const targets: HarnessTarget[] = target === "all"
        ? (Object.keys(TARGET_WRITERS) as HarnessTarget[])
        : [target as HarnessTarget];
    for (const t of targets) {
        TARGET_WRITERS[t](opts, opts.repoRoot);
        written.push(t);
    }
    return written;
}
