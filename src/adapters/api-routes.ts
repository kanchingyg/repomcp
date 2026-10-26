import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { JsonSchema, JsonSchemaProperty, RepomcpTool } from "../types.js";
import type { AdapterDiscovery, ToolHandler } from "./types.js";

export type RequestDescriptor = {
  method: string;
  path: string;
  body?: unknown;
};

export type ApiToolResult = {
  request: RequestDescriptor;
  planned?: boolean;
  status?: number;
  responseBody?: string;
};

export type ApiRouteEntry = {
  name: string;
  method: string;
  path: string;
  source: "openapi" | "graphql" | "static" | "wrangler";
  mutates: boolean;
  description: string;
};

export type ApiDiscoverySummary = {
  routeCount: number;
  bySource: Record<string, number>;
  byMethod: Record<string, number>;
  routes: ApiRouteEntry[];
};

type RouteSpec = {
  name: string;
  method: string;
  path: string;
  source: ApiRouteEntry["source"];
  description: string;
  inputSchema: JsonSchema;
  mutates: boolean;
  destructive: boolean;
  buildBody?: (args: Record<string, unknown>) => unknown;
};

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "coverage",
  "build",
  ".next",
  "vendor",
]);

const OPENAPI_NAMES =
  /^(openapi|swagger)(\.(json|ya?ml))?$/i;

const MAX_FILES = 4000;

function sanitizeToolPart(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toolNameFromHttp(method: string, path: string, suffix?: string): string {
  const pathPart = sanitizeToolPart(
    path
      .replace(/^\//, "")
      .replace(/\{([^}]+)\}/g, "$1")
      .replace(/\//g, "_") || "root",
  );
  const base = `api_${method.toLowerCase()}_${pathPart}`;
  return suffix ? `${base}_${suffix}` : base;
}

function methodFlags(method: string): { mutates: boolean; destructive: boolean } {
  const upper = method.toUpperCase();
  const mutates = MUTATING_METHODS.has(upper);
  return {
    mutates,
    destructive: upper === "DELETE",
  };
}

function annotationsFor(method: string): RepomcpTool["annotations"] {
  const { mutates, destructive } = methodFlags(method);
  return {
    readOnlyHint: !mutates,
    destructiveHint: destructive,
    idempotentHint: method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD",
    openWorldHint: true,
  };
}

function walkFiles(
  dir: string,
  predicate: (name: string, rel: string) => boolean,
  max = MAX_FILES,
): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;

  const stack = [dir];
  while (stack.length > 0 && out.length < max) {
    const current = stack.pop();
    if (!current) break;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= max) break;
      if (SKIP_DIRS.has(entry)) continue;
      const abs = join(current, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      const rel = relative(dir, abs).split(sep).join("/");
      if (predicate(entry, rel)) out.push(abs);
    }
  }
  return out;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"') {
      out += ch;
      i++;
      while (i < text.length) {
        out += text[i];
        if (text[i] === "\\") {
          i++;
          if (i < text.length) {
            out += text[i];
            i++;
          }
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function pathParamNames(routePath: string): string[] {
  const names: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(routePath)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function applyPathParams(
  routePath: string,
  args: Record<string, unknown>,
): string {
  return routePath.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const v = args[key];
    if (v === undefined || v === null) return `{${key}}`;
    return encodeURIComponent(String(v));
  });
}

function schemaWithPathParams(
  routePath: string,
  extra?: Record<string, JsonSchemaProperty>,
  includeBody = false,
): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = { ...extra };
  for (const p of pathParamNames(routePath)) {
    properties[p] = { type: "string", description: `Path parameter ${p}` };
  }
  if (includeBody) {
    properties.body = {
      type: "object",
      description: "JSON request body",
    };
  }
  const required = pathParamNames(routePath).filter((p) => properties[p]);
  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

function makeRequestHandler(
  spec: RouteSpec,
  baseUrl?: string,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const path = applyPathParams(spec.path, args);
    const body =
      spec.buildBody !== undefined
        ? spec.buildBody(args)
        : args.body !== undefined
          ? args.body
          : undefined;

    const request: RequestDescriptor = {
      method: spec.method,
      path,
      ...(body !== undefined ? { body } : {}),
    };

    if (!baseUrl) {
      return { request, planned: true } satisfies ApiToolResult;
    }

    const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    const init: RequestInit = { method: spec.method };
    if (body !== undefined && spec.method !== "GET" && spec.method !== "HEAD") {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const responseBody = await res.text();
    return {
      request,
      status: res.status,
      responseBody,
    } satisfies ApiToolResult;
  };
}

function registerRoute(
  specs: RouteSpec[],
  seen: Set<string>,
  spec: RouteSpec,
): void {
  let name = spec.name;
  let n = 2;
  while (seen.has(name)) {
    name = `${spec.name}_${n}`;
    n++;
  }
  seen.add(name);
  specs.push({ ...spec, name });
}

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
};

function openApiRoutesFromJson(text: string, fileLabel: string): RouteSpec[] {
  let doc: {
    paths?: Record<string, Record<string, OpenApiOperation>>;
  };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch {
    return [];
  }
  if (!doc.paths || typeof doc.paths !== "object") return [];

  const specs: RouteSpec[] = [];
  const seen = new Set<string>();

  for (const [path, methods] of Object.entries(doc.paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, op] of Object.entries(methods)) {
      const upper = method.toUpperCase();
      if (!HTTP_METHODS.has(upper)) continue;
      const operation = op ?? {};
      const { mutates, destructive } = methodFlags(upper);
      const opId = operation.operationId
        ? sanitizeToolPart(operation.operationId)
        : undefined;
      const name = toolNameFromHttp(upper, path, opId);
      const desc =
        operation.summary ??
        operation.description ??
        `${upper} ${path} (from ${fileLabel})`;
      registerRoute(specs, seen, {
        name,
        method: upper,
        path,
        source: "openapi",
        description: `[openapi] ${desc}`,
        inputSchema: schemaWithPathParams(
          path,
          undefined,
          mutates && upper !== "GET",
        ),
        mutates,
        destructive,
      });
    }
  }
  return specs;
}

