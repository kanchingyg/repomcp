import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonSchema, RepomcpTool } from "../types.js";
import { emptyDiscovery, mergeDiscoveries, type AdapterDiscovery, type ToolHandler } from "./types.js";

export type TaskRunnerSpawnPlan = {
  command: string[];
  cwd: string;
};

const MUTATES_RE = /\b(deploy|publish|down)\b/i;

function sanitizeName(s: string): string {
  return s.replace(/[^a-z0-9_]/gi, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase();
}

function taskMutates(label: string): boolean {
  return MUTATES_RE.test(label);
}

function planHandler(cwd: string, base: string[]): ToolHandler {
  return () => ({ planned: true, command: [...base], cwd });
}

function planHandlerWithArgs(
  cwd: string,
  build: (args: Record<string, unknown>) => string[],
): ToolHandler {
  return (args) => ({ planned: true, command: build(args), cwd });
}

function makeTool(
  name: string,
  description: string,
  inputSchema: JsonSchema,
  mutates: boolean,
): RepomcpTool {
  return {
    name,
    description,
    inputSchema,
    mutates,
    annotations: {
      readOnlyHint: !mutates,
      destructiveHint: mutates,
      idempotentHint: !mutates,
      openWorldHint: false,
    },
  };
}

function firstExisting(repoRoot: string, names: string[]): string | null {
  for (const n of names) {
    const p = join(repoRoot, n);
    if (existsSync(p)) return p;
  }
  return null;
}

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

// ——— Makefile ———

type MakeTarget = { name: string; doc?: string };

function parseMakefile(text: string): MakeTarget[] {
  const byName = new Map<string, string | undefined>();
  let pendingDoc: string | undefined;
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("##")) {
      pendingDoc = trimmed.slice(2).trim();
      continue;
    }
    const targetMatch = line.match(/^([A-Za-z0-9_.][^:#=\s]*)\s*:(?![?=])/);
    if (targetMatch) {
      const name = targetMatch[1];
      if (name.startsWith(".") && name !== ".DEFAULT_GOAL") {
        pendingDoc = undefined;
        continue;
      }
      let doc = pendingDoc;
      const inline = line.match(/##\s*(.+)$/);
      if (inline) doc = inline[1].trim();
      if (!byName.has(name)) byName.set(name, doc);
      pendingDoc = undefined;
      continue;
    }
    if (trimmed && !trimmed.startsWith("#") && !line.startsWith("\t")) {
      pendingDoc = undefined;
    }
  }

  return [...byName.entries()].map(([name, doc]) => ({ name, doc }));
}

function discoverMakefile(repoRoot: string): AdapterDiscovery {
  const path = firstExisting(repoRoot, ["Makefile", "makefile", "GNUmakefile"]);
  if (!path) return emptyDiscovery();

  const targets = parseMakefile(readUtf8(path));
  const out = emptyDiscovery();

  for (const { name, doc } of targets) {
    const toolName = `make_${sanitizeName(name)}`;
    const description = doc?.length
      ? `make ${name}: ${doc}`
      : `Run Makefile target ${name}`;
    out.tools.push(
      makeTool(
        toolName,
        description.length > 500 ? `${description.slice(0, 497)}...` : description,
        { type: "object", properties: {}, additionalProperties: false },
        taskMutates(name),
      ),
    );
    out.handlers[toolName] = planHandler(repoRoot, ["make", name]);
  }
  return out;
}

// ——— Justfile ———

type JustParam = { name: string; default?: string; variadic?: boolean };

type JustRecipe = { name: string; params: JustParam[] };

function parseJustParam(token: string): JustParam | null {
  const t = token.trim();
  if (!t) return null;
  if (t.startsWith("+")) {
    return { name: t.slice(1), variadic: true };
  }
  const eq = t.match(/^([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))$/);
  if (eq) {
    const def = eq[2] ?? eq[3] ?? eq[4];
    return { name: eq[1], default: def };
  }
  if (/^[A-Za-z_][\w-]*$/.test(t)) {
    return { name: t };
  }
  return null;
}

function parseJustfile(text: string): JustRecipe[] {
  const recipes: JustRecipe[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("\t") || line.startsWith(" ")) continue;
    const m = line.match(/^([a-zA-Z_][\w-]*)(?:\s+([^:#]+))?:\s*$/);
    if (!m) continue;
    const name = m[1];
    const paramPart = m[2]?.trim() ?? "";
    const params: JustParam[] = [];
    if (paramPart) {
      for (const token of paramPart.split(/\s+/)) {
        const p = parseJustParam(token);
        if (p) params.push(p);
      }
    }
    recipes.push({ name, params });
  }
  return recipes;
}

function discoverJustfile(repoRoot: string): AdapterDiscovery {
  const path = firstExisting(repoRoot, ["justfile", "Justfile"]);
  if (!path) return emptyDiscovery();

  const recipes = parseJustfile(readUtf8(path));
  const out = emptyDiscovery();

  for (const recipe of recipes) {
    const toolName = `just_${sanitizeName(recipe.name)}`;
    const properties: Record<string, { type: string; description?: string; default?: string }> = {};
    const required: string[] = [];

    for (const p of recipe.params) {
      if (p.variadic) {
        properties[p.name] = {
          type: "array",
          description: `Variadic argument ${p.name}`,
        };
        continue;
      }
      properties[p.name] = {
        type: "string",
        description: p.default ? `Default: ${p.default}` : undefined,
        ...(p.default !== undefined ? { default: p.default } : {}),
      };
      if (p.default === undefined) required.push(p.name);
    }

    const description = `Run just recipe ${recipe.name}`;
    out.tools.push(
      makeTool(
        toolName,
        description,
        {
          type: "object",
          properties,
          required: required.length > 0 ? required : undefined,
          additionalProperties: false,
        },
        taskMutates(recipe.name),
      ),
    );

    out.handlers[toolName] = planHandlerWithArgs(repoRoot, (args) => {
      const argv: string[] = ["just", recipe.name];
      for (const p of recipe.params) {
        if (p.variadic) {
          const raw = args[p.name];
          if (Array.isArray(raw)) {
            for (const v of raw) argv.push(String(v));
          } else if (raw !== undefined && raw !== "") {
            argv.push(String(raw));
          }
          continue;
        }
        const v = args[p.name];
        if (v !== undefined && v !== "") {
          argv.push(String(v));
        } else if (p.default !== undefined) {
          argv.push(p.default);
        }
      }
      return argv;
    });
  }
  return out;
}

// ——— Minimal YAML (maps + scalars) ———

function parseYamlScalar(raw: string): string | number | boolean {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseYamlShallow(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: { indent: number; map: Record<string, unknown> }[] = [
    { indent: -1, map: root },
  ];

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.search(/\S/);
    if (indent < 0) continue;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].map;
    const content = line.slice(indent).trim();
    const kv = content.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1].trim();
    const rest = kv[2].trim();

    if (rest === "" || rest === "|" || rest === ">") {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, map: child });
    } else {
      parent[key] = parseYamlScalar(rest);
    }
  }
  return root;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

// ——— Taskfile.yml ———

function discoverTaskfile(repoRoot: string): AdapterDiscovery {
  const path = firstExisting(repoRoot, [
    "Taskfile.yml",
    "Taskfile.yaml",
    "taskfile.yml",
    "taskfile.yaml",
    ".taskfile.yml",
  ]);
  if (!path) return emptyDiscovery();

  const doc = parseYamlShallow(readUtf8(path));
  const tasks = asRecord(doc.tasks);
  if (!tasks) return emptyDiscovery();

  const out = emptyDiscovery();
  for (const [name, val] of Object.entries(tasks)) {
    if (name.startsWith("_")) continue;
    let desc: string | undefined;
    const taskObj = asRecord(val);
    if (taskObj?.desc !== undefined) desc = String(taskObj.desc);

    const toolName = `task_${sanitizeName(name)}`;
    const description = desc
      ? `task ${name}: ${desc}`
      : `Run Taskfile task ${name}`;
    out.tools.push(
      makeTool(
        toolName,
        description.length > 500 ? `${description.slice(0, 497)}...` : description,
        { type: "object", properties: {}, additionalProperties: false },
        taskMutates(name),
      ),
    );
    out.handlers[toolName] = planHandler(repoRoot, ["task", name]);
  }
  return out;
}

// ——— package.json scripts ———

function detectPackageRunner(repoRoot: string): "npm" | "pnpm" | "bun" {
  if (existsSync(join(repoRoot, "bun.lockb")) || existsSync(join(repoRoot, "bun.lock"))) {
    return "bun";
  }
  if (
    existsSync(join(repoRoot, "pnpm-lock.yaml")) ||
    existsSync(join(repoRoot, "pnpm-lock.yml"))
  ) {
    return "pnpm";
  }
  return "npm";
}

function scriptArgv(runner: "npm" | "pnpm" | "bun", script: string): string[] {
  switch (runner) {
    case "bun":
      return ["bun", "run", script];
    case "pnpm":
      return ["pnpm", "run", script];
    default:
      return ["npm", "run", script];
  }
}

function discoverPackageScripts(repoRoot: string): AdapterDiscovery {
  const path = join(repoRoot, "package.json");
  if (!existsSync(path)) return emptyDiscovery();

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readUtf8(path)) as { scripts?: Record<string, string> };
  } catch {
    return emptyDiscovery();
  }
  if (!pkg.scripts || typeof pkg.scripts !== "object") return emptyDiscovery();

  const runner = detectPackageRunner(repoRoot);
  const out = emptyDiscovery();

  for (const script of Object.keys(pkg.scripts)) {
    const toolName = `npm_script_${sanitizeName(script)}`;
    out.tools.push(
      makeTool(
        toolName,
        `Run ${runner} script ${script}`,
        { type: "object", properties: {}, additionalProperties: false },
        taskMutates(script),
      ),
    );
    const base = scriptArgv(runner, script);
    out.handlers[toolName] = planHandler(repoRoot, base);
  }
  return out;
}

// ——— TOML (sections + key=value) ———

function parseTomlSections(text: string): Map<string, Record<string, string>> {
  const tables = new Map<string, Record<string, string>>();
  let current = "";

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(/^\[([^\]]+)\]/);
    if (section) {
      current = section[1];
      if (!tables.has(current)) tables.set(current, {});
      continue;
    }
    const kv = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv || !current) continue;
    let val = kv[2].trim();
    const inlineTable = val.match(/^\{\s*cmd\s*=\s*"([^"]*)"/);
    if (inlineTable) {
      val = inlineTable[1];
    } else if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    tables.get(current)![kv[1]] = val;
  }
  return tables;
}

