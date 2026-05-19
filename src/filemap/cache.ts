import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

import { generateMap } from "./extract";
import type { FileMap, FileSymbol } from "./types";
import { getFileSnapshot } from "../shared/snapshot";

const MAX_CACHE_ENTRIES = 64;
const CACHE_VERSION = 1;
const DEFAULT_MAX_PERSISTENT_CACHE_FILES = 2048;
const DEFAULT_MAX_PERSISTENT_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const cache = new Map<string, FileMap | null>();

function touchCacheEntry(key: string, value: FileMap | null): void {
  cache.delete(key);
  cache.set(key, value);

  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") return;
    cache.delete(oldestKey);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFileSymbol(value: unknown): value is FileSymbol {
  if (!isRecord(value)) return false;
  if (typeof value["name"] !== "string") return false;
  if (typeof value["kind"] !== "string") return false;
  if (typeof value["startLine"] !== "number" || !Number.isInteger(value["startLine"])) return false;
  if (typeof value["endLine"] !== "number" || !Number.isInteger(value["endLine"])) return false;
  if (value["signature"] !== undefined && typeof value["signature"] !== "string") return false;
  if (value["modifiers"] !== undefined && !isStringArray(value["modifiers"])) return false;
  if (value["docstring"] !== undefined && typeof value["docstring"] !== "string") return false;
  if (value["isExported"] !== undefined && typeof value["isExported"] !== "boolean") return false;
  const children = value["children"];
  if (children !== undefined) {
    if (!Array.isArray(children)) return false;
    if (!children.every(isFileSymbol)) return false;
  }
  return true;
}

function isFileMap(value: unknown): value is FileMap {
  if (!isRecord(value)) return false;
  if (typeof value["path"] !== "string") return false;
  if (typeof value["totalLines"] !== "number" || !Number.isInteger(value["totalLines"]))
    return false;
  if (typeof value["totalBytes"] !== "number" || !Number.isInteger(value["totalBytes"]))
    return false;
  if (typeof value["language"] !== "string") return false;
  if (!Array.isArray(value["symbols"]) || !value["symbols"].every(isFileSymbol)) return false;
  if (!isStringArray(value["imports"])) return false;
  return true;
}

function getCacheBaseDir(): string {
  const explicit = process.env["PI_HASHLINE_MAP_CACHE_DIR"];
  if (explicit && explicit.length > 0) return explicit;
  const xdg = process.env["XDG_CACHE_HOME"];
  if (xdg && xdg.length > 0) return join(xdg, "pi-hashline", "maps");
  const home = homedir();
  if (home.length > 0) return join(home, ".cache", "pi-hashline", "maps");
  return join(tmpdir(), "pi-hashline", "maps");
}

function getPersistentCachePath(snapshotId: string): string {
  const key = createHash("sha256").update(`${CACHE_VERSION}:${snapshotId}`).digest("hex");
  return join(getCacheBaseDir(), `${key}.json`);
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getPersistentCacheLimits(): { maxFiles: number; maxAgeMs: number } {
  return {
    maxFiles: getPositiveIntegerEnv(
      "PI_HASHLINE_MAP_CACHE_MAX_FILES",
      DEFAULT_MAX_PERSISTENT_CACHE_FILES,
    ),
    maxAgeMs: getPositiveIntegerEnv(
      "PI_HASHLINE_MAP_CACHE_MAX_AGE_MS",
      DEFAULT_MAX_PERSISTENT_CACHE_AGE_MS,
    ),
  };
}

async function prunePersistentCache(): Promise<void> {
  if (process.env["PI_HASHLINE_NO_PERSIST_MAPS"] === "1") return;
  try {
    const cacheBaseDir = getCacheBaseDir();
    const entries = await readdir(cacheBaseDir, { withFileTypes: true });
    const now = Date.now();
    const limits = getPersistentCacheLimits();
    const candidates: Array<{ path: string; mtimeMs: number }> = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const cachePath = join(cacheBaseDir, entry.name);
      const cacheStat = await stat(cachePath);
      if (now - cacheStat.mtimeMs > limits.maxAgeMs) {
        await rm(cachePath, { force: true });
        continue;
      }
      candidates.push({ path: cachePath, mtimeMs: cacheStat.mtimeMs });
    }

    if (candidates.length <= limits.maxFiles) return;
    const excess = candidates
      .sort((left, right) => left.mtimeMs - right.mtimeMs)
      .slice(0, candidates.length - limits.maxFiles);
    await Promise.all(excess.map((entry) => rm(entry.path, { force: true })));
  } catch {
    return;
  }
}

async function readPersistentCache(snapshotId: string): Promise<FileMap | null | undefined> {
  if (process.env["PI_HASHLINE_NO_PERSIST_MAPS"] === "1") return undefined;
  try {
    const raw = await readFile(getPersistentCachePath(snapshotId), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    if (parsed["version"] !== CACHE_VERSION) return undefined;
    const fileMap = parsed["fileMap"];
    if (fileMap === null) return null;
    return isFileMap(fileMap) ? fileMap : undefined;
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined;
    if (code === "ENOENT") return undefined;
    return undefined;
  }
}

async function writePersistentCache(snapshotId: string, fileMap: FileMap | null): Promise<void> {
  if (process.env["PI_HASHLINE_NO_PERSIST_MAPS"] === "1") return;
  try {
    const cachePath = getPersistentCachePath(snapshotId);
    await mkdir(getCacheBaseDir(), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ version: CACHE_VERSION, fileMap }), "utf8");
    await prunePersistentCache();
  } catch {
    return;
  }
}

export async function getCachedFileMap(params: {
  filePath: string;
  content: string;
  totalBytes: number;
}): Promise<FileMap | null> {
  const snapshot = await getFileSnapshot(params.filePath);
  const cached = cache.get(snapshot.snapshotId);
  if (cached !== undefined) {
    touchCacheEntry(snapshot.snapshotId, cached);
    return cached;
  }

  const persisted = await readPersistentCache(snapshot.snapshotId);
  if (persisted !== undefined) {
    touchCacheEntry(snapshot.snapshotId, persisted);
    return persisted;
  }

  const generated = generateMap(params.content, params.filePath, params.totalBytes);
  touchCacheEntry(snapshot.snapshotId, generated);
  await writePersistentCache(snapshot.snapshotId, generated);
  return generated;
}
