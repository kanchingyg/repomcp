import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

import type { RepomcpTool } from "../types.js";
import type { AdapterDiscovery, ToolHandler } from "./types.js";

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;
const MAX_DOC_CHARS = 48_000;
const SNIPPET_RADIUS = 120;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".next",
  "coverage",
  ".turbo",
]);

const EXPORT_FN_RE =
  /export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g;
const EXPORT_CONST_FN_RE =
  /export\s+const\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;

export type Bm25Document = {
  id: string;
  path: string;
  kind: "doc" | "symbol";
  title: string;
  text: string;
};

export type Bm25Index = {
  k1: number;
  b: number;
  documents: Bm25Document[];
  docLengths: number[];
  avgDocLength: number;
  /** doc index → term → term frequency in that doc */
  termFreqs: Map<number, Map<string, number>>;
  /** term → document frequency */
  docFreqs: Map<string, number>;
};

export type Bm25Hit = {
  score: number;
  id: string;
  path: string;
  kind: "doc" | "symbol";
  title: string;
  snippet: string;
};

export type RepoSymbol = {
  name: string;
  file: string;
  kind: "function";
  line: number;
};

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  let start = -1;
  for (let i = 0; i <= lower.length; i++) {
    const ch = lower[i] ?? " ";
    const word =
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "_";
    if (word && start < 0) {
      start = i;
    } else if (!word && start >= 0) {
      const t = lower.slice(start, i);
      if (t.length >= 2) tokens.push(t);
      start = -1;
    }
  }
  return tokens;
}

function termFreqMap(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) {
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

export function buildBm25Index(
  documents: Bm25Document[],
  opts?: { k1?: number; b?: number },
): Bm25Index {
  const k1 = opts?.k1 ?? DEFAULT_K1;
  const b = opts?.b ?? DEFAULT_B;
  const termFreqs = new Map<number, Map<string, number>>();
  const docFreqs = new Map<string, number>();
  const docLengths: number[] = [];

  for (let i = 0; i < documents.length; i++) {
    const tokens = tokenize(documents[i].text);
    docLengths.push(tokens.length);
    const tf = termFreqMap(tokens);
    termFreqs.set(i, tf);
    for (const term of tf.keys()) {
      docFreqs.set(term, (docFreqs.get(term) ?? 0) + 1);
    }
  }

  const totalLen = docLengths.reduce((a, n) => a + n, 0);
  const avgDocLength =
    documents.length === 0 ? 0 : totalLen / documents.length;

  return {
    k1,
    b,
    documents,
    docLengths,
    avgDocLength,
    termFreqs,
    docFreqs,
  };
}

function idf(index: Bm25Index, term: string): number {
  const df = index.docFreqs.get(term) ?? 0;
  const n = index.documents.length;
  if (n === 0) return 0;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

export function bm25Search(
  index: Bm25Index,
  query: string,
  limit = 10,
): Bm25Hit[] {
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0 || index.documents.length === 0) {
    return [];
  }

  const scores: { idx: number; score: number }[] = [];

  for (let di = 0; di < index.documents.length; di++) {
    const dl = index.docLengths[di] ?? 0;
    const tfMap = index.termFreqs.get(di);
    if (!tfMap) continue;

    let score = 0;
    for (const term of qTerms) {
      const freq = tfMap.get(term) ?? 0;
      if (freq === 0) continue;
      const idfVal = idf(index, term);
      const denom =
        freq +
        index.k1 *
          (1 - index.b + index.b * (dl / (index.avgDocLength || 1)));
      score += idfVal * ((freq * (index.k1 + 1)) / denom);
    }
    if (score > 0) scores.push({ idx: di, score });
  }

  scores.sort((a, b) => b.score - a.score);
  const top = scores.slice(0, Math.max(1, limit));

  return top.map(({ idx, score }) => {
    const doc = index.documents[idx];
    return {
      score,
      id: doc.id,
      path: doc.path,
      kind: doc.kind,
      title: doc.title,
      snippet: makeSnippet(doc.text, query),
    };
  });
}

function makeSnippet(text: string, query: string): string {
  const qTerms = tokenize(query);
  const lower = text.toLowerCase();
  let best = 0;
  for (const term of qTerms) {
    const pos = lower.indexOf(term);
    if (pos >= 0) {
      best = pos;
      break;
    }
  }
  const start = Math.max(0, best - SNIPPET_RADIUS);
  const end = Math.min(text.length, best + SNIPPET_RADIUS);
  let slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) slice = `…${slice}`;
  if (end < text.length) slice = `${slice}…`;
  return slice;
}

