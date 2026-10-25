import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import type { RepomcpTool } from "../types.js";
import { resolvePathUnderRepoRoot } from "../path-containment.js";
import { emptyDiscovery, type AdapterDiscovery, type ToolHandler } from "./types.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
]);

const MAX_SCAN_FILES = 800;

const MUTATING_SQL_RE =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|VACUUM|REINDEX)\b/i;

const READ_ONLY_PRAGMA_RE =
  /^\s*PRAGMA\s+(?:table_info|database_list|index_info|index_list|index_xinfo|compile_options|encoding|freelist_count|integrity_check|quick_check|foreign_key_list|foreign_key_check|page_count|page_size|schema_version)\s*(?:\(|;|$)/i;

const WRITE_PRAGMA_RE = /^\s*PRAGMA\s+/i;

type DataInventory = {
  sqlite: string[];
  sql: string[];
  prisma: string[];
  drizzle: string[];
  csv: string[];
  jsonl: string[];
};

type SqliteStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
};

type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type SqliteOpenResult =
  | { ok: true; db: SqliteDatabase }
  | { ok: false; message: string };

function walkDataFiles(repoRoot: string): DataInventory {
  const inv: DataInventory = {
    sqlite: [],
    sql: [],
    prisma: [],
    drizzle: [],
    csv: [],
    jsonl: [],
  };
  let scanned = 0;

  const visit = (dir: string): void => {
    if (scanned >= MAX_SCAN_FILES || !existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (scanned >= MAX_SCAN_FILES) break;
      const abs = join(dir, name);
      if (name.startsWith(".") && name !== ".") {
        const stDot = safeStat(abs);
        if (stDot?.isDirectory()) continue;
      }
      const st = safeStat(abs);
      if (!st) continue;
      if (st.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue;
        visit(abs);
        continue;
      }
      if (!st.isFile()) continue;
      scanned += 1;
      const rel = toRepoRel(repoRoot, abs);
      const lower = name.toLowerCase();
      if (/\.(db|sqlite|sqlite3)$/.test(lower)) {
        inv.sqlite.push(rel);
      } else if (lower.endsWith(".sql")) {
        inv.sql.push(rel);
      } else if (lower === "schema.prisma" || lower.endsWith(".prisma")) {
        inv.prisma.push(rel);
      } else if (lower.endsWith(".csv")) {
        inv.csv.push(rel);
      } else if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
        inv.jsonl.push(rel);
      } else if (/schema.*\.(ts|mts|cts|js|mjs|cjs)$/.test(lower)) {
        if (looksLikeDrizzleSchema(abs)) inv.drizzle.push(rel);
      }
    }
  };

  visit(repoRoot);
  return inv;
}