function parseCargoBins(text: string): string[] {
  const bins: string[] = [];
  const lines = text.split(/\r?\n/);
  let inBin = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "[[bin]]") {
      inBin = true;
      continue;
    }
    if (trimmed.startsWith("[")) {
      inBin = false;
      continue;
    }
    if (inBin) {
      const m = trimmed.match(/^name\s*=\s*"([^"]+)"/);
      if (m) bins.push(m[1]);
    }
  }
  return bins;
}

function discoverPyproject(repoRoot: string): AdapterDiscovery {
  const path = join(repoRoot, "pyproject.toml");
  if (!existsSync(path)) return emptyDiscovery();

  const tables = parseTomlSections(readUtf8(path));
  const out = emptyDiscovery();

  const scripts = tables.get("project.scripts");
  if (scripts) {
    for (const name of Object.keys(scripts)) {
      const toolName = `py_script_${sanitizeName(name)}`;
      out.tools.push(
        makeTool(
          toolName,
          `Run Python console script ${name} (uv run)`,
          { type: "object", properties: {}, additionalProperties: false },
          taskMutates(name),
        ),
      );
      out.handlers[toolName] = planHandler(repoRoot, ["uv", "run", name]);
    }
  }

  const poe = tables.get("tool.poe.tasks");
  if (poe) {
    for (const name of Object.keys(poe)) {
      const toolName = `poe_${sanitizeName(name)}`;
      out.tools.push(
        makeTool(
          toolName,
          `Run poe task ${name}`,
          { type: "object", properties: {}, additionalProperties: false },
          taskMutates(name),
        ),
      );
      out.handlers[toolName] = planHandler(repoRoot, ["poe", name]);
    }
  }

  return out;
}