function normalizeRel(repoRoot: string, absPath: string): string {
  const rel = relative(repoRoot, absPath);
  return rel.split(sep).join("/");
}

function walkMarkdown(dir: string, max = 200): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const entries = readdirSync(dir);
  for (const name of entries) {
    if (out.length >= max) break;
    const p = join(dir, name);
    if (SKIP_DIRS.has(name)) continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkMarkdown(p, max - out.length));
    } else if (/\.md$/i.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function walkSourceFiles(dir: string, max = 400): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const entries = readdirSync(dir);
  for (const name of entries) {
    if (out.length >= max) break;
    const p = join(dir, name);
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkSourceFiles(p, max - out.length));
    } else if (/\.(ts|tsx|mts|cts)$/i.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function truncateDoc(text: string): string {
  if (text.length <= MAX_DOC_CHARS) return text;
  return `${text.slice(0, MAX_DOC_CHARS)}\n…[truncated]`;
}

function findExportLine(text: string, name: string): number {
  const lines = text.split(/\r?\n/);
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`),
    new RegExp(`export\\s+const\\s+${name}\\s*=`),
  ];
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((re) => re.test(lines[i]))) return i + 1;
  }
  return 1;
}

function extractFunctionSource(text: string, name: string): string {
  const fnRe = new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*`,
  );
  const constRe = new RegExp(
    `export\\s+const\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*`,
  );

  let match = fnRe.exec(text);
  let start = match?.index ?? -1;
  let isArrow = false;

  if (start < 0) {
    match = constRe.exec(text);
    start = match?.index ?? -1;
    isArrow = start >= 0;
  }

  if (start < 0) {
    const line = findExportLine(text, name);
    const lines = text.split(/\r?\n/);
    const slice = lines.slice(line - 1, line + 40);
    return slice.join("\n");
  }

  const bodyStart = text.indexOf(isArrow ? "=>" : "{", start);
  if (bodyStart < 0) return text.slice(start, start + 500);

  if (isArrow) {
    const afterArrow = text.slice(bodyStart + 2).trimStart();
    if (afterArrow.startsWith("{")) {
      return extractBalancedBlock(text, bodyStart + 2 + afterArrow.indexOf("{"));
    }
    const endLine = afterArrow.indexOf("\n");
    return text.slice(start, bodyStart + 2 + (endLine >= 0 ? endLine : afterArrow.length));
  }

  return extractBalancedBlock(text, bodyStart);
}

function extractBalancedBlock(text: string, braceIndex: number): string {
  if (text[braceIndex] !== "{") {
    return text.slice(braceIndex, braceIndex + 400);
  }
  let depth = 0;
  let inStr: "'" | '"' | "`" | null = null;
  let escape = false;
  for (let i = braceIndex; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(braceIndex, i + 1);
    }
  }
  return text.slice(braceIndex, Math.min(text.length, braceIndex + 2000));
}

function parseExportedFunctions(filePath: string, text: string): RepoSymbol[] {
  const symbols: RepoSymbol[] = [];
  const rel = filePath;
  let m: RegExpExecArray | null;

  EXPORT_FN_RE.lastIndex = 0;
  while ((m = EXPORT_FN_RE.exec(text)) !== null) {
    const name = m[1];
    symbols.push({
      name,
      file: rel,
      kind: "function",
      line: findExportLine(text, name),
    });
  }

  EXPORT_CONST_FN_RE.lastIndex = 0;
  while ((m = EXPORT_CONST_FN_RE.exec(text)) !== null) {
    const name = m[1];
    if (symbols.some((s) => s.name === name)) continue;
    symbols.push({
      name,
      file: rel,
      kind: "function",
      line: findExportLine(text, name),
    });
  }

  return symbols;
}

export type RepoDocsBundle = {
  index: Bm25Index;
  symbols: RepoSymbol[];
  symbolSources: Map<string, { file: string; source: string; line: number }>;
};

