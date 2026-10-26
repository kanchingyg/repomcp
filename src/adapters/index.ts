import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { scanRepoExports, toolFromPackageBin } from "../introspect.js";
import type { RepomcpTool } from "../types.js";
import { crawlCliBinary, parseHelpText } from "./cli-crawler.js";
import type { ParsedCliFlag, ParsedHelp } from "./cli-crawler.js";
import { discoverApiRoutes } from "./api-routes.js";
import { discoverDataSources } from "./data-sources.js";
import { buildBm25Index, bm25Search, discoverDocsIndex } from "./docs-bm25.js";
import type { Bm25Document, Bm25Hit, Bm25Index } from "./docs-bm25.js";
import { discoverPolyglotCode } from "./polyglot-code.js";
import {
  discoverFromRemote,
  discoverRemoteTarget,
  parseRemoteTarget,
  resolveRemoteTarget,
} from "./remote-target.js";
import type { ParsedRemoteTarget, RemoteResolveOptions, ResolvedRemoteTarget } from "./remote-target.js";
import { discoverTaskRunners } from "./task-runners.js";
import {
  emptyDiscovery,
  mergeDiscoveries,
  type AdapterDiscovery,
  type ToolHandler,
} from "./types.js";

export {
  crawlCliBinary,
  parseHelpText,
  discoverApiRoutes,
  discoverDataSources,
  buildBm25Index,
  bm25Search,
  discoverDocsIndex,
  discoverPolyglotCode,
  discoverFromRemote,
  discoverRemoteTarget,
  parseRemoteTarget,
  resolveRemoteTarget,
  discoverTaskRunners,
  emptyDiscovery,
  mergeDiscoveries,
};
export type {
  ParsedCliFlag,
  ParsedHelp,
  Bm25Document,
  Bm25Hit,
  Bm25Index,
  ParsedRemoteTarget,
  RemoteResolveOptions,
  ResolvedRemoteTarget,
  AdapterDiscovery,
  ToolHandler,
};

function legacyPlannedHandler(
  repoRoot: string,
  tool: RepomcpTool,
): ToolHandler {
  const cwd = repoRoot;
  if (tool.name.startsWith("npm_script_")) {
    const script = tool.name.slice("npm_script_".length);
    return () => ({ planned: true, command: ["npm", "run", script], cwd });
  }
  if (tool.name.startsWith("cli_")) {
    const pkgPath = join(repoRoot, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        bin?: string | Record<string, string>;
      };
      if (pkg.bin) {
        const bins =
          typeof pkg.bin === "string"
            ? { [basename(repoRoot)]: pkg.bin }
            : pkg.bin;
        for (const [name, rel] of Object.entries(bins)) {
          const expected = `cli_${name.replace(/[^a-z0-9_]/gi, "_")}`;
          if (expected === tool.name) {
            return () => ({
              planned: true,
              command: ["node", join(repoRoot, rel)],
              cwd,
            });
          }
        }
      }
    }
    return () => ({
      planned: true,
      command: ["npx", tool.name.replace(/^cli_/, "")],
      cwd,
    });
  }
  return () => ({
    planned: true,
    command: ["node", "-e", `/* invoke ${tool.name} */`],
    cwd,
  });
}

function legacyIntrospectDiscovery(repoRoot: string): AdapterDiscovery {
  const byName = new Map<string, RepomcpTool>();
  const handlers: Record<string, ToolHandler> = {};
  for (const t of [...scanRepoExports(repoRoot), ...toolFromPackageBin(repoRoot)]) {
    if (!byName.has(t.name)) {
      byName.set(t.name, t);
      handlers[t.name] = legacyPlannedHandler(repoRoot, t);
    }
  }
  return { tools: [...byName.values()], handlers };
}

export async function discoverRepoAdapters(
  repoRoot: string,
  opts?: { allowWrite?: boolean; baseUrl?: string },
): Promise<AdapterDiscovery> {
  const api = await discoverApiRoutes(repoRoot, { baseUrl: opts?.baseUrl });
  return mergeDiscoveries(
    discoverPolyglotCode(repoRoot),
    discoverTaskRunners(repoRoot),
    discoverDataSources(repoRoot, { allowWrite: opts?.allowWrite }),
    discoverDocsIndex(repoRoot),
    discoverRemoteTarget(repoRoot),
    legacyIntrospectDiscovery(repoRoot),
    api,
  );
}