function openApiRoutesFromYaml(text: string, fileLabel: string): RouteSpec[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return openApiRoutesFromJson(trimmed, fileLabel);
  }

  const specs: RouteSpec[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  let inPaths = false;
  let currentPath: string | null = null;

  for (const line of lines) {
    if (/^paths:\s*$/i.test(line)) {
      inPaths = true;
      currentPath = null;
      continue;
    }
    if (inPaths && /^[^\s#]/.test(line) && !/^paths:/i.test(line)) {
      inPaths = false;
      currentPath = null;
      continue;
    }
    if (!inPaths) continue;

    const pathMatch = line.match(/^ {2}(\/[^\s:]+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    if (!currentPath) continue;

    const methodMatch = line.match(
      /^ {4}(get|post|put|patch|delete|head|options):\s*$/i,
    );
    if (!methodMatch) continue;

    const upper = methodMatch[1].toUpperCase();
    const { mutates, destructive } = methodFlags(upper);
    registerRoute(specs, seen, {
      name: toolNameFromHttp(upper, currentPath),
      method: upper,
      path: currentPath,
      source: "openapi",
      description: `[openapi] ${upper} ${currentPath} (from ${fileLabel})`,
      inputSchema: schemaWithPathParams(
        currentPath,
        undefined,
        mutates && upper !== "GET",
      ),
      mutates,
      destructive,
    });
  }
  return specs;
}

function discoverOpenApiSpecs(repoRoot: string): RouteSpec[] {
  const files = walkFiles(repoRoot, (name, rel) => {
    if (OPENAPI_NAMES.test(name)) return true;
    return /openapi|swagger/i.test(rel) && /\.(json|ya?ml)$/i.test(name);
  });

  const specs: RouteSpec[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    const label = relative(repoRoot, file).split(sep).join("/");
    const lower = file.toLowerCase();
    const parsed =
      lower.endsWith(".json") || text.trim().startsWith("{")
        ? openApiRoutesFromJson(text, label)
        : openApiRoutesFromYaml(text, label);
    for (const s of parsed) {
      registerRoute(specs, seen, s);
    }
  }
  return specs;
}

function parseGraphQLBlock(content: string, typeName: "Query" | "Mutation"): string[] {
  const re = new RegExp(
    `type\\s+${typeName}\\s*\\{([^}]*)\\}`,
    "is",
  );
  const block = content.match(re);
  if (!block) return [];
  const fields: string[] = [];
  const fieldRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(|:)/gm;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(block[1])) !== null) {
    fields.push(m[1]);
  }
  return fields;
}

function discoverGraphQL(repoRoot: string): RouteSpec[] {
  const files = walkFiles(
    repoRoot,
    (name) => /\.(graphql|gql)$/i.test(name) || name === "schema.graphql",
  );
  const specs: RouteSpec[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    const label = relative(repoRoot, file).split(sep).join("/");

    for (const field of parseGraphQLBlock(text, "Query")) {
      registerRoute(specs, seen, {
        name: `graphql_query_${sanitizeToolPart(field)}`,
        method: "POST",
        path: "/graphql",
        source: "graphql",
        description: `[graphql] Query.${field} (from ${label})`,
        inputSchema: {
          type: "object",
          properties: {
            variables: {
              type: "object",
              description: "GraphQL variables",
            },
          },
          additionalProperties: false,
        },
        mutates: false,
        destructive: false,
        buildBody: (args) => ({
          query: `query { ${field} }`,
          ...(args.variables !== undefined ? { variables: args.variables } : {}),
        }),
      });
    }

    for (const field of parseGraphQLBlock(text, "Mutation")) {
      registerRoute(specs, seen, {
        name: `graphql_mutation_${sanitizeToolPart(field)}`,
        method: "POST",
        path: "/graphql",
        source: "graphql",
        description: `[graphql] Mutation.${field} (from ${label})`,
        inputSchema: {
          type: "object",
          properties: {
            variables: {
              type: "object",
              description: "GraphQL variables",
            },
          },
          additionalProperties: false,
        },
        mutates: true,
        destructive: false,
        buildBody: (args) => ({
          query: `mutation { ${field} }`,
          ...(args.variables !== undefined ? { variables: args.variables } : {}),
        }),
      });
    }
  }
  return specs;
}

const STATIC_ROUTE_RE =
  /(?:^|[^\w])(?:app|router|api|server|fastify)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/gim;

const FASTAPI_ROUTE_RE =
  /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gim;

function scanSourceRoutes(text: string, fileLabel: string): RouteSpec[] {
  const specs: RouteSpec[] = [];
  const seen = new Set<string>();

  const apply = (method: string, path: string) => {
    const upper = method.toUpperCase();
    if (upper === "ALL") {
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        applySingle(m, path);
      }
      return;
    }
    applySingle(upper, path);
  };

  const applySingle = (upper: string, path: string) => {
    if (!HTTP_METHODS.has(upper)) return;
    const { mutates, destructive } = methodFlags(upper);
    registerRoute(specs, seen, {
      name: toolNameFromHttp(upper, path),
      method: upper,
      path,
      source: "static",
      description: `[static] ${upper} ${path} (${fileLabel})`,
      inputSchema: schemaWithPathParams(path, undefined, mutates),
      mutates,
      destructive,
    });
  };

  STATIC_ROUTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATIC_ROUTE_RE.exec(text)) !== null) {
    apply(m[1], m[2]);
  }

  FASTAPI_ROUTE_RE.lastIndex = 0;
  while ((m = FASTAPI_ROUTE_RE.exec(text)) !== null) {
    apply(m[1], m[2]);
  }

  return specs;
}

