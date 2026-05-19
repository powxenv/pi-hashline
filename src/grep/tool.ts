import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { relative } from "node:path";

import { normalizeToLF, stripBom } from "../hashline/diff";
import { computeLineHash } from "../hashline/engine";
import { loadFileKindAndText } from "../shared/file-kind";
import { collectProjectFiles } from "../shared/project-files";
import { resolveToCwd } from "../shared/paths";
import { throwIfAborted } from "../shared/runtime";

const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_CONTEXT_LINES = 0;
const DEFAULT_MAX_FILES_VISITED = 20_000;

const GREP_PROMPT_SNIPPET = "Search files and return hashline-anchored matches";

const GREP_PROMPT_GUIDELINES = [
  "Use grep for locating code before reading large files.",
  "Use grep output anchors for follow-up edits when the match lines are sufficient.",
  "Use include/exclude globs to narrow broad searches and reduce context.",
  "Set respectGitignore=false when the task requires ignored, generated, vendored, or dependency files.",
];

type GrepMatch = {
  path: string;
  line: number;
  hash: string;
  text: string;
  matched: boolean;
};

type GrepFileCount = {
  path: string;
  matches: number;
};

type GrepSearchParams = {
  pattern: string;
  path?: string;
  include?: string[];
  exclude?: string[];
  literal?: boolean;
  caseSensitive?: boolean;
  context?: number;
  before?: number;
  after?: number;
  maxMatches?: number;
  maxFilesVisited?: number;
  respectGitignore?: boolean;
  countOnly?: boolean;
  summary?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`grep field "${field}" must be an array of strings.`);
  }
  return value;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createMatcher(params: GrepSearchParams): RegExp {
  const flags = params.caseSensitive === true ? "" : "i";
  try {
    if (params.literal !== false) {
      return new RegExp(escapeRegExp(params.pattern), flags);
    }
    return new RegExp(params.pattern, flags);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[E_BAD_REGEX] Invalid grep regex pattern: ${message}`);
  }
}

function collectMatches(params: {
  displayPath: string;
  content: string;
  matcher: RegExp;
  beforeLines: number;
  afterLines: number;
  remainingMatches: number;
}): { matches: GrepMatch[]; matchedCount: number } {
  const lines = normalizeToLF(stripBom(params.content).text).split("\n");
  const matchedLineIndexes: number[] = [];

  for (let index = 0; index < lines.length; index++) {
    params.matcher.lastIndex = 0;
    if (params.matcher.test(lines[index] ?? "")) {
      matchedLineIndexes.push(index);
      if (matchedLineIndexes.length >= params.remainingMatches) break;
    }
  }

  const outputLineIndexes = new Map<number, boolean>();
  for (const index of matchedLineIndexes) {
    const start = Math.max(0, index - params.beforeLines);
    const end = Math.min(lines.length - 1, index + params.afterLines);
    for (let current = start; current <= end; current++) {
      outputLineIndexes.set(current, outputLineIndexes.get(current) === true || current === index);
    }
  }

  const matches = [...outputLineIndexes.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, matched]) => {
      const line = index + 1;
      const text = lines[index] ?? "";
      return {
        path: params.displayPath,
        line,
        hash: computeLineHash(line, text),
        text,
        matched,
      };
    });

  return { matches, matchedCount: matchedLineIndexes.length };
}

function countMatches(content: string, matcher: RegExp, remainingMatches: number): number {
  const lines = normalizeToLF(stripBom(content).text).split("\n");
  let matchedCount = 0;
  for (const line of lines) {
    matcher.lastIndex = 0;
    if (matcher.test(line)) {
      matchedCount += 1;
      if (matchedCount >= remainingMatches) break;
    }
  }
  return matchedCount;
}

function formatMatches(params: {
  matches: GrepMatch[];
  maxMatches: number;
  matchLimitReached: boolean;
  fileLimitReached: boolean;
}): string {
  if (params.matches.length === 0) {
    return params.fileLimitReached
      ? "No matches found before the file visit limit was reached. Narrow the path or raise maxFilesVisited."
      : "No matches found.";
  }

  const lines = params.matches.map((match) => {
    const marker = match.matched ? ">" : " ";
    return `${marker} ${match.path}:${match.line}#${match.hash}:${match.text}`;
  });

  if (params.matchLimitReached) {
    lines.push(
      "",
      `[Search stopped after ${params.maxMatches} matching lines. Narrow the path or pattern for more precise results.]`,
    );
  }
  if (params.fileLimitReached) {
    lines.push(
      "",
      "[Search stopped after the file visit limit. Narrow the path or raise maxFilesVisited.]",
    );
  }

  return lines.join("\n");
}

function formatCounts(params: {
  counts: GrepFileCount[];
  totalMatches: number;
  maxMatches: number;
  matchLimitReached: boolean;
  fileLimitReached: boolean;
}): string {
  if (params.counts.length === 0) {
    return params.fileLimitReached
      ? "No matches found before the file visit limit was reached."
      : "No matches found.";
  }

  const lines = params.counts.map((count) => `${count.path}: ${count.matches}`);
  lines.push("", `Total matching lines: ${params.totalMatches}`);
  if (params.matchLimitReached) {
    lines.push(`[Counting stopped after ${params.maxMatches} matching lines.]`);
  }
  if (params.fileLimitReached) {
    lines.push("[Counting stopped after the file visit limit.]");
  }
  return lines.join("\n");
}

