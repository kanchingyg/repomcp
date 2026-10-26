import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { JsonSchema, JsonSchemaProperty, RepomcpTool } from "../types.js";
import type { AdapterDiscovery, ToolHandler } from "./types.js";

export type PolyglotKind = "ts" | "js" | "py" | "go" | "rust" | "sh";

export type PolyglotParam = {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  defaultValue?: string;
};

export type PolyglotEntry = {
  kind: PolyglotKind;
  name: string;
  description: string;
  params: PolyglotParam[];
  sourceFile: string;
  /** Language-specific invocation metadata */
  invoke: PolyglotInvoke;
};

export type PolyglotInvoke =
  | {
      kind: "ts" | "js";
      exportName: string;
      filePath: string;
    }
  | {
      kind: "py";
      mode: "function" | "click" | "typer" | "argparse";
      filePath: string;
      entryName: string;
      clickName?: string;
    }
  | {
      kind: "go";
      mode: "flag" | "cobra";
      filePath: string;
      symbol: string;
      flagName?: string;
    }
  | {
      kind: "rust";
      filePath: string;
      structName: string;
      fieldName: string;
      long?: string;
      short?: string;
    }
  | {
      kind: "sh";
      filePath: string;
      functionName?: string;
    };

export type PlannedPythonRun = {
  planned: true;
  via: "uv" | "python3" | "python";
  argv: string[];
  script: string;
  entry: string;
  args: Record<string, unknown>;
};

const MUTATE_RE =
  /\b(write|delete|remove|rm\b|push|deploy|destroy|drop|insert|update|mutate|create|purge|truncate|kill|prune|uninstall|erase)\b/i;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
  ".next",
  "coverage",
]);

const MAX_FILES = 400;

function sanitizePart(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toolName(kind: PolyglotKind, relFile: string, symbol: string): string {
  const stem = sanitizePart(relFile.replace(/\.[^.]+$/, "").split(sep).pop() ?? "file");
  const sym = sanitizePart(symbol);
  return `code_${kind}_${stem}_${sym}`.replace(/_+/g, "_");
}

function suggestsMutating(name: string, description: string): boolean {
  return MUTATE_RE.test(`${name} ${description}`);
}

function tsTypeToJsonSchema(typeText: string | undefined): JsonSchemaProperty {
  const t = (typeText ?? "").trim().replace(/\s+/g, " ");
  if (!t || t === "void" || t === "undefined") return { type: "string" };
  if (/\bboolean\b/i.test(t)) return { type: "boolean" };
  if (/\bnumber\b/i.test(t) || /\bint\b/i.test(t) || /\bfloat\b/i.test(t)) return { type: "number" };
  if (/\[\]|Array<|ReadonlyArray</i.test(t)) return { type: "array", items: { type: "string" } };
  if (/\bRecord<|\bobject\b|\bObject\b/i.test(t)) return { type: "object", additionalProperties: true };
  return { type: "string", description: t.length < 80 ? t : undefined };
}

function pyHintToJsonSchema(hint: string | undefined): JsonSchemaProperty {
  const h = (hint ?? "str").trim();
  if (/^bool\b/i.test(h)) return { type: "boolean" };
  if (/^(int|float)\b/i.test(h)) return { type: "number" };
  if (/^(list|List|tuple|set)\b/i.test(h)) return { type: "array", items: { type: "string" } };
  if (/^(dict|Dict|mapping)\b/i.test(h)) return { type: "object", additionalProperties: true };
  if (/Optional\[(.+)\]/i.test(h)) return pyHintToJsonSchema(h.replace(/Optional\[(.+)\]/i, "$1"));
  return { type: "string", description: h.length < 60 ? h : undefined };
}

function buildInputSchema(params: PolyglotParam[]): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const p of params) {
    const base = p.type
      ? p.name.match(/^[a-z]/i)
        ? pyHintToJsonSchema(p.type)
        : tsTypeToJsonSchema(p.type)
      : { type: "string" as const };
    properties[p.name] = {
      ...base,
      description: p.description ?? p.type,
    };
    if (p.defaultValue !== undefined) properties[p.name].default = p.defaultValue;
    if (p.required) required.push(p.name);
  }
  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

