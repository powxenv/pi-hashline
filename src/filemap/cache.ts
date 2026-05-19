import { generateMap } from "./extract";
import type { FileMap } from "./types";
import { getFileSnapshot } from "../shared/snapshot";

const MAX_CACHE_ENTRIES = 64;

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

  const generated = generateMap(params.content, params.filePath, params.totalBytes);
  touchCacheEntry(snapshot.snapshotId, generated);
  return generated;
}
