import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { opendir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { normalizeToLF, stripBom } from "../hashline/diff";
import { computeLineHash } from "../hashline/engine";
import { loadFileKindAndText } from "../shared/file-kind";
import { resolveToCwd } from "../shared/paths";
import { throwIfAborted } from "../shared/runtime";

const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_CONTEXT_LINES = 0;
const MAX_FILES_VISITED = 20_000;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "target",
  "vendor",
]);

const GREP_PROMPT_SNIPPET = "Search files and return hashline-anchored matches";

const GREP_PROMPT_GUIDELINES = [
  "Use grep for locating code before reading large files.",
  "Use grep output anchors for follow-up edits when the match lines are sufficient.",
];

type GrepMatch = {
  path: string;
  line: number;
  hash: string;
  text: string;
  matched: boolean;
};

type GrepSearchParams = {
  pattern: string;
  path?: string;
  literal?: boolean;
  caseSensitive?: boolean;
  context?: number;
  maxMatches?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createMatcher(params: GrepSearchParams): RegExp {
  const flags = params.caseSensitive === true ? "" : "i";
  if (params.literal !== false) {
    return new RegExp(escapeRegExp(params.pattern), flags);
  }
  return new RegExp(params.pattern, flags);
}

async function collectFiles(rootPath: string, signal: AbortSignal | undefined): Promise<string[]> {
  const files: string[] = [];
  let visited = 0;

  async function visit(path: string): Promise<void> {
    throwIfAborted(signal);
    if (visited >= MAX_FILES_VISITED) return;
    visited += 1;

    const stats = await stat(path);
    if (stats.isFile()) {
      files.push(path);
      return;
    }
    if (!stats.isDirectory()) return;

    const dir = await opendir(path);
    for await (const entry of dir) {
      throwIfAborted(signal);
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await visit(join(path, entry.name));
      if (visited >= MAX_FILES_VISITED) return;
    }
  }

  await visit(rootPath);
  return files;
}

function collectMatches(params: {
  filePath: string;
  displayPath: string;
  content: string;
  matcher: RegExp;
  contextLines: number;
  remainingMatches: number;
}): GrepMatch[] {
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
    const start = Math.max(0, index - params.contextLines);
    const end = Math.min(lines.length - 1, index + params.contextLines);
    for (let current = start; current <= end; current++) {
      outputLineIndexes.set(current, outputLineIndexes.get(current) === true || current === index);
    }
  }

  return [...outputLineIndexes.entries()]
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
}

function formatMatches(matches: GrepMatch[], truncated: boolean): string {
  if (matches.length === 0) return "No matches found.";

  const lines = matches.map((match) => {
    const marker = match.matched ? ">" : " ";
    return `${marker} ${match.path}:${match.line}#${match.hash}:${match.text}`;
  });

  if (truncated) {
    lines.push(
      "",
      `[Search stopped after ${DEFAULT_MAX_MATCHES} matches. Narrow the path or pattern for more precise results.]`,
    );
  }

  return lines.join("\n");
}

function parseParams(params: unknown): GrepSearchParams {
  if (!isRecord(params)) throw new Error("grep params must be an object.");
  if (typeof params["pattern"] !== "string" || params["pattern"].length === 0) {
    throw new Error("grep requires a non-empty pattern string.");
  }

  return {
    pattern: params["pattern"],
    path: typeof params["path"] === "string" ? params["path"] : undefined,
    literal: typeof params["literal"] === "boolean" ? params["literal"] : undefined,
    caseSensitive:
      typeof params["caseSensitive"] === "boolean" ? params["caseSensitive"] : undefined,
    context: getInteger(params["context"], DEFAULT_CONTEXT_LINES, 0, 20),
    maxMatches: getInteger(params["maxMatches"], DEFAULT_MAX_MATCHES, 1, 1000),
  };
}

export function registerGrepTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "grep",
    label: "Grep",
    description:
      "Search text files and return hashline-anchored matches. Directories are searched recursively while common dependency/build directories are skipped.",
    promptSnippet: GREP_PROMPT_SNIPPET,
    promptGuidelines: GREP_PROMPT_GUIDELINES,
    parameters: Type.Object(
      {
        pattern: Type.String({ description: "Text or regex pattern to search for" }),
        path: Type.Optional(
          Type.String({ description: "File or directory to search; defaults to cwd" }),
        ),
        literal: Type.Optional(
          Type.Boolean({ description: "Treat pattern as literal text. Defaults to true" }),
        ),
        caseSensitive: Type.Optional(
          Type.Boolean({ description: "Use case-sensitive matching. Defaults to false" }),
        ),
        context: Type.Optional(
          Type.Integer({ minimum: 0, maximum: 20, description: "Context lines around each match" }),
        ),
        maxMatches: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum matching lines" }),
        ),
      },
      { additionalProperties: false },
    ),

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = parseParams(rawParams);
      const rootPath = resolveToCwd(params.path ?? ".", ctx.cwd);
      const matcher = createMatcher(params);
      const maxMatches = params.maxMatches ?? DEFAULT_MAX_MATCHES;
      const contextLines = params.context ?? DEFAULT_CONTEXT_LINES;
      const files = await collectFiles(rootPath, signal);
      const matches: GrepMatch[] = [];

      for (const filePath of files) {
        throwIfAborted(signal);
        if (matches.filter((match) => match.matched).length >= maxMatches) break;

        const file = await loadFileKindAndText(filePath);
        if (file.kind !== "text") continue;

        const remainingMatches = maxMatches - matches.filter((match) => match.matched).length;
        const displayPath = relative(ctx.cwd, filePath) || filePath;
        matches.push(
          ...collectMatches({
            filePath,
            displayPath,
            content: file.text,
            matcher,
            contextLines,
            remainingMatches,
          }),
        );
      }

      const matchedCount = matches.filter((match) => match.matched).length;
      const truncated = matchedCount >= maxMatches;

      return {
        content: [{ type: "text", text: formatMatches(matches, truncated) }],
        details: {
          matchedCount,
          filesSearched: files.length,
          truncated,
        },
      };
    },
  });
}