function entryToTool(entry: PolyglotEntry): RepomcpTool {
  const mutates = suggestsMutating(entry.name, entry.description);
  const desc =
    entry.description.length > 500
      ? `${entry.description.slice(0, 497)}...`
      : entry.description;
  return {
    name: toolName(entry.kind, entry.sourceFile, entry.name),
    description: `[${entry.kind}] ${desc} (${entry.sourceFile})`,
    inputSchema: buildInputSchema(entry.params),
    mutates,
    annotations: {
      readOnlyHint: !mutates,
      destructiveHint: mutates,
      idempotentHint: !mutates,
      openWorldHint: entry.kind === "py" || entry.kind === "sh",
    },
  };
}

function walkSourceFiles(
  repoRoot: string,
  extensions: RegExp,
  max = MAX_FILES,
): string[] {
  const out: string[] = [];
  const stack = [repoRoot];
  while (stack.length > 0 && out.length < max) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (out.length >= max) break;
      if (name.startsWith(".") && name !== ".github") continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(full);
      } else if (extensions.test(name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function parseJsDocBlock(block: string): { description: string; params: Map<string, string> } {
  const lines = block
    .replace(/^\/\*\*?|\*\/$/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*\s?/, "").trim());
  const params = new Map<string, string>();
  const descLines: string[] = [];
  for (const line of lines) {
    const param = line.match(/^@param\s+(?:\{[^}]+\}\s+)?(\w+)\s*-?\s*(.*)$/);
    if (param) {
      params.set(param[1], param[2].trim());
      continue;
    }
    if (line.startsWith("@")) continue;
    if (line) descLines.push(line);
  }
  return { description: descLines.join(" ").trim(), params };
}

function splitParamList(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of raw) {
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseTsJsParam(segment: string): PolyglotParam | null {
  const cleaned = segment.replace(/^\.\.\./, "").trim();
  if (!cleaned || cleaned === "..." ) return null;
  const m = cleaned.match(
    /^([a-zA-Z_$][\w$]*)\s*(?::\s*([^=]+?))?(?:\s*=\s*(.+))?$/,
  );
  if (!m) return null;
  const name = m[1];
  const type = m[2]?.trim();
  const def = m[3]?.trim();
  return {
    name,
    type,
    required: def === undefined && !segment.includes("?") && !type?.includes("undefined"),
    defaultValue: def,
  };
}

const EXPORT_FN_RE =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)(?:\s*:\s*([^{;\n]+))?/g;
const EXPORT_CONST_FN_RE =
  /(?:^|\n)\s*export\s+const\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=]+))?\s*=>/g;
const EXPORT_DECL_FN_RE =
  /(?:^|\n)\s*export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)/g;

function precedingJsDoc(text: string, index: number): string | null {
  const before = text.slice(0, index);
  const m = before.match(/(\/\*\*[\s\S]*?\*\/)\s*$/);
  return m?.[1] ?? null;
}

export function parseTsJsSource(text: string, relPath: string): PolyglotEntry[] {
  const kind: PolyglotKind = /\.(tsx?|mts|cts)$/i.test(relPath) ? "ts" : "js";
  const entries: PolyglotEntry[] = [];
  const seen = new Set<string>();

  const consider = (
    exportName: string,
    paramsRaw: string,
    index: number,
    returnType?: string,
  ) => {
    if (exportName.startsWith("_") || seen.has(exportName)) return;
    seen.add(exportName);
    const jsdoc = precedingJsDoc(text, index);
    const doc = jsdoc ? parseJsDocBlock(jsdoc) : { description: "", params: new Map<string, string>() };
    const params = splitParamList(paramsRaw)
      .map(parseTsJsParam)
      .filter((p): p is PolyglotParam => p !== null)
      .map((p) => ({
        ...p,
        description: doc.params.get(p.name) ?? p.description,
      }));
    const desc =
      doc.description ||
      `Invoke exported function ${exportName}${returnType ? ` → ${returnType.trim()}` : ""}`;
    entries.push({
      kind,
      name: exportName,
      description: desc,
      params,
      sourceFile: relPath,
      invoke: { kind, exportName, filePath: relPath },
    });
  };

  let m: RegExpExecArray | null;
  EXPORT_DECL_FN_RE.lastIndex = 0;
  while ((m = EXPORT_DECL_FN_RE.exec(text)) !== null) {
    consider(m[1], m[2], m.index, undefined);
  }
  EXPORT_FN_RE.lastIndex = 0;
  while ((m = EXPORT_FN_RE.exec(text)) !== null) {
    if (!m[0].includes("export")) continue;
    consider(m[1], m[2], m.index, m[3]?.trim());
  }
  EXPORT_CONST_FN_RE.lastIndex = 0;
  while ((m = EXPORT_CONST_FN_RE.exec(text)) !== null) {
    consider(m[1], m[2], m.index, m[3]?.trim());
  }

  return entries;
}