function nextRoutePathFromFile(repoRoot: string, absPath: string): string | null {
  const rel = relative(repoRoot, absPath).split(sep).join("/");
  const match =
    rel.match(/(?:^|\/)(?:src\/)?app\/(.+)\/route\.(?:ts|tsx|js|jsx|mts)$/i) ??
    rel.match(/app\/(.+)\/route\.(?:ts|tsx|js|jsx|mts)$/i);
  if (!match) return null;
  let segments = match[1].split("/");
  if (segments[0] === "api") segments = segments.slice(1);
  const parts = segments.map((seg) =>
    seg.startsWith("[") && seg.endsWith("]")
      ? `{${seg.slice(1, -1).replace(/^\.\.\./, "")}}`
      : seg,
  );
  return `/api/${parts.join("/")}`;
}

function discoverStaticRoutes(repoRoot: string): RouteSpec[] {
  const codeFiles = walkFiles(repoRoot, (name, rel) => {
    if (/route\.(ts|tsx|js|jsx|mts)$/i.test(name) && /(^|\/)app\//i.test(rel)) {
      return true;
    }
    return /\.(ts|tsx|js|jsx|py|mts)$/i.test(name);
  });

  const specs: RouteSpec[] = [];
  const seen = new Set<string>();

  for (const file of codeFiles) {
    const text = readText(file);
    if (!text) continue;
    const label = relative(repoRoot, file).split(sep).join("/");

    if (/route\.(ts|tsx|js|jsx|mts)$/i.test(file)) {
      const routePath = nextRoutePathFromFile(repoRoot, file);
      if (routePath) {
        const exportRe =
          /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
        let em: RegExpExecArray | null;
        while ((em = exportRe.exec(text)) !== null) {
          const upper = em[1];
          const { mutates, destructive } = methodFlags(upper);
          registerRoute(specs, seen, {
            name: toolNameFromHttp(upper, routePath, "next"),
            method: upper,
            path: routePath,
            source: "static",
            description: `[static] Next.js ${upper} ${routePath} (${label})`,
            inputSchema: schemaWithPathParams(routePath, undefined, mutates),
            mutates,
            destructive,
          });
        }
      }
    }

    if (/\.(ts|tsx|js|jsx|py|mts)$/i.test(file)) {
      for (const s of scanSourceRoutes(text, label)) {
        registerRoute(specs, seen, s);
      }
    }
  }
  return specs;
}

