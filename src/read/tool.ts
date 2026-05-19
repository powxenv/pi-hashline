import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadTool,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stat } from "node:fs/promises";

import { normalizeToLF, stripBom } from "../hashline/diff";
import { formatHashlineRegion } from "../hashline/engine";
import { getCachedFileMap } from "../filemap/cache";
import { formatFileMap } from "../filemap/format";
import { formatSymbolLookupFailure, lookupSymbol } from "../filemap/symbols";
import { loadFileKindAndText } from "../shared/file-kind";
import { resolveToCwd } from "../shared/paths";
import { throwIfAborted } from "../shared/runtime";
import { getFileSnapshot } from "../shared/snapshot";

function getPreviewLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

export function formatHashlineReadPreview(
  text: string,
  options: { offset?: number; limit?: number; continuation?: boolean },
): { text: string; truncation?: TruncationResult; nextOffset?: number } {
  const allLines = getPreviewLines(text);
  const totalLines = allLines.length;
  const startLine = options.offset ?? 1;

  if (totalLines === 0) {
    if (startLine === 1) {
      return {
        text: "File is empty. Use edit with prepend or append and omit pos to insert content.",
      };
    }
    return { text: `Offset ${startLine} is beyond end of file (0 lines total).` };
  }

  if (startLine > totalLines) {
    return {
      text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start.`,
    };
  }

  const endIdx = options.limit ? Math.min(startLine - 1 + options.limit, totalLines) : totalLines;
  const selected = allLines.slice(startLine - 1, endIdx);
  const formatted = formatHashlineRegion(selected, startLine);

  const truncation = truncateHead(formatted);
  if (truncation.firstLineExceedsLimit) {
    return {
      text: `[Line ${startLine} exceeds ${formatSize(truncation.maxBytes)}. Cannot compute hashes for a truncated preview.]`,
      truncation,
    };
  }

  let preview = truncation.content;
  let nextOffset: number | undefined;
  if (truncation.truncated) {
    const endLineDisplay = startLine + truncation.outputLines - 1;
    if (options.continuation !== false) {
      nextOffset = endLineDisplay + 1;
      if (truncation.truncatedBy === "lines") {
        preview += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
      } else {
        preview += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines} (${formatSize(truncation.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
      }
    } else {
      preview += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines}.]`;
    }
  } else if (endIdx < totalLines && options.continuation !== false) {
    nextOffset = endIdx + 1;
    preview += `\n\n[Showing lines ${startLine}-${endIdx} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
  }

  return {
    text: preview,
    truncation: truncation.truncated ? truncation : undefined,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
}

const READ_PROMPT_SNIPPET = `Read a text file with LINE#HASH anchors for edit`;

const READ_PROMPT_GUIDELINES = [
  "Use read before edit when you do not have current LINE#HASH anchors for the file.",
  "If read is truncated, continue with the offset it suggests — do not guess unseen lines.",
];

export function registerReadTool(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const builtinRead = createReadTool(cwd);

  pi.registerTool({
    name: "read",
    label: "Read",
    description: `Read the contents of a file. Each returned line is prefixed LINE#HASH:content — copy those anchors verbatim into edit. Supported images are returned as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${Math.round(DEFAULT_MAX_BYTES / 1024)}KB (whichever is hit first). Use offset/limit for large files, map for a structural overview, or symbol to read a specific declaration.`,
    promptSnippet: READ_PROMPT_SNIPPET,
    promptGuidelines: READ_PROMPT_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(
        Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, description: "Maximum number of lines to read" }),
      ),
      map: Type.Optional(Type.Boolean({ description: "Append a structural file map" })),
      symbol: Type.Optional(Type.String({ description: "Symbol name to read, optionally qualified or suffixed with @line" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const rawPath = params.path;
      const absolutePath = resolveToCwd(rawPath, ctx.cwd);

      throwIfAborted(signal);

      const file = await loadFileKindAndText(absolutePath);
      if (file.kind === "directory") {
        throw new Error(`Path is a directory: ${rawPath}. Use ls to inspect directories.`);
      }
      if (file.kind === "binary") {
        throw new Error(`Path is a binary file: ${rawPath} (${file.description}).`);
      }
      if (file.kind === "image") {
        return builtinRead.execute(_toolCallId, params, signal, _onUpdate);
      }

      throwIfAborted(signal);
      const normalized = normalizeToLF(stripBom(file.text).text);
      const stats = await stat(absolutePath);
      const snapshot = await getFileSnapshot(absolutePath);
      let preview = formatHashlineReadPreview(normalized, {
        offset: params.offset,
        limit: params.limit,
      });
      let mapText: string | undefined;

      if (params.symbol !== undefined) {
        if (params.offset !== undefined || params.limit !== undefined) {
          throw new Error("Cannot combine symbol with offset or limit.");
        }

        const fileMap = await getCachedFileMap({
          filePath: absolutePath,
          content: normalized,
          totalBytes: stats.size,
        });
        if (!fileMap || fileMap.symbols.length === 0) {
          throw new Error(`Symbol lookup is not available for ${rawPath}.`);
        }

        const lookup = lookupSymbol(fileMap, params.symbol);
        if (lookup.type !== "found") {
          throw new Error(formatSymbolLookupFailure(params.symbol, lookup));
        }

        preview = formatHashlineReadPreview(normalized, {
          offset: lookup.symbol.startLine,
          limit: lookup.symbol.endLine - lookup.symbol.startLine + 1,
          continuation: false,
        });
      }

      if (params.map === true || (!params.offset && !params.limit && params.symbol === undefined && stats.size > DEFAULT_MAX_BYTES)) {
        const fileMap = await getCachedFileMap({
          filePath: absolutePath,
          content: normalized,
          totalBytes: stats.size,
        });
        if (fileMap && fileMap.symbols.length > 0) {
          mapText = formatFileMap(fileMap);
        }
      }

      const contentText = mapText ? `${preview.text}\n${mapText}` : preview.text;

      return {
        content: [{ type: "text", text: contentText }],
        details: {
          truncation: preview.truncation,
          snapshotId: snapshot.snapshotId,
          ...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
        },
      };
    },
  });
}