function parsePythonDefParams(raw: string): PolyglotParam[] {
  const parts = splitParamList(raw);
  const params: PolyglotParam[] = [];
  for (const seg of parts) {
    const cleaned = seg.replace(/^\*\*?/, "").trim();
    if (!cleaned || cleaned === "self" || cleaned === "cls") continue;
    const m = cleaned.match(/^(\w+)\s*(?::\s*([^=]+))?(?:\s*=\s*(.+))?$/);
    if (!m) continue;
    params.push({
      name: m[1],
      type: m[2]?.trim(),
      defaultValue: m[3]?.trim(),
      required: m[3] === undefined,
    });
  }
  return params;
}

function pythonDocstringAfterDef(text: string, defEndIndex: number): string {
  const rest = text.slice(defEndIndex);
  const m = rest.match(/^\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/);
  return (m?.[1] ?? m?.[2] ?? "").trim().split(/\r?\n/)[0] ?? "";
}

const PY_DEF_RE = /(?:^|\n)(async\s+)?def\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^:\n]+))?/g;
const CLICK_OPTION_RE =
  /@click\.option\s*\(\s*["']([^"']+)["'](?:[^)]*help\s*=\s*["']([^"']*)["'])?[^)]*\)/g;
const CLICK_COMMAND_RE = /@click\.command\s*\(\s*(?:[^)]*name\s*=\s*["']([^"']+)["'])?[^)]*\)/g;
const TYPER_OPTION_RE =
  /(\w+)\s*:\s*[^=]+\s*=\s*typer\.Option\s*\(([^)]*)\)/g;
const ARGPARSE_RE =
  /\.add_argument\s*\(\s*["']([^"']+)["']([^)]*)\)/g;