type WranglerBindings = {
  d1: string[];
  kv: string[];
  r2: string[];
};

function parseWranglerToml(text: string): WranglerBindings {
  const out: WranglerBindings = { d1: [], kv: [], r2: [] };
  const lines = text.split(/\r?\n/);
  let section: "d1" | "kv" | "r2" | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[\[d1_databases\]\]/i.test(trimmed)) {
      section = "d1";
      continue;
    }
    if (/^\[\[kv_namespaces\]\]/i.test(trimmed)) {
      section = "kv";
      continue;
    }
    if (/^\[\[r2_buckets\]\]/i.test(trimmed)) {
      section = "r2";
      continue;
    }
    if (/^\[/.test(trimmed) && !/^\[\[/.test(trimmed)) {
      section = null;
      continue;
    }
    const binding = trimmed.match(/^binding\s*=\s*["']?([^"'\s#]+)["']?/i);
    if (binding && section) {
      out[section].push(binding[1]);
    }
  }
  return out;
}

function parseWranglerJson(text: string): WranglerBindings {
  const out: WranglerBindings = { d1: [], kv: [], r2: [] };
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(stripJsonc(text)) as Record<string, unknown>;
  } catch {
    return out;
  }

  const readBindings = (key: string, bucket: "d1" | "kv" | "r2") => {
    const arr = doc[key];
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item && typeof item === "object" && "binding" in item) {
        const b = (item as { binding?: unknown }).binding;
        if (typeof b === "string" && b) out[bucket].push(b);
      }
    }
  };

  readBindings("d1_databases", "d1");
  readBindings("kv_namespaces", "kv");
  readBindings("r2_buckets", "r2");
  return out;
}