export function buildRepoDocsBundle(repoRoot: string): RepoDocsBundle {
  const documents: Bm25Document[] = [];
  const symbols: RepoSymbol[] = [];
  const symbolSources = new Map<
    string,
    { file: string; source: string; line: number }
  >();

  const readme = join(repoRoot, "README.md");
  if (existsSync(readme)) {
    const text = truncateDoc(readTextFile(readme));
    documents.push({
      id: "doc:README.md",
      path: "README.md",
      kind: "doc",
      title: "README",
      text,
    });
  }

  const skill = join(repoRoot, "SKILL.md");
  if (existsSync(skill)) {
    const text = truncateDoc(readTextFile(skill));
    documents.push({
      id: "doc:SKILL.md",
      path: "SKILL.md",
      kind: "doc",
      title: "SKILL",
      text,
    });
  }

  const docsDir = join(repoRoot, "docs");
  for (const abs of walkMarkdown(docsDir)) {
    const rel = normalizeRel(repoRoot, abs);
    const text = truncateDoc(readTextFile(abs));
    documents.push({
      id: `doc:${rel}`,
      path: rel,
      kind: "doc",
      title: rel,
      text,
    });
  }

  const srcDir = join(repoRoot, "src");
  const sourceFiles = existsSync(srcDir)
    ? walkSourceFiles(srcDir)
    : walkSourceFiles(repoRoot);

  for (const abs of sourceFiles) {
    const text = readTextFile(abs);
    if (!text) continue;
    const rel = normalizeRel(repoRoot, abs);
    const found = parseExportedFunctions(rel, text);
    for (const sym of found) {
      symbols.push(sym);
      const source = extractFunctionSource(text, sym.name);
      symbolSources.set(sym.name, {
        file: rel,
        source,
        line: sym.line,
      });
      const indexText = `${sym.name}\n${rel}\n${source}`;
      documents.push({
        id: `symbol:${sym.name}`,
        path: rel,
        kind: "symbol",
        title: sym.name,
        text: indexText,
      });
    }
  }

  symbols.sort((a, b) => a.name.localeCompare(b.name));

  return {
    index: buildBm25Index(documents),
    symbols,
    symbolSources,
  };
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const SEARCH_TOOL: RepomcpTool = {
  name: "search_repo_docs",
  description:
    "BM25-ranked search over README.md, docs/**/*.md, SKILL.md, and exported src symbols.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (keywords or phrase)." },
      limit: {
        type: "number",
        description: "Max hits to return (default 10).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  mutates: false,
  annotations: READ_ONLY_ANNOTATIONS,
};

const LIST_SYMBOLS_TOOL: RepomcpTool = {
  name: "list_repo_symbols",
  description: "List exported function symbols discovered under src/.",
  inputSchema: {
    type: "object",
    properties: {
      prefix: {
        type: "string",
        description: "Optional name prefix filter (case-sensitive).",
      },
    },
    additionalProperties: false,
  },
  mutates: false,
  annotations: READ_ONLY_ANNOTATIONS,
};

const READ_SYMBOL_TOOL: RepomcpTool = {
  name: "read_symbol_source",
  description: "Return source for an exported function symbol by name.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exported symbol name." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  mutates: false,
  annotations: READ_ONLY_ANNOTATIONS,
};

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function asOptionalLimit(value: unknown): number {
  if (value === undefined || value === null) return 10;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("limit must be a finite number");
  }
  return Math.min(50, Math.max(1, Math.floor(value)));
}

export function discoverDocsIndex(repoRoot: string): AdapterDiscovery {
  const bundle = buildRepoDocsBundle(repoRoot);

  const handlers: Record<string, ToolHandler> = {
    search_repo_docs: (args) => {
      const query = asString(args.query, "query");
      const limit = asOptionalLimit(args.limit);
      const hits = bm25Search(bundle.index, query, limit);
      return { query, hits };
    },
    list_repo_symbols: (args) => {
      const prefix =
        typeof args.prefix === "string" ? args.prefix : undefined;
      const list = prefix
        ? bundle.symbols.filter((s) => s.name.startsWith(prefix))
        : bundle.symbols;
      return { symbols: list, count: list.length };
    },
    read_symbol_source: (args) => {
      const name = asString(args.name, "name");
      const entry = bundle.symbolSources.get(name);
      if (!entry) {
        return {
          name,
          found: false,
          error: `Symbol not found: ${name}`,
        };
      }
      return {
        name,
        found: true,
        file: entry.file,
        line: entry.line,
        source: entry.source,
      };
    },
  };

  return {
    tools: [SEARCH_TOOL, LIST_SYMBOLS_TOOL, READ_SYMBOL_TOOL],
    handlers,
  };
}