function parseParams(params: unknown): GrepSearchParams {
  if (!isRecord(params)) throw new Error("grep params must be an object.");
  if (typeof params["pattern"] !== "string" || params["pattern"].length === 0) {
    throw new Error("grep requires a non-empty pattern string.");
  }

  const context = getInteger(params["context"], DEFAULT_CONTEXT_LINES, 0, 20);
  return {
    pattern: params["pattern"],
    path: typeof params["path"] === "string" ? params["path"] : undefined,
    include: getStringArray(params["include"], "include"),
    exclude: getStringArray(params["exclude"], "exclude"),
    literal: getBoolean(params["literal"]),
    caseSensitive: getBoolean(params["caseSensitive"]),
    context,
    before: getInteger(params["before"], context, 0, 20),
    after: getInteger(params["after"], context, 0, 20),
    maxMatches: getInteger(params["maxMatches"], DEFAULT_MAX_MATCHES, 1, 1000),
    maxFilesVisited: getInteger(params["maxFilesVisited"], DEFAULT_MAX_FILES_VISITED, 1, 100_000),
    respectGitignore: getBoolean(params["respectGitignore"]),
    countOnly: getBoolean(params["countOnly"]),
    summary: getBoolean(params["summary"]),
  };
}

export function registerGrepTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "grep",
    label: "Grep",
    description:
      "Search text files and return hashline-anchored matches. Directories are searched recursively, .gitignore is respected by default, and explicit include/exclude globs are supported.",
    promptSnippet: GREP_PROMPT_SNIPPET,
    promptGuidelines: GREP_PROMPT_GUIDELINES,
    parameters: Type.Object(
      {
        pattern: Type.String({ description: "Text or regex pattern to search for" }),
        path: Type.Optional(
          Type.String({ description: "File or directory to search; defaults to cwd" }),
        ),
        include: Type.Optional(
          Type.Array(Type.String(), {
            description: "Glob patterns to include, e.g. ['*.ts', 'src/**/*.tsx']",
          }),
        ),
        exclude: Type.Optional(
          Type.Array(Type.String(), { description: "Glob patterns to exclude" }),
        ),
        literal: Type.Optional(
          Type.Boolean({ description: "Treat pattern as literal text. Defaults to true" }),
        ),
        caseSensitive: Type.Optional(
          Type.Boolean({ description: "Use case-sensitive matching. Defaults to false" }),
        ),
        context: Type.Optional(
          Type.Integer({
            minimum: 0,
            maximum: 20,
            description: "Symmetric context lines around each match",
          }),
        ),
        before: Type.Optional(
          Type.Integer({ minimum: 0, maximum: 20, description: "Context lines before each match" }),
        ),
        after: Type.Optional(
          Type.Integer({ minimum: 0, maximum: 20, description: "Context lines after each match" }),
        ),
        maxMatches: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum matching lines" }),
        ),
        maxFilesVisited: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 100000, description: "Maximum files to visit" }),
        ),
        respectGitignore: Type.Optional(
          Type.Boolean({ description: "Respect .gitignore files. Defaults to true" }),
        ),
        countOnly: Type.Optional(
          Type.Boolean({ description: "Return per-file match counts instead of anchored content" }),
        ),
        summary: Type.Optional(
          Type.Boolean({ description: "Return per-file match counts instead of anchored content" }),
        ),
      },
      { additionalProperties: false },
    ),

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = parseParams(rawParams);
      const rootPath = resolveToCwd(params.path ?? ".", ctx.cwd);
      const matcher = createMatcher(params);
      const maxMatches = params.maxMatches ?? DEFAULT_MAX_MATCHES;
      const fileCollection = await collectProjectFiles({
        rootPath,
        cwd: ctx.cwd,
        signal,
        include: params.include,
        exclude: params.exclude,
        maxFilesVisited: params.maxFilesVisited,
        respectGitignore: params.respectGitignore,
      });
      const matches: GrepMatch[] = [];
      const counts: GrepFileCount[] = [];
      let matchedCount = 0;

      for (const filePath of fileCollection.files) {
        throwIfAborted(signal);
        if (matchedCount >= maxMatches) break;

        const file = await loadFileKindAndText(filePath);
        if (file.kind !== "text") continue;

        const remainingMatches = maxMatches - matchedCount;
        const displayPath = relative(ctx.cwd, filePath) || filePath;
        if (params.countOnly === true || params.summary === true) {
          const fileMatchedCount = countMatches(file.text, matcher, remainingMatches);
          if (fileMatchedCount > 0) {
            counts.push({ path: displayPath, matches: fileMatchedCount });
            matchedCount += fileMatchedCount;
          }
          continue;
        }

        const result = collectMatches({
          displayPath,
          content: file.text,
          matcher,
          beforeLines: params.before ?? params.context ?? DEFAULT_CONTEXT_LINES,
          afterLines: params.after ?? params.context ?? DEFAULT_CONTEXT_LINES,
          remainingMatches,
        });
        matchedCount += result.matchedCount;
        matches.push(...result.matches);
      }

      const matchLimitReached = matchedCount >= maxMatches;
      const text =
        params.countOnly === true || params.summary === true
          ? formatCounts({
              counts,
              totalMatches: matchedCount,
              maxMatches,
              matchLimitReached,
              fileLimitReached: fileCollection.truncated,
            })
          : formatMatches({
              matches,
              maxMatches,
              matchLimitReached,
              fileLimitReached: fileCollection.truncated,
            });

      return {
        content: [{ type: "text", text }],
        details: {
          matchedCount,
          filesSearched: fileCollection.files.length,
          filesVisited: fileCollection.filesVisited,
          truncated: matchLimitReached || fileCollection.truncated,
          matchLimitReached,
          fileLimitReached: fileCollection.truncated,
          ...(params.countOnly === true || params.summary === true ? { counts } : { matches }),
        },
      };
    },
  });
}