function safeStat(p: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function toRepoRel(repoRoot: string, abs: string): string {
  const rel = relative(repoRoot, abs);
  return rel.split("\\").join("/");
}

function looksLikeDrizzleSchema(absPath: string): boolean {
  try {
    const head = readFileSync(absPath, "utf8").slice(0, 12_000);
    return (
      /from\s+['"]drizzle-orm/.test(head) &&
      /\b(sqliteTable|pgTable|mysqlTable)\s*\(/.test(head)
    );
  } catch {
    return false;
  }
}

function resolveRepoPath(repoRoot: string, input: string): string {
  try {
    return resolvePathUnderRepoRoot(repoRoot, input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("escapes repo root")) throw err;
    throw new Error(`File not found: ${input}`);
  }
}

function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length - 1 && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function isWritePragmaSql(sql: string): boolean {
  const trimmed = stripSqlComments(sql).trim();
  if (!WRITE_PRAGMA_RE.test(trimmed)) return false;
  if (READ_ONLY_PRAGMA_RE.test(trimmed)) return false;
  return true;
}

export function isMutatingSql(sql: string): boolean {
  const trimmed = stripSqlComments(sql).trim();
  if (!trimmed) return false;
  const withoutTrailing = trimmed.replace(/;+\s*$/, "");
  if (withoutTrailing.includes(";")) return true;
  if (isWritePragmaSql(withoutTrailing)) return true;
  return MUTATING_SQL_RE.test(withoutTrailing);
}

let sqliteModuleLoaded: { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabase } | null | undefined;

function loadSqliteModule(): typeof sqliteModuleLoaded {
  if (sqliteModuleLoaded !== undefined) return sqliteModuleLoaded;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("node:sqlite") as {
      DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabase;
    };
    if (mod?.DatabaseSync) {
      sqliteModuleLoaded = mod;
      return sqliteModuleLoaded;
    }
  } catch {
    // node:sqlite unavailable (Node < 22 or build without sqlite)
  }
  sqliteModuleLoaded = null;
  return null;
}

function openSqlite(absPath: string, allowWrite: boolean): SqliteOpenResult {
  const mod = loadSqliteModule();
  if (!mod) {
    return {
      ok: false,
      message:
        "node:sqlite is not available (requires Node 22+). Use schema from .sql or schema.prisma, or upgrade Node.",
    };
  }
  try {
    const db = new mod.DatabaseSync(absPath, { readOnly: !allowWrite });
    if (!allowWrite) {
      db.prepare("PRAGMA query_only=ON").get();
    }
    return { ok: true, db };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Failed to open SQLite database at ${absPath}: ${msg}`,
    };
  }
}

function openSqliteReadOnly(absPath: string): SqliteOpenResult {
  return openSqlite(absPath, false);
}

function sqliteSchema(db: SqliteDatabase): Record<string, { columns: { name: string; type: string; notnull: number; pk: number }[] }> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as { name: string }[];
  const out: Record<string, { columns: { name: string; type: string; notnull: number; pk: number }[] }> = {};
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${quoteSqlIdent(name)})`).all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    out[name] = { columns: cols };
  }
  return out;
}

function quoteSqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function parseCreateTablesFromSql(text: string): Record<string, { columns: string[] }> {
  const out: Record<string, { columns: string[] }> = {};
  const re =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`|(\w+))\s*\(([\s\S]*?)\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const table = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!table) continue;
    const body = m[5];
    const columns = body
      .split(",")
      .map((line) => line.trim())
      .filter((line) => line && !/^PRIMARY\s+KEY/i.test(line) && !/^CONSTRAINT\s/i.test(line) && !/^UNIQUE\s/i.test(line) && !/^FOREIGN\s+KEY/i.test(line) && !/^CHECK\s/i.test(line))
      .map((line) => line.split(/\s+/)[0]?.replace(/^["'`]|["'`]$/g, "") ?? "")
      .filter(Boolean);
    out[table] = { columns };
  }
  return out;
}

function parsePrismaModels(text: string): Record<string, { fields: string[] }> {
  const out: Record<string, { fields: string[] }> = {};
  const blocks = text.split(/\nmodel\s+/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const nameMatch = /^(\w+)\s*\{/.exec(block);
    if (!nameMatch) continue;
    const modelName = nameMatch[1];
    const body = block.slice(nameMatch[0].length);
    const end = body.indexOf("}");
    const inner = end >= 0 ? body.slice(0, end) : body;
    const fields: string[] = [];
    for (const line of inner.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;
      const field = /^(\w+)\s+/.exec(trimmed);
      if (field) fields.push(field[1]);
    }
    out[modelName] = { fields };
  }
  return out;
}

function parseDrizzleTables(text: string): Record<string, { columns: string[] }> {
  const out: Record<string, { columns: string[] }> = {};
  const tableRe =
    /\b(sqliteTable|pgTable|mysqlTable)\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{([\s\S]*?)\}\s*(?:,\s*\(|\))/g;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(text)) !== null) {
    const tableName = m[2];
    const body = m[3];
    const columns: string[] = [];
    const colRe = /^\s*(\w+)\s*:/gm;
    let cm: RegExpExecArray | null;
    while ((cm = colRe.exec(body)) !== null) {
      columns.push(cm[1]);
    }
    out[tableName] = { columns };
  }
  return out;
}

