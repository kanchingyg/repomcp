import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { emptyDiscovery, type AdapterDiscovery } from "./types.js";

export type ParsedRemoteTarget = {
  kind: "github" | "openapi-url" | "local";
  owner?: string;
  repo?: string;
  url?: string;
  path?: string;
};

export type RemoteResolveOptions = {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
};

export type ResolvedRemoteTarget = {
  localPath: string;
  kind: string;
};

const REMOTE_MARKER = ".repomcp-remote-target.json";
const GITHUB_OWNER_REPO_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "api.github.com", "codeload.github.com"]);

function isPrivateOrReservedIp(address: string): boolean {
  if (address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd")) {
    const first = parseInt(address.slice(0, 2), 16);
    if (first >= 0xfc && first <= 0xfd) return true;
  }
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    if (lower.startsWith("fe80:")) return true;
    return false;
  }
  const parts = address.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export async function assertSafeFetchUrl(
  urlString: string,
  opts?: { allowGitHubHosts?: boolean },
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }
  const host = url.hostname.toLowerCase();
  const allowGitHub = opts?.allowGitHubHosts ?? false;
  if (allowGitHub && GITHUB_HOSTS.has(host)) {
    return url;
  }
  if (url.protocol !== "https:") {
    throw new Error(`Only https URLs are allowed for remote fetch: ${urlString}`);
  }
  const results = await dnsLookup(host, { all: true });
  for (const entry of results) {
    if (isPrivateOrReservedIp(entry.address)) {
      throw new Error(`SSRF blocked: ${host} resolves to disallowed address ${entry.address}`);
    }
  }
  return url;
}

function defaultCacheDir(): string {
  return join(tmpdir(), "repomcp-remote-cache");
}

function cacheKey(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

function isGitHubOwnerRepoSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 100 &&
    GITHUB_OWNER_REPO_RE.test(segment)
  );
}

function parseGitHubPath(pathParts: string[]): { owner: string; repo: string } | null {
  if (pathParts.length < 2) return null;
  const owner = pathParts[0];
  const repo = pathParts[1].replace(/\.git$/i, "");
  if (!isGitHubOwnerRepoSegment(owner) || !isGitHubOwnerRepoSegment(repo)) {
    return null;
  }
  return { owner, repo };
}

export function parseRemoteTarget(input: string): ParsedRemoteTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    return { kind: "local", path: trimmed };
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("github:")) {
    const rest = trimmed.slice("github:".length).replace(/^\/+/, "");
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const owner = rest.slice(0, slash);
      const repo = rest.slice(slash + 1).replace(/\.git$/i, "").replace(/\/+$/, "");
      if (isGitHubOwnerRepoSegment(owner) && isGitHubOwnerRepoSegment(repo)) {
        return { kind: "github", owner, repo };
      }
    }
  }

  if (/^https:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname.toLowerCase();
      if (GITHUB_HOSTS.has(host) || host === "github.com" || host === "www.github.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        const gh = parseGitHubPath(parts);
        if (gh) {
          return { kind: "github", owner: gh.owner, repo: gh.repo };
        }
      }
      return { kind: "openapi-url", url: trimmed };
    } catch {
      return { kind: "local", path: trimmed };
    }
  }

  if (/^http:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname.toLowerCase();
      if (host === "github.com" || host === "www.github.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        const gh = parseGitHubPath(parts);
        if (gh) {
          return { kind: "github", owner: gh.owner, repo: gh.repo };
        }
      }
    } catch {
      return { kind: "local", path: trimmed };
    }
    throw new Error(`Only https URLs are allowed for remote OpenAPI fetch: ${trimmed}`);
  }

  return { kind: "local", path: trimmed };
}

function safeJoinUnder(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...segments);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (target !== resolvedRoot && !target.startsWith(rootWithSep)) {
    throw new Error(`Path escapes cache root: ${segments.join("/")}`);
  }
  return target;
}

function assertZipEntryPath(entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("../") ||
    normalized.startsWith("..")
  ) {
    throw new Error(`Unsafe archive entry path: ${entryName}`);
  }
  return normalized;
}