function discoverCargo(repoRoot: string): AdapterDiscovery {
  const path = join(repoRoot, "Cargo.toml");
  if (!existsSync(path)) return emptyDiscovery();

  const text = readUtf8(path);
  const bins = parseCargoBins(text);
  const out = emptyDiscovery();

  const checkTool = "cargo_check";
  out.tools.push(
    makeTool(
      checkTool,
      "Run cargo check",
      { type: "object", properties: {}, additionalProperties: false },
      false,
    ),
  );
  out.handlers[checkTool] = planHandler(repoRoot, ["cargo", "check"]);

  const testTool = "cargo_test";
  out.tools.push(
    makeTool(
      testTool,
      "Run cargo test",
      { type: "object", properties: {}, additionalProperties: false },
      false,
    ),
  );
  out.handlers[testTool] = planHandler(repoRoot, ["cargo", "test"]);

  for (const bin of bins) {
    const toolName = `cargo_run_${sanitizeName(bin)}`;
    out.tools.push(
      makeTool(
        toolName,
        `Run cargo bin ${bin}`,
        { type: "object", properties: {}, additionalProperties: false },
        taskMutates(bin),
      ),
    );
    out.handlers[toolName] = planHandler(repoRoot, ["cargo", "run", "--bin", bin]);
  }

  return out;
}