export function parsePythonSource(text: string, relPath: string): PolyglotEntry[] {
  const entries: PolyglotEntry[] = [];
  const seen = new Set<string>();

  PY_DEF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_DEF_RE.exec(text)) !== null) {
    const name = m[2];
    if (name.startsWith("_")) continue;
    const params = parsePythonDefParams(m[3]);
    const hasHintsOrDoc =
      params.some((p) => p.type) ||
      pythonDocstringAfterDef(text, m.index + m[0].length).length > 0;
    if (!hasHintsOrDoc && params.length > 0) continue;
    const key = `fn:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const doc = pythonDocstringAfterDef(text, m.index + m[0].length);
    entries.push({
      kind: "py",
      name,
      description: doc || `Python function ${name}`,
      params,
      sourceFile: relPath,
      invoke: { kind: "py", mode: "function", filePath: relPath, entryName: name },
    });
  }

  CLICK_COMMAND_RE.lastIndex = 0;
  while ((m = CLICK_COMMAND_RE.exec(text)) !== null) {
    const clickName = m[1] ?? "main";
    const sliceStart = m.index;
    const slice = text.slice(sliceStart, sliceStart + 2000);
    const opts: PolyglotParam[] = [];
    CLICK_OPTION_RE.lastIndex = 0;
    let om: RegExpExecArray | null;
    while ((om = CLICK_OPTION_RE.exec(slice)) !== null) {
      const flag = om[1].replace(/^-+/, "");
      opts.push({
        name: sanitizePart(flag),
        description: om[2] || `Click option ${om[1]}`,
        required: false,
      });
    }
    const key = `click:${clickName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      kind: "py",
      name: clickName,
      description: `Click command ${clickName}`,
      params: opts,
      sourceFile: relPath,
      invoke: {
        kind: "py",
        mode: "click",
        filePath: relPath,
        entryName: clickName,
        clickName,
      },
    });
  }

  TYPER_OPTION_RE.lastIndex = 0;
  const typerParams: PolyglotParam[] = [];
  while ((m = TYPER_OPTION_RE.exec(text)) !== null) {
    typerParams.push({
      name: m[1],
      description: m[2].trim().slice(0, 120),
      required: !/default\s*=/i.test(m[2]),
    });
  }
  if (typerParams.length > 0 || /typer\.Typer\s*\(/i.test(text)) {
    const appName = "typer_app";
    const key = `typer:${relPath}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push({
        kind: "py",
        name: appName,
        description: `Typer CLI in ${relPath}`,
        params: typerParams,
        sourceFile: relPath,
        invoke: { kind: "py", mode: "typer", filePath: relPath, entryName: appName },
      });
    }
  }

  ARGPARSE_RE.lastIndex = 0;
  const argParams: PolyglotParam[] = [];
  while ((m = ARGPARSE_RE.exec(text)) !== null) {
    const flag = m[1];
    const rest = m[2];
    const isPositional = !flag.startsWith("-");
    const propName = isPositional
      ? flag
      : sanitizePart(flag.replace(/^--+/, ""));
    const typeM = rest.match(/type\s*=\s*(\w+)/);
    const helpM = rest.match(/help\s*=\s*["']([^"']*)["']/);
    const actionM = rest.match(/action\s*=\s*["'](\w+)["']/);
    argParams.push({
      name: propName,
      type: typeM?.[1],
      description: helpM?.[1],
      required: /required\s*=\s*True/i.test(rest),
      ...(actionM?.[1] === "store_true" ? { type: "bool" } : {}),
    });
  }
  if (argParams.length > 0) {
    const key = `argparse:${relPath}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push({
        kind: "py",
        name: "argparse_main",
        description: `argparse CLI in ${relPath}`,
        params: argParams,
        sourceFile: relPath,
        invoke: { kind: "py", mode: "argparse", filePath: relPath, entryName: "main" },
      });
    }
  }

  return entries;
}

const GO_FLAG_RE =
  /flag\.(String|Int|Bool|Float64)\s*\(\s*["']([^"']+)["']\s*,\s*[^,]*,\s*["']([^"']*)["']\s*\)/g;
const COBRA_USE_RE =
  /&cobra\.Command\s*\{[^}]*Use:\s*["']([^"']+)["'][^}]*Short:\s*["']([^"']*)["']/g;

export function parseGoSource(text: string, relPath: string): PolyglotEntry[] {
  const entries: PolyglotEntry[] = [];
  let m: RegExpExecArray | null;

  GO_FLAG_RE.lastIndex = 0;
  while ((m = GO_FLAG_RE.exec(text)) !== null) {
    const varName = m[2];
    entries.push({
      kind: "go",
      name: varName,
      description: m[3] || `Go flag ${varName}`,
      params: [{ name: varName, type: m[1].toLowerCase(), required: false }],
      sourceFile: relPath,
      invoke: {
        kind: "go",
        mode: "flag",
        filePath: relPath,
        symbol: varName,
        flagName: varName,
      },
    });
  }

  COBRA_USE_RE.lastIndex = 0;
  while ((m = COBRA_USE_RE.exec(text)) !== null) {
    const use = m[1];
    entries.push({
      kind: "go",
      name: use,
      description: m[2] || `Cobra command ${use}`,
      params: [],
      sourceFile: relPath,
      invoke: { kind: "go", mode: "cobra", filePath: relPath, symbol: use },
    });
  }

  return entries;
}

const RUST_STRUCT_RE = /struct\s+(\w+)\s*\{([^}]+)\}/g;
const RUST_ARG_RE =
  /#\[arg\(([^\]]*)\)\]\s*\n\s*pub\s+(\w+)\s*:\s*([^,\n]+)/g;

