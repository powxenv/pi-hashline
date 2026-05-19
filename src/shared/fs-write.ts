import { lstat, mkdir, readlink, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, parse, resolve, sep } from "node:path";

export async function resolveMutationTargetPath(filePath: string): Promise<string> {
  const absolutePath = resolve(filePath);
  const { root } = parse(absolutePath);
  const parts = absolutePath
    .slice(root.length)
    .split(sep)
    .filter((part) => part.length > 0);
  const visitedSymlinks = new Set<string>();

  async function resolveFromParts(currentPath: string, remainingParts: string[]): Promise<string> {
    if (remainingParts.length === 0) {
      return currentPath;
    }

    const [nextPart, ...tail] = remainingParts;
    const candidatePath = join(currentPath, nextPart!);

    try {
      const candidateStats = await lstat(candidatePath);
      if (!candidateStats.isSymbolicLink()) {
        return resolveFromParts(candidatePath, tail);
      }

      if (visitedSymlinks.has(candidatePath)) {
        const error = new Error(
          `Too many symbolic links while resolving ${filePath}`,
        ) as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      }
      visitedSymlinks.add(candidatePath);

      const linkTargetPath = resolve(dirname(candidatePath), await readlink(candidatePath));
      const targetParts = linkTargetPath
        .slice(parse(linkTargetPath).root.length)
        .split(sep)
        .filter((part) => part.length > 0);
      return resolveFromParts(parse(linkTargetPath).root, [...targetParts, ...tail]);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return join(candidatePath, ...tail);
      }
      throw error;
    }
  }

  return resolveFromParts(root, parts);
}

export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  const targetPath = await resolveMutationTargetPath(filePath);

  let existingStats: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    existingStats = await stat(targetPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }

  if (existingStats !== null && existingStats.nlink > 1) {
    await writeFile(targetPath, content, "utf-8");
    return;
  }

  const dir = dirname(targetPath);
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const mode = existingStats !== null ? existingStats.mode & 0o7777 : 0o600;
  await writeFile(tempPath, content, { encoding: "utf-8", flag: "wx", mode });

  await rename(tempPath, targetPath);
}
