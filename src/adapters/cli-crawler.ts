import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { JsonSchema, RepomcpTool } from "../types.js";
import type { AdapterDiscovery, ToolHandler } from "./types.js";

export type ParsedCliFlag = {
  /** Stable property name for JSON schema / handler */
  name: string;
  long?: string;
  short?: string;
  takesValue: boolean;
  /** `--[no-]flag` style boolean */
  negatable?: boolean;
  description?: string;
  defaultValue?: string;
  enumValues?: string[];
  positional?: boolean;
  optional?: boolean;
};

export type ParsedHelp = {
  subcommands: string[];
  flags: ParsedCliFlag[];
  positionals: ParsedCliFlag[];
  summary?: string;
};

const MUTATE_RE =
  /\b(write|delete|remove|rm\b|push|deploy|destroy|drop|insert|update|mutate|create|purge|truncate|kill|prune|uninstall|erase)\b/i;

const DEFAULT_DEPTH = 2;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_HELP_BYTES = 512 * 1024;

function safeBinaryRoots(): string[] {
  const roots = [tmpdir(), homedir()];
  if (process.platform === "win32") {
    for (const envKey of ["ProgramFiles", "ProgramFiles(x86)", "SystemRoot"]) {
      const v = process.env[envKey];
      if (v) roots.push(v);
    }
  } else {
    roots.push("/usr", "/usr/local", "/bin", "/opt");
  }
  return roots.map((r) => resolve(r));
}

