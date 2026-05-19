import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { relative } from "node:path";
import { stat } from "node:fs/promises";

import { getCachedFileMap } from "../filemap/cache";
import { formatFileMap } from "../filemap/format";
import { normalizeToLF, stripBom } from "../hashline/diff";
import { loadFileKindAndText } from "../shared/file-kind";
import { collectProjectFiles } from "../shared/project-files";
import { resolveToCwd } from "../shared/paths";
import { throwIfAborted } from "../shared/runtime";

const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_FILES_VISITED = 20_000;
const OUTLINE_TEXT_BUDGET_BYTES = 50 * 1024;

const OUTLINE_PROMPT_SNIPPET = "Return compact file maps without reading full file contents";

const OUTLINE_PROMPT_GUIDELINES = [
  "Use outline to inspect file structure before reading large files.",
  "Use symbol names from outline with read(symbol=...) or edit replace_symbol.",
  "Use include/exclude globs to keep outline output focused.",
];

type OutlineParams = {
  path?: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
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

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`outline field "${field}" must be an array of strings.`);
  }
  return value;
}

function parseParams(params: unknown): OutlineParams {
  if (!isRecord(params)) throw new Error("outline params must be an object.");
  return {
    path: typeof params["path"] === "string" ? params["path"] : undefined,
    include: getStringArray(params["include"], "include"),
    exclude: getStringArray(params["exclude"], "exclude"),
    maxFiles: getInteger(params["maxFiles"], DEFAULT_MAX_FILES, 1, 100),
    maxFilesVisited: getInteger(params["maxFilesVisited"], DEFAULT_MAX_FILES_VISITED, 1, 100_000),
    respectGitignore: getBoolean(params["respectGitignore"]),
  };
}

function appendWithinBudget(parts: string[], next: string): boolean {
  const candidate = parts.length === 0 ? next : `${parts.join("\n\n")}\n\n${next}`;
  if (Buffer.byteLength(candidate, "utf8") > OUTLINE_TEXT_BUDGET_BYTES) return false;
  parts.push(next);
  return true;
}

export function registerOutlineTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "outline",
    label: "Outline",
    description:
      "Return compact structural file maps without reading full file contents. Respects .gitignore by default and supports explicit include/exclude globs.",
    promptSnippet: OUTLINE_PROMPT_SNIPPET,
    promptGuidelines: OUTLINE_PROMPT_GUIDELINES,
    parameters: Type.Object(
      {
        path: Type.Optional(
          Type.String({ description: "File or directory to outline; defaults to cwd" }),
        ),
        include: Type.Optional(
          Type.Array(Type.String(), { description: "Glob patterns to include, e.g. ['*.ts']" }),
        ),
        exclude: Type.Optional(
          Type.Array(Type.String(), { description: "Glob patterns to exclude" }),
        ),
        maxFiles: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 100, description: "Maximum mapped files to return" }),
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
      const params = parseParams(rawParams);
      const rootPath = resolveToCwd(params.path ?? ".", ctx.cwd);
      const fileCollection = await collectProjectFiles({
        rootPath,
        cwd: ctx.cwd,
        signal,
        include: params.include,
        exclude: params.exclude,
        maxFilesVisited: params.maxFilesVisited,
        respectGitignore: params.respectGitignore,
      });

      const parts: string[] = [];
      let mappedFiles = 0;
      let skippedFiles = 0;
      let outputTruncated = false;

      for (const filePath of fileCollection.files) {
        throwIfAborted(signal);
        if (mappedFiles >= (params.maxFiles ?? DEFAULT_MAX_FILES)) {
          outputTruncated = true;
          break;
        }

        const file = await loadFileKindAndText(filePath);
        if (file.kind !== "text") {
          skippedFiles += 1;
          continue;
        }

        const normalized = normalizeToLF(stripBom(file.text).text);
        const stats = await stat(filePath);
        const fileMap = await getCachedFileMap({
          filePath,
          content: normalized,
          totalBytes: stats.size,
        });
        if (!fileMap || fileMap.symbols.length === 0) {
          skippedFiles += 1;
          continue;
        }

        const displayPath = relative(ctx.cwd, filePath) || filePath;
        const text = `Path: ${displayPath}\n${formatFileMap(fileMap).trim()}`;
        if (!appendWithinBudget(parts, text)) {
          outputTruncated = true;
          break;
        }
        mappedFiles += 1;
      }

      if (parts.length === 0) {
        parts.push("No file maps found. Narrow include globs or use read for specific files.");
      }
      if (outputTruncated || fileCollection.truncated) {
        parts.push("Output truncated. Narrow path/include/exclude or lower maxFiles.");
      }

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details: {
          mappedFiles,
          skippedFiles,
          filesMatched: fileCollection.files.length,
          filesVisited: fileCollection.filesVisited,
          truncated: outputTruncated || fileCollection.truncated,
          fileLimitReached: fileCollection.truncated,
        },
      };
    },
  });
}