function discoverWranglerBindings(repoRoot: string): RouteSpec[] {
  const candidates = [
    join(repoRoot, "wrangler.toml"),
    join(repoRoot, "wrangler.jsonc"),
    join(repoRoot, "wrangler.json"),
  ];
  const specs: RouteSpec[] = [];
  const seen = new Set<string>();

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readText(file);
    if (!text) continue;
    const label = relative(repoRoot, file).split(sep).join("/");
    const bindings =
      file.endsWith(".toml") ? parseWranglerToml(text) : parseWranglerJson(text);

    const add = (kind: keyof WranglerBindings, binding: string) => {
      registerRoute(specs, seen, {
        name: `cf_inspect_${kind}_${sanitizeToolPart(binding)}`,
        method: "GET",
        path: `/__repomcp/bindings/${kind}/${binding}`,
        source: "wrangler",
        description: `[wrangler] Inspect ${kind.toUpperCase()} binding "${binding}" (${label})`,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        mutates: false,
        destructive: false,
        buildBody: () => ({
          action: "inspect",
          kind,
          binding,
          config: label,
        }),
      });
    };

    for (const b of bindings.d1) add("d1", b);
    for (const b of bindings.kv) add("kv", b);
    for (const b of bindings.r2) add("r2", b);
  }
  return specs;
}

function specsToDiscovery(
  specs: RouteSpec[],
  baseUrl?: string,
): AdapterDiscovery {
  const tools: RepomcpTool[] = [];
  const handlers: Record<string, ToolHandler> = {};

  for (const spec of specs) {
    tools.push({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      mutates: spec.mutates,
      annotations: {
        ...annotationsFor(spec.method),
        destructiveHint: spec.destructive,
      },
    });
    handlers[spec.name] = makeRequestHandler(spec, baseUrl);
  }

  return { tools, handlers };
}

export function summarizeApiDiscovery(discovery: AdapterDiscovery): ApiDiscoverySummary {
  const routes: ApiRouteEntry[] = discovery.tools.map((t) => {
    const sourceMatch = t.description.match(/^\[(\w+)\]/);
    const source = (sourceMatch?.[1] ?? "static") as ApiRouteEntry["source"];
    const methodMatch = t.description.match(
      /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/,
    );
    const pathMatch = t.description.match(
      /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s(]+)/,
    );
    return {
      name: t.name,
      method: methodMatch?.[1] ?? "GET",
      path: pathMatch?.[1] ?? "/",
      source:
        source === "openapi" ||
        source === "graphql" ||
        source === "static" ||
        source === "wrangler"
          ? source
          : "static",
      mutates: Boolean(t.mutates),
      description: t.description,
    };
  });

  const bySource: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  for (const r of routes) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
  }

  return {
    routeCount: routes.length,
    bySource,
    byMethod,
    routes,
  };
}

export async function discoverApiRoutes(
  repoRoot: string,
  opts?: { baseUrl?: string },
): Promise<AdapterDiscovery> {
  const baseUrl = opts?.baseUrl;
  const seen = new Set<string>();
  const all: RouteSpec[] = [];

  for (const batch of [
    discoverOpenApiSpecs(repoRoot),
    discoverGraphQL(repoRoot),
    discoverStaticRoutes(repoRoot),
    discoverWranglerBindings(repoRoot),
  ]) {
    for (const spec of batch) {
      registerRoute(all, seen, spec);
    }
  }

  return specsToDiscovery(all, baseUrl);
}