function extractZipBuffer(zip: Buffer, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const eocdOffset = findEndOfCentralDirectory(zip);
  if (eocdOffset < 0) {
    throw new Error("Invalid zip archive");
  }
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = zip.readUInt32LE(eocdOffset + 16);
  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid zip central directory");
    }
    const compression = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const nameRaw = zip.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    const name = assertZipEntryPath(nameRaw);
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) {
      mkdirSync(safeJoinUnder(destDir, name), { recursive: true });
      continue;
    }

    const local = localHeaderOffset;
    if (zip.readUInt32LE(local) !== 0x04034b50) {
      throw new Error("Invalid zip local header");
    }
    const localNameLen = zip.readUInt16LE(local + 26);
    const localExtraLen = zip.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLen + localExtraLen;
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    let payload: Buffer;
    if (compression === 0) {
      payload = compressed;
    } else if (compression === 8) {
      payload = inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported zip compression method: ${compression}`);
    }
    if (payload.length !== uncompressedSize) {
      throw new Error("Zip size mismatch after decompress");
    }
    const outPath = safeJoinUnder(destDir, name);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, payload);
  }
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minEocd = 22;
  const maxComment = 0xffff;
  const start = Math.max(0, zip.length - minEocd - maxComment);
  for (let i = zip.length - minEocd; i >= start; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  return -1;
}

function spawnAsync(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function gitAvailable(): boolean {
  const result = spawnSync("git", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

function tarAvailable(): boolean {
  const result = spawnSync("tar", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

async function downloadToBuffer(
  url: string,
  fetchImpl: typeof fetch,
  ssrfOpts?: { allowGitHubHosts?: boolean },
): Promise<Buffer> {
  await assertSafeFetchUrl(url, ssrfOpts);
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "repomcp-remote-target",
    },
  });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const len = Number.parseInt(lengthHeader, 10);
    if (Number.isFinite(len) && len > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Download too large: ${len} bytes`);
    }
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Download too large: ${arrayBuffer.byteLength} bytes`);
  }
  return Buffer.from(arrayBuffer);
}

async function downloadToFile(
  url: string,
  destFile: string,
  fetchImpl: typeof fetch,
  ssrfOpts?: { allowGitHubHosts?: boolean },
): Promise<void> {
  await assertSafeFetchUrl(url, ssrfOpts);
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "repomcp-remote-target" },
  });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Download too large: ${buf.length} bytes`);
    }
    writeFileSync(destFile, buf);
    return;
  }
  mkdirSync(dirname(destFile), { recursive: true });
  const file = createWriteStream(destFile);
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > MAX_DOWNLOAD_BYTES) {
      file.close();
      await rm(destFile, { force: true });
      throw new Error(`Download too large: ${total} bytes`);
    }
    file.write(chunk);
  }
  await new Promise<void>((resolveEnd, rejectEnd) => {
    file.end(() => resolveEnd());
    file.on("error", rejectEnd);
  });
}

