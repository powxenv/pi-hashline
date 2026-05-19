import { opendir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

const DEFAULT_MAX_FILES_VISITED = 20_000;

type IgnoreRule = {
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  basePath: string;
  pattern: string;
  segmentMatcher: RegExp | undefined;
  pathMatcher: RegExp | undefined;
};

export type ProjectFileCollection = {
  files: string[];
  filesVisited: number;
  truncated: boolean;
};

export type ProjectFileQuery = {
  rootPath: string;
  cwd: string;
  signal: AbortSignal | undefined;
  include?: string[];
  exclude?: string[];
  maxFilesVisited?: number;
  respectGitignore?: boolean;
};

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function escapeRegExpChar(char: string): string {
  return /[\\^$+?.()|{}[\]]/.test(char) ? `\\${char}` : char;
}

function globToRegExpSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      const next = pattern[index + 1];
      if (next !== undefined) {
        source += escapeRegExpChar(next);
        index += 1;
      } else {
        source += escapeRegExpChar(char);
      }
    } else if (char === "*") {
      const next = pattern[index + 1];
      if (next === "*") {
        const afterNext = pattern[index + 2];
        if (afterNext === "/") {
          index += 2;
          source += "(?:.*/)?";
        } else {
          index += 1;
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char !== undefined) {
      source += escapeRegExpChar(char);
    }
  }
  return source;
}

function compileWholePathGlob(pattern: string): RegExp {
  return new RegExp(`^${globToRegExpSource(pattern)}$`);
}

function compileSegmentGlob(pattern: string): RegExp {
  return new RegExp(`^${globToRegExpSource(pattern)}$`);
}

function normalizePatternList(patterns: string[] | undefined): string[] {
  return patterns?.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0) ?? [];
}

export function matchesProjectGlob(relativePath: string, pattern: string): boolean {
  const normalized = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  if (normalized.includes("/")) {
    return compileWholePathGlob(normalized).test(relativePath);
  }
  return compileSegmentGlob(normalized).test(basename(relativePath));
}

function matchesAnyProjectGlob(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesProjectGlob(relativePath, pattern));
}

function isEscapedAt(text: string, index: number): boolean {
  let slashCount = 0;
  for (let current = index - 1; current >= 0 && text[current] === "\\"; current--) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function trimUnescapedTrailingWhitespace(line: string): string {
  let end = line.length;
  while (end > 0) {
    const char = line[end - 1];
    if (char !== " " && char !== "\t") break;
    if (isEscapedAt(line, end - 1)) break;
    end -= 1;
  }
  return line.slice(0, end);
}

function normalizeGitignoreLine(line: string): { pattern: string; negated: boolean } | null {
  const trimmedEnd = trimUnescapedTrailingWhitespace(line);
  if (trimmedEnd.length === 0) return null;
  if (trimmedEnd[0] === "#" && !isEscapedAt(trimmedEnd, 0)) return null;
  const negated = trimmedEnd[0] === "!" && !isEscapedAt(trimmedEnd, 0);
  return { pattern: negated ? trimmedEnd.slice(1) : trimmedEnd, negated };
}

function compileIgnoreRule(line: string, basePath: string): IgnoreRule | null {
  const normalized = normalizeGitignoreLine(line);
  if (normalized === null) return null;

  const negated = normalized.negated;
  const withoutNegation = normalized.pattern;
  if (withoutNegation.length === 0) return null;

  const directoryOnly = withoutNegation.endsWith("/");
  const withoutDirectoryMarker = directoryOnly ? withoutNegation.slice(0, -1) : withoutNegation;
  const anchored = withoutDirectoryMarker.startsWith("/");
  const pattern = anchored ? withoutDirectoryMarker.slice(1) : withoutDirectoryMarker;
  if (pattern.length === 0) return null;

  const hasPathSeparator = pattern.includes("/");
  const basePrefix = basePath.length > 0 ? `${basePath}/` : "";
  const pathPattern = anchored || hasPathSeparator ? `${basePrefix}${pattern}` : undefined;

  return {
    negated,
    directoryOnly,
    anchored,
    basePath,
    pattern,
    segmentMatcher: pathPattern === undefined ? compileSegmentGlob(pattern) : undefined,
    pathMatcher: pathPattern === undefined ? undefined : compileWholePathGlob(pathPattern),
  };
}

async function loadIgnoreRules(directory: string, cwd: string): Promise<IgnoreRule[]> {
  try {
    const content = await readFile(join(directory, ".gitignore"), "utf8");
    const basePath = toPosixPath(relative(cwd, directory));
    const normalizedBasePath = basePath === "" ? "" : basePath;
    return content
      .split("\n")
      .map((line) => compileIgnoreRule(line, normalizedBasePath))
      .filter((rule): rule is IgnoreRule => rule !== null);
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

function ruleMatches(rule: IgnoreRule, relativePath: string, isDirectory: boolean): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  if (rule.pathMatcher) return rule.pathMatcher.test(relativePath);
  const parts = relativePath.split("/");
  return parts.some((part) => rule.segmentMatcher?.test(part) === true);
}

function isIgnored(relativePath: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, relativePath, isDirectory)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function shouldIncludeFile(relativePath: string, include: string[], exclude: string[]): boolean {
  if (include.length > 0 && !matchesAnyProjectGlob(relativePath, include)) return false;
  if (exclude.length > 0 && matchesAnyProjectGlob(relativePath, exclude)) return false;
  return true;
}

export async function collectProjectFiles(query: ProjectFileQuery): Promise<ProjectFileCollection> {
  const maxFilesVisited = query.maxFilesVisited ?? DEFAULT_MAX_FILES_VISITED;
  const include = normalizePatternList(query.include);
  const exclude = normalizePatternList(query.exclude);
  const files: string[] = [];
  let filesVisited = 0;
  let truncated = false;

  async function visit(path: string, inheritedRules: IgnoreRule[]): Promise<void> {
    if (query.signal?.aborted) throw query.signal.reason;
    if (filesVisited >= maxFilesVisited) {
      truncated = true;
      return;
    }

    const pathStat = await stat(path);
    if (pathStat.isFile()) {
      filesVisited += 1;
      const relativePath = toPosixPath(relative(query.cwd, path));
      if (
        !isIgnored(relativePath, false, inheritedRules) &&
        shouldIncludeFile(relativePath, include, exclude)
      ) {
        files.push(path);
      }
      return;
    }

    if (!pathStat.isDirectory()) return;

    const currentRules =
      query.respectGitignore === false
        ? inheritedRules
        : [...inheritedRules, ...(await loadIgnoreRules(path, query.cwd))];
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (query.signal?.aborted) throw query.signal.reason;
      if (filesVisited >= maxFilesVisited) {
        truncated = true;
        return;
      }

      const childPath = join(path, entry.name);
      const relativePath = toPosixPath(relative(query.cwd, childPath));
      if (entry.isDirectory()) {
        if (isIgnored(relativePath, true, currentRules)) continue;
        await visit(childPath, currentRules);
      } else if (entry.isFile()) {
        filesVisited += 1;
        if (isIgnored(relativePath, false, currentRules)) continue;
        if (!shouldIncludeFile(relativePath, include, exclude)) continue;
        files.push(childPath);
      }
    }
  }

  await visit(query.rootPath, []);
  return { files, filesVisited, truncated };
}