function classifyPath(inv: DataInventory, relPath: string): "sqlite" | "sql" | "prisma" | "drizzle" | "csv" | "jsonl" | null {
  if (inv.sqlite.includes(relPath)) return "sqlite";
  if (inv.sql.includes(relPath)) return "sql";
  if (inv.prisma.includes(relPath)) return "prisma";
  if (inv.drizzle.includes(relPath)) return "drizzle";
  if (inv.csv.includes(relPath)) return "csv";
  if (inv.jsonl.includes(relPath)) return "jsonl";
  const lower = relPath.toLowerCase();
  if (/\.(db|sqlite|sqlite3)$/.test(lower)) return "sqlite";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".prisma")) return "prisma";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  return null;
}

function schemaForFile(repoRoot: string, relPath: string, inv: DataInventory): unknown {
  const abs = resolveRepoPath(repoRoot, relPath);
  const kind = classifyPath(inv, relPath.replace(/\\/g, "/"));
  const text = readFileSync(abs, "utf8");

  switch (kind) {
    case "sqlite": {
      const opened = openSqliteReadOnly(abs);
      if (!opened.ok) {
        return {
          path: relPath,
          kind: "sqlite",
          error: opened.message,
          hint: "Schema may still be inferable from companion .sql or schema.prisma files.",
        };
      }
      try {
        return { path: relPath, kind: "sqlite", tables: sqliteSchema(opened.db) };
      } finally {
        opened.db.close();
      }
    }
    case "sql":
      return { path: relPath, kind: "sql", tables: parseCreateTablesFromSql(text) };
    case "prisma":
      return { path: relPath, kind: "prisma", models: parsePrismaModels(text) };
    case "drizzle":
      return { path: relPath, kind: "drizzle", tables: parseDrizzleTables(text) };
    default:
      return { path: relPath, error: "Unsupported schema path for db_schema" };
  }
}

function inventorySummary(inv: DataInventory): Record<string, string[]> {
  return {
    sqlite: inv.sqlite,
    sql: inv.sql,
    prisma: inv.prisma,
    drizzle: inv.drizzle,
    csv: inv.csv,
    jsonl: inv.jsonl,
  };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  return { headers, rows };
}

function sampleJsonl(absPath: string, limit: number): unknown[] {
  const text = readFileSync(absPath, "utf8");
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (out.length >= limit) break;
    out.push(JSON.parse(line));
  }
  return out;
}

function sampleCsv(absPath: string, limit: number): { headers: string[]; rows: string[][] } {
  const { headers, rows } = parseCsv(readFileSync(absPath, "utf8"));
  return { headers, rows: rows.slice(0, limit) };
}

function sampleSqliteTable(
  absPath: string,
  table: string,
  limit: number,
): { table: string; rows: unknown[] } | { error: string } {
  const opened = openSqliteReadOnly(absPath);
  if (!opened.ok) {
    return { error: opened.message };
  }
  try {
    const safeTable = table.replace(/"/g, '""');
    const rows = opened.db
      .prepare(`SELECT * FROM "${safeTable}" LIMIT ?`)
      .all(limit);
    return { table, rows };
  } finally {
    opened.db.close();
  }
}

function filterCsv(
  absPath: string,
  column: string,
  value: string,
  mode: "exact" | "contains",
  limit: number,
): { headers: string[]; rows: string[][] } {
  const { headers, rows } = parseCsv(readFileSync(absPath, "utf8"));
  const idx = headers.indexOf(column);
  if (idx < 0) {
    throw new Error(`Column not found: ${column}. Available: ${headers.join(", ")}`);
  }
  const filtered: string[][] = [];
  for (const row of rows) {
    const cell = row[idx] ?? "";
    const match =
      mode === "exact" ? cell === value : cell.toLowerCase().includes(value.toLowerCase());
    if (match) {
      filtered.push(row);
      if (filtered.length >= limit) break;
    }
  }
  return { headers, rows: filtered };
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`Missing or invalid string argument: ${field}`);
  }
  return v;
}