function writeRemoteMarker(
  root: string,
  payload: Record<string, unknown>,
): void {
  const markerPath = join(root, REMOTE_MARKER);
  writeFileSync(markerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readCompleteMarker(dir: string): boolean {
  return existsSync(join(dir, ".repomcp-complete"));
}

function markComplete(dir: string): void {
  writeFileSync(join(dir, ".repomcp-complete"), "ok\n", "utf8");
}

function findSingleRootDir(extractDir: string): string {
  const entries = readdirSync(extractDir);
  const dirs = entries.filter((name) => {
    try {
      return statSync(join(extractDir, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (dirs.length === 1) {
    return join(extractDir, dirs[0]);
  }
  return extractDir;
}

async function materializeGitHubFromZip(
  owner: string,
  repo: string,
  dest: string,
  cacheDir: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/HEAD`;
  const zipBuf = await downloadToBuffer(zipUrl, fetchImpl, { allowGitHubHosts: true });
  const staging = await mkdtemp(join(cacheDir, "github-staging-"));
  try {
    extractZipBuffer(zipBuf, staging);
    const root = findSingleRootDir(staging);
    mkdirSync(dest, { recursive: true });
    copyDirectoryRecursive(root, dest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function resolveGitHub(
  owner: string,
  repo: string,
  cacheDir: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const dest = join(cacheDir, "github", `${owner}--${repo}`);
  if (readCompleteMarker(dest)) {
    return dest;
  }
  if (existsSync(dest)) {
    await rm(dest, { recursive: true, force: true });
  }
  mkdirSync(dirname(dest), { recursive: true });

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  if (gitAvailable()) {
    const { code } = await spawnAsync("git", [
      "clone",
      "--depth",
      "1",
      cloneUrl,
      dest,
    ]);
    if (code === 0) {
      markComplete(dest);
      writeRemoteMarker(dest, {
        kind: "github",
        owner,
        repo,
        method: "git-shallow",
      });
      return dest;
    }
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
  }

  await materializeGitHubFromZip(owner, repo, dest, cacheDir, fetchImpl);
  markComplete(dest);
  writeRemoteMarker(dest, {
    kind: "github",
    owner,
    repo,
    method: "zipball",
  });
  return dest;
}

function copyDirectoryRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(from, to);
    } else if (entry.isFile()) {
      writeFileSync(to, readFileSync(from));
    }
  }
}

async function resolveGitHubTarballFallback(
  owner: string,
  repo: string,
  dest: string,
  cacheDir: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!tarAvailable()) {
    throw new Error("git clone and zip extraction failed; tar unavailable");
  }
  const tarUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`;
  const tarFile = join(cacheDir, "downloads", `${owner}--${repo}.tar.gz`);
  mkdirSync(dirname(tarFile), { recursive: true });
  await downloadToFile(tarUrl, tarFile, fetchImpl, { allowGitHubHosts: true });
  mkdirSync(dest, { recursive: true });
  const { code, stderr } = await spawnAsync("tar", [
    "-xzf",
    tarFile,
    "-C",
    dest,
    "--strip-components=1",
  ]);
  if (code !== 0) {
    throw new Error(`tar extract failed: ${stderr.trim() || code}`);
  }
}

async function resolveGitHubTarget(
  owner: string,
  repo: string,
  cacheDir: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  try {
    return await resolveGitHub(owner, repo, cacheDir, fetchImpl);
  } catch {
    const dest = join(cacheDir, "github", `${owner}--${repo}`);
    if (existsSync(dest)) {
      await rm(dest, { recursive: true, force: true });
    }
    mkdirSync(dest, { recursive: true });
    await resolveGitHubTarballFallback(owner, repo, dest, cacheDir, fetchImpl);
    markComplete(dest);
    writeRemoteMarker(dest, {
      kind: "github",
      owner,
      repo,
      method: "tarball",
    });
    return dest;
  }
}

async function resolveOpenApiUrl(
  url: string,
  cacheDir: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const key = cacheKey(url);
  const dir = join(cacheDir, "openapi", key);
  const fileName = safeOpenApiFileName(url);
  const destFile = join(dir, fileName);
  if (existsSync(join(dir, ".repomcp-complete"))) {
    return destFile;
  }
  mkdirSync(dir, { recursive: true });
  await downloadToFile(url, destFile, fetchImpl);
  markComplete(dir);
  writeRemoteMarker(dir, { kind: "openapi-url", url, file: fileName });
  return destFile;
}

function safeOpenApiFileName(url: string): string {
  try {
    const parsed = new URL(url);
    const base = basename(parsed.pathname);
    if (base && /^[a-zA-Z0-9._-]+$/.test(base)) {
      return base;
    }
  } catch {
    // ignore
  }
  return "openapi.json";
}

function resolveLocalPath(pathInput: string): string {
  const abs = resolve(pathInput);
  if (!existsSync(abs)) {
    throw new Error(`Local path does not exist: ${pathInput}`);
  }
  return abs;
}

export async function resolveRemoteTarget(
  input: string,
  opts?: RemoteResolveOptions,
): Promise<ResolvedRemoteTarget> {
  const parsed = parseRemoteTarget(input);
  const cacheDir = opts?.cacheDir ?? defaultCacheDir();
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available; pass fetchImpl in options");
  }
  mkdirSync(cacheDir, { recursive: true });

  switch (parsed.kind) {
    case "github": {
      if (!parsed.owner || !parsed.repo) {
        throw new Error(`Invalid github target: ${input}`);
      }
      const localPath = await resolveGitHubTarget(
        parsed.owner,
        parsed.repo,
        cacheDir,
        fetchImpl,
      );
      return { localPath, kind: "github" };
    }
    case "openapi-url": {
      if (!parsed.url) {
        throw new Error(`Invalid openapi URL target: ${input}`);
      }
      const localPath = await resolveOpenApiUrl(parsed.url, cacheDir, fetchImpl);
      return { localPath, kind: "openapi-url" };
    }
    case "local": {
      const localPath = resolveLocalPath(parsed.path ?? input);
      return { localPath, kind: "local" };
    }
    default: {
      const _exhaustive: never = parsed.kind;
      throw new Error(`Unhandled remote target kind: ${String(_exhaustive)}`);
    }
  }
}

export async function discoverFromRemote(
  input: string,
  opts?: RemoteResolveOptions,
): Promise<{ root: string; kind: string }> {
  const resolved = await resolveRemoteTarget(input, opts);
  return { root: resolved.localPath, kind: resolved.kind };
}

/**
 * Remote materialization has no standalone MCP tools; other adapters run on `root`.
 */
export function discoverRemoteTarget(_materializedRoot: string): AdapterDiscovery {
  const markerPath = join(_materializedRoot, REMOTE_MARKER);
  if (!existsSync(markerPath)) {
    return emptyDiscovery();
  }
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  } catch {
    return emptyDiscovery();
  }
  const toolName = "remote_target_info";
  return {
    tools: [
      {
        name: toolName,
        description: "Metadata for a materialized remote target (github/openapi-url).",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        mutates: false,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
    handlers: {
      [toolName]: async () => meta,
    },
  };
}