function parseRustArgAttrs(attrs: string): { long?: string; short?: string } {
  const longM = attrs.match(/long\s*=\s*["']([^"']+)["']/);
  const shortM = attrs.match(/short\s*=\s*['"](.)['"]/);
  const longBare = attrs.match(/\blong\b/);
  return {
    long: longM?.[1] ?? (longBare ? undefined : undefined),
    short: shortM?.[1],
  };
}

export function parseRustSource(text: string, relPath: string): PolyglotEntry[] {
  const entries: PolyglotEntry[] = [];
  let m: RegExpExecArray | null;

  RUST_ARG_RE.lastIndex = 0;
  while ((m = RUST_ARG_RE.exec(text)) !== null) {
    const attrs = parseRustArgAttrs(m[1]);
    const field = m[2];
    const ty = m[3].trim();
    const structCtx = text.slice(0, m.index).match(/struct\s+(\w+)\s*\{[^}]*$/);
    const structName = structCtx?.[1] ?? "Cli";
    entries.push({
      kind: "rust",
      name: `${structName}_${field}`,
      description: `clap field ${field} on ${structName}`,
      params: [
        {
          name: attrs.long ?? field,
          type: ty,
          required: !ty.includes("Option"),
        },
      ],
      sourceFile: relPath,
      invoke: {
        kind: "rust",
        filePath: relPath,
        structName,
        fieldName: field,
        long: attrs.long,
        short: attrs.short,
      },
    });
  }

  if (entries.length === 0) {
    RUST_STRUCT_RE.lastIndex = 0;
    while ((m = RUST_STRUCT_RE.exec(text)) !== null) {
      if (!/Parser|Args|Cli/i.test(m[1])) continue;
      const body = m[2];
      const fieldRe = /#\[arg[^\]]*\]\s*\n\s*pub\s+(\w+)/g;
      let fm: RegExpExecArray | null;
      while ((fm = fieldRe.exec(body)) !== null) {
        entries.push({
          kind: "rust",
          name: `${m[1]}_${fm[1]}`,
          description: `clap ${fm[1]} on ${m[1]}`,
          params: [{ name: fm[1], required: true }],
          sourceFile: relPath,
          invoke: {
            kind: "rust",
            filePath: relPath,
            structName: m[1],
            fieldName: fm[1],
          },
        });
      }
    }
  }

  return entries;
}

const SH_PARAM_RE = /^\s*#\s*@param\s+(\w+)(?:\s+(\S+))?(?:\s+(.*))?$/gm;
const SH_FN_RE = /^(?:function\s+)?([a-zA-Z_][\w]*)\s*\(\)\s*\{/gm;

export function parseShellSource(text: string, relPath: string): PolyglotEntry[] {
  const entries: PolyglotEntry[] = [];
  const params: PolyglotParam[] = [];
  let m: RegExpExecArray | null;

  SH_PARAM_RE.lastIndex = 0;
  while ((m = SH_PARAM_RE.exec(text)) !== null) {
    params.push({
      name: m[1],
      type: m[2],
      description: m[3]?.trim(),
      required: true,
    });
  }

  const fnNames: string[] = [];
  SH_FN_RE.lastIndex = 0;
  while ((m = SH_FN_RE.exec(text)) !== null) {
    if (!m[1].startsWith("_")) fnNames.push(m[1]);
  }

  if (params.length > 0) {
    const label = fnNames[0] ?? relPath.split(sep).pop() ?? "script";
    entries.push({
      kind: "sh",
      name: label.replace(/\.sh$/i, ""),
      description: `Shell script ${relPath} (${params.length} @param)`,
      params,
      sourceFile: relPath,
      invoke: { kind: "sh", filePath: relPath, functionName: fnNames[0] },
    });
  }

  return entries;
}

export function resolvePythonLauncher(repoRoot: string): PlannedPythonRun["via"] {
  if (existsSync(join(repoRoot, "pyproject.toml"))) return "uv";
  if (existsSync(join(repoRoot, "uv.lock"))) return "uv";
  return "python3";
}

export function buildPythonArgv(
  repoRoot: string,
  invoke: Extract<PolyglotInvoke, { kind: "py" }>,
  args: Record<string, unknown>,
): PlannedPythonRun {
  const via = resolvePythonLauncher(repoRoot);
  const absScript = join(repoRoot, invoke.filePath);
  const prefix =
    via === "uv" ? ["uv", "run", "python"] : via === "python3" ? ["python3"] : ["python"];

  const argv = [...prefix, absScript];

  if (invoke.mode === "click" || invoke.mode === "typer" || invoke.mode === "argparse") {
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue;
      if (typeof v === "boolean") {
        if (v) argv.push(`--${k}`);
      } else {
        argv.push(`--${k}`, String(v));
      }
    }
  } else {
    argv.push("-c", `_repomcp_bridge_${invoke.entryName}`, JSON.stringify(args));
  }

  return {
    planned: true,
    via,
    argv,
    script: invoke.filePath,
    entry: invoke.entryName,
    args,
  };
}

function makeHandler(
  repoRoot: string,
  entry: PolyglotEntry,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    switch (entry.invoke.kind) {
      case "py":
        return buildPythonArgv(repoRoot, entry.invoke, args);
      case "ts":
      case "js": {
        const modPath = join(repoRoot, entry.invoke.filePath);
        return {
          planned: true,
          via: "node",
          argv: ["node", modPath],
          exportName: entry.invoke.exportName,
          args,
        };
      }
      case "go": {
        const iv = entry.invoke;
        if (iv.mode === "flag" && iv.flagName) {
          const val = args[iv.flagName];
          return {
            planned: true,
            via: "go",
            argv: ["go", "run", join(repoRoot, iv.filePath), `-${iv.flagName}`, String(val ?? "")],
            args,
          };
        }
        return {
          planned: true,
          via: "go",
          argv: ["go", "run", join(repoRoot, iv.filePath), iv.symbol],
          args,
        };
      }
      case "rust": {
        const iv = entry.invoke;
        const flag = iv.long ?? iv.fieldName;
        const val = args[flag] ?? args[iv.fieldName];
        return {
          planned: true,
          via: "cargo",
          argv: ["cargo", "run", "--", `--${flag}`, String(val ?? "")],
          crate: iv.structName,
          args,
        };
      }
      case "sh": {
        const iv = entry.invoke;
        const envArgs = Object.entries(args).flatMap(([k, v]) => [`${k}=${String(v)}`]);
        return {
          planned: true,
          via: "sh",
          argv: ["sh", join(repoRoot, iv.filePath), ...envArgs],
          functionName: iv.functionName,
          args,
        };
      }
      default: {
        const _never: never = entry.invoke;
        return _never;
      }
    }
  };
}

export function discoverPolyglotCode(repoRoot: string): AdapterDiscovery {
  const tools: RepomcpTool[] = [];
  const handlers: Record<string, ToolHandler> = {};
  const usedNames = new Set<string>();

  const rel = (abs: string) => relative(repoRoot, abs).split(sep).join("/");

  const ingest = (entry: PolyglotEntry) => {
    const tool = entryToTool(entry);
    let name = tool.name;
    let n = 2;
    while (usedNames.has(name)) {
      name = `${tool.name}_${n}`;
      n++;
    }
    usedNames.add(name);
    tool.name = name;
    tools.push(tool);
    handlers[name] = makeHandler(repoRoot, entry);
  };

  for (const file of walkSourceFiles(repoRoot, /\.(tsx?|mts|cts|jsx?|mjs|cjs)$/i)) {
    const text = readFileSync(file, "utf8");
    for (const e of parseTsJsSource(text, rel(file))) ingest(e);
  }

  for (const file of walkSourceFiles(repoRoot, /\.py$/i)) {
    const text = readFileSync(file, "utf8");
    for (const e of parsePythonSource(text, rel(file))) ingest(e);
  }

  for (const file of walkSourceFiles(repoRoot, /\.go$/i)) {
    const text = readFileSync(file, "utf8");
    for (const e of parseGoSource(text, rel(file))) ingest(e);
  }

  for (const file of walkSourceFiles(repoRoot, /\.rs$/i)) {
    const text = readFileSync(file, "utf8");
    for (const e of parseRustSource(text, rel(file))) ingest(e);
  }

  for (const file of walkSourceFiles(repoRoot, /\.sh$/i)) {
    const text = readFileSync(file, "utf8");
    for (const e of parseShellSource(text, rel(file))) ingest(e);
  }

  return { tools, handlers };
}