function asOptionalNumber(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("limit must be a non-negative number");
  }
  return Math.floor(n);
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const MUTATING_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function buildTools(inv: DataInventory, allowWrite: boolean): RepomcpTool[] {
  const hasSchema =
    inv.sqlite.length > 0 ||
    inv.sql.length > 0 ||
    inv.prisma.length > 0 ||
    inv.drizzle.length > 0;
  const hasSqlite = inv.sqlite.length > 0;
  const hasTabular = hasSqlite || inv.csv.length > 0 || inv.jsonl.length > 0;
  const hasCsv = inv.csv.length > 0;

  const tools: RepomcpTool[] = [];
  const summary = JSON.stringify(inventorySummary(inv));

  if (hasSchema) {
    tools.push({
      name: "db_schema",
      description: `Inspect database schema (SQLite, SQL, Prisma, Drizzle). Discovered: ${summary}`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repo-relative file path (.db, .sql, schema.prisma, drizzle schema). Omit to list discovered sources.",
          },
        },
        additionalProperties: false,
      },
      mutates: false,
      annotations: READ_ONLY_ANNOTATIONS,
    });
  }

  if (hasSqlite) {
    tools.push({
      name: "db_query_readonly",
      description: `Run SQL against a repo SQLite file${allowWrite ? " (writes allowed)" : " (read-only)"}. Discovered DBs: ${inv.sqlite.join(", ")}`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative .db/.sqlite path" },
          sql: { type: "string", description: "SQL query (SELECT / PRAGMA / WITH …)" },
        },
        required: ["path", "sql"],
        additionalProperties: false,
      },
      mutates: allowWrite,
      annotations: allowWrite ? MUTATING_ANNOTATIONS : READ_ONLY_ANNOTATIONS,
    });
  }

  if (hasTabular) {
    tools.push({
      name: "data_sample",
      description: `Sample rows from CSV, JSONL, or a SQLite table. Discovered: csv=${inv.csv.length}, jsonl=${inv.jsonl.length}, sqlite=${inv.sqlite.length}`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative data file path" },
          limit: { type: "number", description: "Max rows/lines (default 10)" },
          table: { type: "string", description: "SQLite table name (required for .db files)" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      mutates: false,
      annotations: READ_ONLY_ANNOTATIONS,
    });
  }

  if (hasCsv) {
    tools.push({
      name: "csv_filter",
      description: `Filter CSV rows by column value. Discovered CSVs: ${inv.csv.join(", ")}`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative .csv path" },
          column: { type: "string", description: "Header column name" },
          value: { type: "string", description: "Value to match" },
          mode: {
            type: "string",
            description: "exact (default) or contains",
          },
          limit: { type: "number", description: "Max matching rows (default 50)" },
        },
        required: ["path", "column", "value"],
        additionalProperties: false,
      },
      mutates: false,
      annotations: READ_ONLY_ANNOTATIONS,
    });
  }

  return tools;
}