function isUnderSafeRoot(absPath: string, roots: string[]): boolean {
  const target = resolve(absPath);
  return roots.some((root) => target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`));
}

export function resolveCliBinary(binary: string): string {
  const trimmed = binary.trim();
  if (!trimmed) {
    throw new Error("CLI binary name is required");
  }
  if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    const abs = resolve(trimmed);
    try {
      accessSync(abs, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    } catch {
      throw new Error(`CLI binary not executable: ${trimmed}`);
    }
    if (!isUnderSafeRoot(abs, safeBinaryRoots())) {
      throw new Error(`CLI binary path is outside allowed roots: ${trimmed}`);
    }
    return abs;
  }
  const lookupCmd = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(lookupCmd, [trimmed], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (found.status === 0 && found.stdout.trim()) {
    const first = found.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (first) return first;
  }
  throw new Error(`CLI binary not found on PATH: ${trimmed}`);
}

function mergeOutput(stdout: string, stderr: string): string {
  const parts = [stdout, stderr].map((s) => s.trim()).filter(Boolean);
  return parts.join("\n");
}

function runHelpSync(
  binary: string,
  baseArgv: string[],
  timeoutMs: number,
): string | null {
  const variants: string[][] = [
    [...baseArgv, "--help"],
    [...baseArgv, "-h"],
    [...baseArgv, "help"],
  ];
  for (const argv of variants) {
    const result = spawnSyncSafe(binary, argv, timeoutMs);
    if (result === null) continue;
    const text = mergeOutput(result.stdout, result.stderr);
    if (text.length > 0) return text;
  }
  return null;
}

function spawnSyncSafe(
  binary: string,
  argv: string[],
  timeoutMs: number,
): { stdout: string; stderr: string; code: number | null } | null {
  try {
    const child = spawnSync(binary, argv, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_HELP_BYTES,
      windowsHide: true,
      shell: false,
    });
    if (child.error && child.status === null && !child.stdout && !child.stderr) {
      return null;
    }
    return {
      stdout: typeof child.stdout === "string" ? child.stdout : "",
      stderr: typeof child.stderr === "string" ? child.stderr : "",
      code: child.status,
    };
  } catch {
    return null;
  }
}

function sanitizeToolPart(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toolNameFor(binary: string, path: string[]): string {
  const base = sanitizeToolPart(binary.split(/[/\\]/).pop() ?? binary);
  if (path.length === 0) return `cli_${base}`;
  return `cli_${base}_${path.map(sanitizeToolPart).join("_")}`;
}

function flagPropertyName(long?: string, short?: string, positionalLabel?: string): string {
  if (positionalLabel) {
    const inner = positionalLabel.replace(/^[[\]<]+|[\]>]+$/g, "");
    const cleaned = sanitizeToolPart(inner);
    if (cleaned) return cleaned;
  }
  if (long) return sanitizeToolPart(long.replace(/^--/, "").replace(/^no-/, "no_"));
  if (short) return `flag_${short}`;
  return "arg";
}

function parseEnumFromDescription(desc: string): string[] | undefined {
  const paren = desc.match(/\(([^)]+)\)/);
  if (!paren) return undefined;
  const inner = paren[1];
  if (/^default\s*:/i.test(inner)) return undefined;
  if (!inner.includes("|") && !/^(yes|no|true|false)$/i.test(inner)) {
    if (/^[a-z0-9_-]+$/i.test(inner.trim())) return undefined;
  }
  const parts = inner.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  return parts;
}

function parseDefaultFromText(text: string): string | undefined {
  const m = text.match(/\[default[:\s]+([^\]]+)\]/i) ?? text.match(/\(default[:\s]+([^)]+)\)/i);
  return m?.[1]?.trim();
}

const FLAG_LINE_RE =
  /^\s*(?:(-[A-Za-z])\s*,\s*)?(--(?:\[no-\])?[\w-]+)(?:\s+([A-Z][\w-]*))?(?:\s+(\[[\w.-]+\]|<[^>]+>|\S+))?\s*(.*)$/;

const USAGE_POSITIONAL_RE = /<?([\w.-]+)>?|\[([\w.-]+)\]/g;

export function parseHelpText(help: string): ParsedHelp {
  const lines = help.split(/\r?\n/);
  const subcommands: string[] = [];
  const flags: ParsedCliFlag[] = [];
  const positionals: ParsedCliFlag[] = [];
  let summary: string | undefined;
  let inCommands = false;
  const seenSub = new Set<string>();
  const seenFlag = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!summary && trimmed.length > 0 && !/^usage:/i.test(trimmed) && !/^options?:/i.test(trimmed)) {
      summary = trimmed;
    }

    if (/^(sub)?commands?:/i.test(trimmed) || /^available commands/i.test(trimmed)) {
      inCommands = true;
      continue;
    }
    if (inCommands) {
      if (trimmed === "" || /^options?:/i.test(trimmed) || /^flags?:/i.test(trimmed) || /^arguments?:/i.test(trimmed)) {
        inCommands = false;
      } else {
        const cmdMatch = line.match(/^\s{2,}([\w:@.-]+)\s{2,}/) ?? line.match(/^\s{2,}([\w:@.-]+)\s+/);
        if (cmdMatch) {
          const name = cmdMatch[1];
          if (name && !seenSub.has(name) && !/^-/.test(name)) {
            seenSub.add(name);
            subcommands.push(name);
          }
          continue;
        }
      }
    }

    const flagMatch = FLAG_LINE_RE.exec(line);
    if (flagMatch) {
      const short = flagMatch[1]?.slice(1);
      let longRaw = flagMatch[2];
      const valueKind = flagMatch[4];
      const rest = (flagMatch[5] ?? "").trim();
      const negatable = longRaw.includes("[no-]");
      longRaw = longRaw.replace(/\[no-\]/, "no-");
      const long = longRaw.startsWith("--") ? longRaw.slice(2) : longRaw;
      const takesValue =
        Boolean(valueKind) &&
        (valueKind.startsWith("<") || valueKind.startsWith("[") || /^[A-Z]/.test(valueKind));
      const name = flagPropertyName(longRaw, short);
      if (seenFlag.has(name)) continue;
      seenFlag.add(name);
      const enumValues = parseEnumFromDescription(rest);
      const defaultValue = parseDefaultFromText(rest) ?? parseDefaultFromText(line);
      flags.push({
        name,
        long: long.replace(/^no-/, ""),
        short,
        takesValue,
        negatable,
        description: rest || undefined,
        defaultValue,
        enumValues,
      });
      continue;
    }

    if (/^usage:/i.test(trimmed)) {
      const usageBody = trimmed.replace(/^usage:\s*/i, "");
      const tokens = usageBody.split(/\s+/);
      let pastBinary = false;
      for (const tok of tokens) {
        if (!pastBinary) {
          if (!/^[\w.-]+$/.test(tok) && !tok.includes("/")) continue;
          pastBinary = true;
          continue;
        }
        if (/^(options?|flags?|arguments?|commands?|\[options\]|\[flags\])$/i.test(tok)) break;
        if (tok.startsWith("-")) continue;
        let optional = false;
        let label = tok;
        if (label.startsWith("[") && label.endsWith("]")) {
          optional = true;
          label = label.slice(1, -1);
        }
        if (label.startsWith("<") && label.endsWith(">")) {
          label = label.slice(1, -1);
        }
        const pname = flagPropertyName(undefined, undefined, label);
        if (seenFlag.has(pname)) continue;
        seenFlag.add(pname);
        positionals.push({
          name: pname,
          takesValue: true,
          positional: true,
          optional,
          description: `Positional: ${label}`,
        });
      }
    }
  }

  if (positionals.length === 0) {
    const usageLine = lines.find((l) => /^usage:/i.test(l.trim()));
    if (usageLine) {
      USAGE_POSITIONAL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = USAGE_POSITIONAL_RE.exec(usageLine)) !== null) {
        const required = m[1];
        const optional = m[2];
        const label = required ?? optional;
        if (!label || /^(options?|flags?)$/i.test(label)) continue;
        const optionalPos = Boolean(optional);
        const pname = flagPropertyName(undefined, undefined, label);
        if (seenFlag.has(pname)) continue;
        seenFlag.add(pname);
        positionals.push({
          name: pname,
          takesValue: true,
          positional: true,
          optional: optionalPos,
          description: `Positional: ${label}`,
        });
      }
    }
  }

  return { subcommands, flags, positionals, summary };
}

function buildInputSchema(parsed: ParsedHelp): JsonSchema {
  const properties: Record<string, { type?: string; description?: string; enum?: string[]; default?: string }> =
    {};
  const required: string[] = [];

  for (const f of [...parsed.flags, ...parsed.positionals]) {
    const prop: { type?: string; description?: string; enum?: string[]; default?: string } = {
      description: f.description,
    };
    if (f.enumValues?.length) {
      prop.enum = f.enumValues;
      prop.type = "string";
    } else if (f.takesValue && !f.negatable) {
      prop.type = "string";
    } else {
      prop.type = "boolean";
    }
    if (f.defaultValue !== undefined) prop.default = f.defaultValue;
    properties[f.name] = prop;
    if (f.positional && !f.optional) required.push(f.name);
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

function suggestsMutating(path: string[], helpText: string, summary?: string): boolean {
  const blob = `${path.join(" ")} ${summary ?? ""} ${helpText}`.slice(0, 8000);
  return MUTATE_RE.test(blob);
}

function buildArgv(
  binary: string,
  path: string[],
  parsed: ParsedHelp,
  args: Record<string, unknown>,
): string[] {
  const argv: string[] = [...path];
  const positionalValues: string[] = [];

  for (const f of parsed.positionals) {
    const v = args[f.name];
    if (v === undefined || v === null) continue;
    positionalValues.push(String(v));
  }

  for (const f of parsed.flags) {
    if (f.positional) continue;
    const v = args[f.name];
    if (v === undefined || v === null) continue;

    if (f.takesValue && !f.negatable) {
      const long = f.long;
      if (long) argv.push(`--${long}`, String(v));
      else if (f.short) argv.push(`-${f.short}`, String(v));
      continue;
    }

    const truthy = v === true || v === "true" || v === 1;
    const long = f.long ?? f.short;
    if (!long) continue;
    if (f.negatable) {
      if (truthy) argv.push(`--${long}`);
      else argv.push(`--no-${long}`);
    } else if (truthy) {
      if (f.short) argv.push(`-${f.short}`);
      else argv.push(`--${long}`);
    }
  }

  argv.push(...positionalValues);
  return argv;
}

function runBinaryAsync(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_HELP_BYTES) child.kill("SIGTERM");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_HELP_BYTES) child.kill("SIGTERM");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

type CrawlNode = {
  path: string[];
  help: string;
  parsed: ParsedHelp;
};

function crawlNodes(
  binary: string,
  depth: number,
  timeoutMs: number,
): CrawlNode[] {
  const nodes: CrawlNode[] = [];
  const queue: { path: string[]; level: number }[] = [{ path: [], level: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { path, level } = queue.shift()!;
    const key = path.join("\0");
    if (visited.has(key)) continue;
    visited.add(key);

    const help = runHelpSync(binary, path, timeoutMs);
    if (!help) continue;

    const parsed = parseHelpText(help);
    nodes.push({ path, help, parsed });

    if (level >= depth) continue;
    for (const sub of parsed.subcommands) {
      queue.push({ path: [...path, sub], level: level + 1 });
    }
  }

  return nodes;
}

function makeHandler(
  binary: string,
  path: string[],
  parsed: ParsedHelp,
  timeoutMs: number,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const argv = buildArgv(binary, path, parsed, args);
    const { stdout, stderr, code } = await runBinaryAsync(binary, argv, timeoutMs);
    return {
      argv: [binary, ...argv],
      exitCode: code,
      stdout,
      stderr,
    };
  };
}

function makeTool(
  binary: string,
  node: CrawlNode,
): RepomcpTool {
  const { path, parsed, help } = node;
  const name = toolNameFor(binary, path);
  const pathLabel = path.length > 0 ? path.join(" ") : binary;
  const descSource = parsed.summary ?? `Run ${pathLabel}`;
  const description =
    descSource.length > 500 ? `${descSource.slice(0, 497)}...` : descSource;
  const mutates = suggestsMutating(path, help, parsed.summary);

  return {
    name,
    description,
    inputSchema: buildInputSchema(parsed),
    mutates,
    annotations: {
      readOnlyHint: !mutates,
      destructiveHint: mutates,
      idempotentHint: !mutates,
      openWorldHint: true,
    },
  };
}

export async function crawlCliBinary(
  binary: string,
  opts?: { depth?: number; timeoutMs?: number },
): Promise<AdapterDiscovery> {
  const depth = opts?.depth ?? DEFAULT_DEPTH;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolvedBinary = resolveCliBinary(binary);

  const nodes = crawlNodes(resolvedBinary, depth, timeoutMs);
  if (nodes.length === 0) {
    return { tools: [], handlers: {} };
  }

  const tools: RepomcpTool[] = [];
  const handlers: Record<string, ToolHandler> = {};

  const toolNodes = nodes.filter(
    (n) => n.path.length > 0 || n.parsed.subcommands.length === 0,
  );

  for (const node of toolNodes) {
    const tool = makeTool(resolvedBinary, node);
    if (tools.some((t) => t.name === tool.name)) continue;
    tools.push(tool);
    handlers[tool.name] = makeHandler(resolvedBinary, node.path, node.parsed, timeoutMs);
  }

  if (tools.length === 0 && nodes[0]) {
    const root = nodes[0];
    const tool = makeTool(resolvedBinary, root);
    tools.push(tool);
    handlers[tool.name] = makeHandler(resolvedBinary, root.path, root.parsed, timeoutMs);
  }

  return { tools, handlers };
}
