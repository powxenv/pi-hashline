import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { relative } from "node:path";

import { collectProjectFiles, matchesProjectGlob } from "../shared/project-files";
import { resolveToCwd } from "../shared/paths";

const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_FILES_VISITED = 20_000;

type FindParams = {
  path?: string;
  pattern?: string;
  regex?: string;
  include?: string[];
  exclude?: string[];
  maxDepth?: number;
  limit?: number;
  maxFilesVisited?: number;
  respectGitignore?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function getOptionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`find field "${field}" must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function getStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`find field "${field}" must be an array of strings.`);
  }
  return value;
}

function parseParams(params: unknown): FindParams {
  if (!isRecord(params)) throw new Error("find params must be an object.");
  return {
    path: typeof params["path"] === "string" ? params["path"] : undefined,
    pattern: typeof params["pattern"] === "string" ? params["pattern"] : undefined,
    regex: typeof params["regex"] === "string" ? params["regex"] : undefined,
    include: getStringArray(params["include"], "include"),
    exclude: getStringArray(params["exclude"], "exclude"),
    maxDepth: getOptionalInteger(params["maxDepth"], "maxDepth", 0, 1000),
    limit: getInteger(params["limit"], DEFAULT_LIMIT, 1, 5000),
    maxFilesVisited: getInteger(params["maxFilesVisited"], DEFAULT_MAX_FILES_VISITED, 1, 100_000),
    respectGitignore:
      typeof params["respectGitignore"] === "boolean" ? params["respectGitignore"] : undefined,
  };
}

function createRegex(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  try {
    return new RegExp(pattern);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[E_BAD_REGEX] Invalid find regex pattern: ${message}`);
  }
}

function getDepth(relativePath: string): number {
  if (relativePath.length === 0) return 0;
  return relativePath.split(/[\\/]/).length - 1;
}

function matchesFindFilters(
  relativePath: string,
  params: FindParams,
  regex: RegExp | undefined,
): boolean {
  if (params.maxDepth !== undefined && getDepth(relativePath) > params.maxDepth) return false;
  if (params.pattern !== undefined && !matchesProjectGlob(relativePath, params.pattern))
    return false;
  if (regex !== undefined && !regex.test(relativePath)) return false;
  return true;
}

export type FindResult = {
  content: Array<{ type: "text"; text: string }>;
  details: {
    matchedFiles: number;
    returnedFiles: number;
    filesVisited: number;
    truncated: boolean;
    fileLimitReached: boolean;
  };
};

export async function executeFind(paramsInput: {
  rawParams: unknown;
  cwd: string;
  signal?: AbortSignal;
}): Promise<FindResult> {
  const params = parseParams(paramsInput.rawParams);
  const rootPath = resolveToCwd(params.path ?? ".", paramsInput.cwd);
  const regex = createRegex(params.regex);
  const collection = await collectProjectFiles({
    rootPath,
    cwd: paramsInput.cwd,
    signal: paramsInput.signal,
    include: params.include,
    exclude: params.exclude,
    maxFilesVisited: params.maxFilesVisited,
    respectGitignore: params.respectGitignore,
  });

  const matched = collection.files
    .map((filePath) => relative(paramsInput.cwd, filePath) || filePath)
    .filter((path) => matchesFindFilters(path, params, regex))
    .sort((left, right) => left.localeCompare(right));
  const visible = matched.slice(0, params.limit ?? DEFAULT_LIMIT);
  const lines = [...visible];
  if (visible.length < matched.length) {
    lines.push(
      "",
      `[Showing ${visible.length} of ${matched.length} files. Raise limit or narrow filters.]`,
    );
  }
  if (collection.truncated) {
    lines.push(
      "",
      "[File visit limit reached. Narrow path/include/exclude or raise maxFilesVisited.]",
    );
  }

  return {
    content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No files found." }],
    details: {
      matchedFiles: matched.length,
      returnedFiles: visible.length,
      filesVisited: collection.filesVisited,
      truncated: visible.length < matched.length || collection.truncated,
      fileLimitReached: collection.truncated,
    },
  };
}

export function registerFindTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "find",
    label: "Find",
    description:
      "Find files recursively with .gitignore support, glob filters, regex filtering, depth limits, and deterministic compact output.",
    promptSnippet: "Find files recursively with .gitignore-aware compact output",
    promptGuidelines: [
      "Use find instead of bash find for project file discovery.",
      "Use include/exclude globs and maxDepth to keep output focused.",
      "Set respectGitignore=false when ignored or generated files are required.",
    ],
    parameters: Type.Object(
      {
        path: Type.Optional(
          Type.String({ description: "Directory or file to search; defaults to cwd" }),
        ),
        pattern: Type.Optional(
          Type.String({
            description: "Glob pattern to match returned files, e.g. '*.ts' or 'src/**/*.ts'",
          }),
        ),
        regex: Type.Optional(Type.String({ description: "Regex matched against relative paths" })),
        include: Type.Optional(
          Type.Array(Type.String(), { description: "Glob patterns to include" }),
        ),
        exclude: Type.Optional(
          Type.Array(Type.String(), { description: "Glob patterns to exclude" }),
        ),
        maxDepth: Type.Optional(
          Type.Integer({ minimum: 0, maximum: 1000, description: "Maximum relative file depth" }),
        ),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 5000, description: "Maximum files to return" }),
        ),
        maxFilesVisited: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 100000, description: "Maximum files to visit" }),
        ),
        respectGitignore: Type.Optional(
          Type.Boolean({ description: "Respect .gitignore files. Defaults to true" }),
        ),
      },
      { additionalProperties: false },
    ),

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      return executeFind({ rawParams, cwd: ctx.cwd, signal });
    },
  });
}