// ——— docker-compose ———

function discoverDockerCompose(repoRoot: string): AdapterDiscovery {
  const path = firstExisting(repoRoot, [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ]);
  if (!path) return emptyDiscovery();

  const doc = parseYamlShallow(readUtf8(path));
  const services = asRecord(doc.services);
  if (!services) return emptyDiscovery();

  const serviceNames = Object.keys(services).filter((s) => !s.startsWith("_"));
  const out = emptyDiscovery();

  const downTool = "compose_down";
  out.tools.push(
    makeTool(
      downTool,
      "Stop and remove docker compose stack (docker compose down)",
      { type: "object", properties: {}, additionalProperties: false },
      true,
    ),
  );
  out.handlers[downTool] = planHandler(repoRoot, ["docker", "compose", "down"]);

  for (const service of serviceNames) {
    const upName = `compose_up_${sanitizeName(service)}`;
    out.tools.push(
      makeTool(
        upName,
        `Start docker compose service ${service} (detached)`,
        { type: "object", properties: {}, additionalProperties: false },
        taskMutates(service),
      ),
    );
    out.handlers[upName] = planHandler(repoRoot, [
      "docker",
      "compose",
      "up",
      "-d",
      service,
    ]);

    const logsName = `compose_logs_${sanitizeName(service)}`;
    out.tools.push(
      makeTool(
        logsName,
        `Tail logs for docker compose service ${service}`,
        {
          type: "object",
          properties: {
            follow: {
              type: "boolean",
              description: "Follow log output (-f)",
            },
          },
          additionalProperties: false,
        },
        false,
      ),
    );
    out.handlers[logsName] = planHandlerWithArgs(repoRoot, (args) => {
      const argv = ["docker", "compose", "logs", service];
      if (args.follow === true) argv.push("-f");
      return argv;
    });
  }

  return out;
}

/** Scan repo task runners and emit spawn-ready MCP tools (§1B item 4). */
export function discoverTaskRunners(repoRoot: string): AdapterDiscovery {
  return mergeDiscoveries(
    discoverMakefile(repoRoot),
    discoverJustfile(repoRoot),
    discoverTaskfile(repoRoot),
    discoverPackageScripts(repoRoot),
    discoverPyproject(repoRoot),
    discoverCargo(repoRoot),
    discoverDockerCompose(repoRoot),
  );
}