function makeHandlers(
  repoRoot: string,
  inv: DataInventory,
  allowWrite: boolean,
): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};

  if (
    inv.sqlite.length > 0 ||
    inv.sql.length > 0 ||
    inv.prisma.length > 0 ||
    inv.drizzle.length > 0
  ) {
    handlers.db_schema = async (args) => {
      const pathArg = args.path;
      if (pathArg === undefined || pathArg === null || pathArg === "") {
        return { discovered: inventorySummary(inv) };
      }
      const rel = asString(pathArg, "path");
      return schemaForFile(repoRoot, rel, inv);
    };
  }

  if (inv.sqlite.length > 0) {
    handlers.db_query_readonly = async (args) => {
      const rel = asString(args.path, "path");
      const sql = asString(args.sql, "sql");
      if (isMutatingSql(sql) && !allowWrite) {
        return {
          error:
            "Mutating SQL blocked (INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/ATTACH/REPLACE/VACUUM/REINDEX or write PRAGMA). Pass --allow-write to permit writes.",
        };
      }
      const abs = resolveRepoPath(repoRoot, rel);
      const opened = openSqlite(abs, allowWrite);
      if (!opened.ok) {
        return { error: opened.message };
      }
      try {
        const stmt = opened.db.prepare(sql);
        const trimmed = stripSqlComments(sql).trim().toUpperCase();
        const readShape =
          trimmed.startsWith("SELECT") ||
          trimmed.startsWith("WITH") ||
          trimmed.startsWith("EXPLAIN") ||
          (trimmed.startsWith("PRAGMA") && !isWritePragmaSql(sql));
        if (readShape) {
          const rows = stmt.all();
          return { path: rel, rows };
        }
        if (allowWrite) {
          const info = stmt.get();
          return { path: rel, result: info, wrote: true };
        }
        return { error: "Only read-only SQL allowed without --allow-write." };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: msg };
      } finally {
        opened.db.close();
      }
    };
  }

  if (inv.sqlite.length > 0 || inv.csv.length > 0 || inv.jsonl.length > 0) {
    handlers.data_sample = async (args) => {
      const rel = asString(args.path, "path");
      const limit = asOptionalNumber(args.limit, 10);
      const abs = resolveRepoPath(repoRoot, rel);
      const norm = rel.replace(/\\/g, "/");
      const kind = classifyPath(inv, norm);

      if (kind === "csv" || norm.toLowerCase().endsWith(".csv")) {
        return { path: rel, ...sampleCsv(abs, limit) };
      }
      if (kind === "jsonl" || norm.toLowerCase().endsWith(".jsonl") || norm.toLowerCase().endsWith(".ndjson")) {
        return { path: rel, lines: sampleJsonl(abs, limit) };
      }
      if (kind === "sqlite" || /\.(db|sqlite|sqlite3)$/i.test(norm)) {
        const table = asString(args.table, "table");
        const sampled = sampleSqliteTable(abs, table, limit);
        return { path: rel, ...sampled };
      }
      return { error: `Unsupported data_sample path: ${rel}` };
    };
  }

  if (inv.csv.length > 0) {
    handlers.csv_filter = async (args) => {
      const rel = asString(args.path, "path");
      const column = asString(args.column, "column");
      const value = asString(args.value, "value");
      const modeRaw = args.mode;
      let mode: "exact" | "contains" = "exact";
      if (modeRaw === "contains") {
        mode = "contains";
      } else if (modeRaw !== undefined && modeRaw !== "exact") {
        throw new Error('mode must be "exact" or "contains"');
      }
      const limit = asOptionalNumber(args.limit, 50);
      const abs = resolveRepoPath(repoRoot, rel);
      return { path: rel, ...filterCsv(abs, column, value, mode, limit) };
    };
  }

  return handlers;
}

export function discoverDataSources(
  repoRoot: string,
  opts?: { allowWrite?: boolean },
): AdapterDiscovery {
  const root = resolve(repoRoot);
  if (!existsSync(root)) {
    return emptyDiscovery();
  }

  const inv = walkDataFiles(root);
  const total =
    inv.sqlite.length +
    inv.sql.length +
    inv.prisma.length +
    inv.drizzle.length +
    inv.csv.length +
    inv.jsonl.length;

  if (total === 0) {
    return emptyDiscovery();
  }

  const allowWrite = Boolean(opts?.allowWrite);
  const tools = buildTools(inv, allowWrite);
  const handlers = makeHandlers(root, inv, allowWrite);

  return { tools, handlers };
}
