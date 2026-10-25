import type { RepomcpTool } from "../types.js";

export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

export type AdapterDiscovery = {
  tools: RepomcpTool[];
  handlers: Record<string, ToolHandler>;
};

export function emptyDiscovery(): AdapterDiscovery {
  return { tools: [], handlers: {} };
}

export function mergeDiscoveries(...parts: AdapterDiscovery[]): AdapterDiscovery {
  const tools: RepomcpTool[] = [];
  const handlers: Record<string, ToolHandler> = {};
  const seen = new Set<string>();
  for (const part of parts) {
    for (const t of part.tools) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      tools.push(t);
      const h = part.handlers[t.name];
      if (h) handlers[t.name] = h;
    }
  }
  return { tools, handlers };
}
