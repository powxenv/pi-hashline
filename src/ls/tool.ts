import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lstat, opendir, stat } from "node:fs/promises";
import { join } from "node:path";

import { resolveToCwd } from "../shared/paths";
import { throwIfAborted } from "../shared/runtime";

const DEFAULT_LIMIT = 500;

type LsParams = {
  path?: string;
  all?: boolean;
  long?: boolean;
  limit?: number;
};

type DirectoryEntry = {
  name: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function parseParams(params: unknown): LsParams {
  if (!isRecord(params)) throw new Error("ls params must be an object.");
  return {
    path: typeof params["path"] === "string" ? params["path"] : undefined,
    all: typeof params["all"] === "boolean" ? params["all"] : undefined,
    long: typeof params["long"] === "boolean" ? params["long"] : undefined,
    limit: getInteger(params["limit"], DEFAULT_LIMIT, 1, 5000),
  };
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sortEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.kind !== right.kind) {
    if (left.kind === "directory") return -1;
    if (right.kind === "directory") return 1;
  }
  return left.name.localeCompare(right.name);
}

function formatEntry(entry: DirectoryEntry, long: boolean): string {
  const suffix = entry.kind === "directory" ? "/" : "";
  if (!long) return `${entry.name}${suffix}`;
  return `${entry.kind.padEnd(9)} ${formatSize(entry.size).padStart(9)} ${entry.name}${suffix}`;
}

export type LsResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { totalEntries: number; returnedEntries: number; truncated: boolean };
};

export async function executeLs(paramsInput: {
  rawParams: unknown;
  cwd: string;
  signal?: AbortSignal;
}): Promise<LsResult> {
  const params = parseParams(paramsInput.rawParams);
  const absolutePath = resolveToCwd(params.path ?? ".", paramsInput.cwd);
  const pathStat = await stat(absolutePath);
  if (!pathStat.isDirectory()) throw new Error(`Path is not a directory: ${params.path ?? "."}`);

  const entries: DirectoryEntry[] = [];
  const directory = await opendir(absolutePath);
  for await (const entry of directory) {
    throwIfAborted(paramsInput.signal);
    if (params.all === false && entry.name.startsWith(".")) continue;
    const entryPath = join(absolutePath, entry.name);
    const entryStat = await lstat(entryPath);
    entries.push({
      name: entry.name,
      kind: entryStat.isDirectory()
        ? "directory"
        : entryStat.isFile()
          ? "file"
          : entryStat.isSymbolicLink()
            ? "symlink"
            : "other",
      size: entryStat.isFile() ? entryStat.size : undefined,
    });
  }

  const sorted = entries.sort(sortEntries);
  const visible = sorted.slice(0, params.limit ?? DEFAULT_LIMIT);
  const lines = visible.map((entry) => formatEntry(entry, params.long === true));
  if (visible.length < sorted.length) {
    lines.push(
      ``,
      `[Showing ${visible.length} of ${sorted.length} entries. Raise limit to see more.]`,
    );
  }

  return {
    content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "Directory is empty." }],
    details: {
      totalEntries: sorted.length,
      returnedEntries: visible.length,
      truncated: visible.length < sorted.length,
    },
  };
}

export function registerLsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ls",
    label: "Ls",
    description:
      "List a directory with agent-friendly, deterministic output. Directories are shown first; dotfiles are included by default.",
    promptSnippet: "List one directory with deterministic, compact output",
    promptGuidelines: [
      "Use ls for directory inspection instead of bash ls.",
      "Use find for recursive file discovery.",
    ],
    parameters: Type.Object(
      {
        path: Type.Optional(Type.String({ description: "Directory to list; defaults to cwd" })),
        all: Type.Optional(Type.Boolean({ description: "Include dotfiles. Defaults to true" })),
        long: Type.Optional(Type.Boolean({ description: "Include entry type and size" })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 5000, description: "Maximum entries to return" }),
        ),
      },
      { additionalProperties: false },
    ),

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      return executeLs({ rawParams, cwd: ctx.cwd, signal });
    },
  });
}
