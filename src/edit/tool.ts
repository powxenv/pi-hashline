import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";

import { normalizeToLF, stripBom, detectLineEnding, restoreLineEndings } from "../hashline/diff";
import {
  applyHashlineEdits,
  computeLineHash,
  hashlineParseText,
  resolveEditAnchors,
  type HashlineToolEdit,
} from "../hashline/engine";
import { buildChangedResponse, buildNoopResponse } from "./response";
import { loadFileKindAndText } from "../shared/file-kind";
import { resolveToCwd } from "../shared/paths";
import { throwIfAborted } from "../shared/runtime";
import { getFileSnapshot } from "../shared/snapshot";
import { writeFileAtomically } from "../shared/fs-write";
import { getCachedFileMap } from "../filemap/cache";
import { formatSymbolLookupFailure, lookupSymbol } from "../filemap/symbols";

const EDIT_PROMPT_SNIPPET = `Edit a text file via LINE#HASH anchors from read`;

const EDIT_PROMPT_GUIDELINES = [
  "Always read a file before editing it to get current LINE#HASH anchors.",
  "Copy anchors verbatim from read output — do not guess or construct them.",
  "Submit all edits for one file in a single edits array.",
  "Use replace_text only when a match is guaranteed unique; otherwise read first and use anchors.",
];

const hashlineEditLinesSchema = Type.Union([
  Type.Array(Type.String(), { description: "content (preferred format)" }),
  Type.String(),
  Type.Null(),
]);

const returnRangeSchema = Type.Object(
  {
    start: Type.Integer({ minimum: 1, description: "first post-edit line to return" }),
    end: Type.Optional(Type.Integer({ minimum: 1, description: "last post-edit line to return" })),
  },
  { additionalProperties: false },
);

const hashlineEditItemSchema = Type.Object(
  {
    op: Type.Union(
      [
        Type.Literal("replace"),
        Type.Literal("append"),
        Type.Literal("prepend"),
        Type.Literal("replace_text"),
        Type.Literal("replace_symbol"),
      ],
      {
        description: 'edit operation: "replace", "append", "prepend", "replace_text", or "replace_symbol"',
      },
    ),
    pos: Type.Optional(Type.String({ description: "anchor" })),
    end: Type.Optional(Type.String({ description: "limit position" })),
    lines: Type.Optional(hashlineEditLinesSchema),
    oldText: Type.Optional(Type.String({ description: "exact text to replace" })),
    newText: Type.Optional(Type.String({ description: "replacement text" })),
    symbol: Type.Optional(Type.String({ description: "symbol name for replace_symbol" })),
  },
  { additionalProperties: false },
);

const hashlineEditToolSchema = Type.Object(
  {
    path: Type.String({ description: "path" }),
    returnMode: Type.Optional(
      Type.Union([Type.Literal("changed"), Type.Literal("full"), Type.Literal("ranges")], {
        description: 'response mode: "changed", "full", or "ranges"',
      }),
    ),
    returnRanges: Type.Optional(
      Type.Array(returnRangeSchema, {
        description: "post-edit line ranges when returnMode is ranges",
      }),
    ),
    edits: Type.Array(hashlineEditItemSchema, { description: "edits over $path" }),
  },
  { additionalProperties: false },
);

type EditRequestParams = {
  path: string;
  returnMode?: "changed" | "full" | "ranges";
  returnRanges?: Array<{ start: number; end?: number }>;
  edits: HashlineToolEdit[];
};

const ROOT_KEYS = new Set(["path", "returnMode", "returnRanges", "edits"]);
const ITEM_KEYS = new Set(["op", "pos", "end", "lines", "oldText", "newText", "symbol"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(request: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(request, key);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertEditRequest(request: unknown): asserts request is EditRequestParams {
  if (!isRecord(request)) {
    throw new Error("Edit request must be an object.");
  }

  const unknownRootKeys = Object.keys(request).filter((key) => !ROOT_KEYS.has(key));
  if (unknownRootKeys.length > 0) {
    throw new Error(`Edit request contains unknown fields: ${unknownRootKeys.join(", ")}.`);
  }

  if (typeof request["path"] !== "string" || (request["path"] as string).length === 0) {
    throw new Error('Edit request requires a non-empty "path" string.');
  }

  if (!Array.isArray(request["edits"]) || (request["edits"] as unknown[]).length === 0) {
    throw new Error('Edit request requires a non-empty "edits" array.');
  }

  if (hasOwn(request, "returnMode")) {
    const rm = request["returnMode"];
    if (rm !== "changed" && rm !== "full" && rm !== "ranges") {
      throw new Error('Edit request field "returnMode" must be "changed", "full", or "ranges".');
    }
  }

  if (hasOwn(request, "returnRanges")) {
    if (
      !Array.isArray(request["returnRanges"]) ||
      (request["returnRanges"] as unknown[]).length === 0
    ) {
      throw new Error('Edit request field "returnRanges" must be a non-empty array when provided.');
    }
    for (const [index, range] of (request["returnRanges"] as unknown[]).entries()) {
      if (!isRecord(range)) {
        throw new Error(`returnRanges[${index}] must be an object.`);
      }
      if (!Number.isInteger(range["start"]) || (range["start"] as number) < 1) {
        throw new Error(`returnRanges[${index}].start must be a positive integer.`);
      }
      if (hasOwn(range, "end")) {
        if (!Number.isInteger(range["end"]) || (range["end"] as number) < 1) {
          throw new Error(`returnRanges[${index}].end must be a positive integer when provided.`);
        }
        if ((range["end"] as number) < (range["start"] as number)) {
          throw new Error(`returnRanges[${index}].end must be >= start.`);
        }
      }
    }
  }

  if (request["returnMode"] === "ranges") {
    if (
      !Array.isArray(request["returnRanges"]) ||
      (request["returnRanges"] as unknown[]).length === 0
    ) {
      throw new Error(
        'Edit request with returnMode "ranges" requires a non-empty "returnRanges" array.',
      );
    }
  } else if (hasOwn(request, "returnRanges")) {
    throw new Error(
      'Edit request field "returnRanges" is only supported when returnMode is "ranges".',
    );
  }

  for (const [index, edit] of (request["edits"] as unknown[]).entries()) {
    if (!isRecord(edit)) {
      throw new Error(`Edit ${index} must be an object.`);
    }

    const unknownItemKeys = Object.keys(edit).filter((key) => !ITEM_KEYS.has(key));
    if (unknownItemKeys.length > 0) {
      throw new Error(`Edit ${index} contains unknown fields: ${unknownItemKeys.join(", ")}.`);
    }

    if (typeof edit["op"] !== "string") {
      throw new Error(`Edit ${index} requires an "op" string.`);
    }
    if (
      edit["op"] !== "replace" &&
      edit["op"] !== "append" &&
      edit["op"] !== "prepend" &&
      edit["op"] !== "replace_text" &&
      edit["op"] !== "replace_symbol"
    ) {
      throw new Error(`Edit ${index} uses unknown op "${edit["op"]}".`);
    }

    if (hasOwn(edit, "pos") && typeof edit["pos"] !== "string") {
      throw new Error(`Edit ${index} field "pos" must be a string.`);
    }
    if (hasOwn(edit, "end") && typeof edit["end"] !== "string") {
      throw new Error(`Edit ${index} field "end" must be a string.`);
    }
    if (hasOwn(edit, "oldText") && typeof edit["oldText"] !== "string") {
      throw new Error(`Edit ${index} field "oldText" must be a string.`);
    }
    if (hasOwn(edit, "newText") && typeof edit["newText"] !== "string") {
      throw new Error(`Edit ${index} field "newText" must be a string.`);
    }
    if (hasOwn(edit, "symbol") && typeof edit["symbol"] !== "string") {
      throw new Error(`Edit ${index} field "symbol" must be a string.`);
    }
    if (
      hasOwn(edit, "lines") &&
      edit["lines"] !== null &&
      typeof edit["lines"] !== "string" &&
      !isStringArray(edit["lines"])
    ) {
      throw new Error(`Edit ${index} field "lines" must be a string array, string, or null.`);
    }

    if (edit["op"] === "replace_text") {
      if (typeof edit["oldText"] !== "string" || typeof edit["newText"] !== "string") {
        throw new Error(`Edit ${index} with op "replace_text" requires "oldText" and "newText".`);
      }
      if (hasOwn(edit, "pos") || hasOwn(edit, "end") || hasOwn(edit, "lines")) {
        throw new Error(
          `Edit ${index} with op "replace_text" only supports "oldText" and "newText".`,
        );
      }
      continue;
    }

    if (edit["op"] === "replace_symbol") {
      if (typeof edit["symbol"] !== "string" || edit["symbol"].trim().length === 0) {
        throw new Error(`Edit ${index} with op "replace_symbol" requires a non-empty "symbol".`);
      }
      if (!hasOwn(edit, "lines")) {
        throw new Error(`Edit ${index} with op "replace_symbol" requires a "lines" field.`);
      }
      if (hasOwn(edit, "pos") || hasOwn(edit, "end") || hasOwn(edit, "oldText") || hasOwn(edit, "newText")) {
        throw new Error(`Edit ${index} with op "replace_symbol" only supports "symbol" and "lines".`);
      }
      continue;
    }

    if (!hasOwn(edit, "lines")) {
      throw new Error(`Edit ${index} requires a "lines" field.`);
    }
    if (hasOwn(edit, "oldText") || hasOwn(edit, "newText")) {
      throw new Error(
        `Edit ${index} with op "${edit["op"]}" does not support "oldText" or "newText".`,
      );
    }
    if (edit["op"] === "replace" && typeof edit["pos"] !== "string") {
      throw new Error(`Edit ${index} with op "replace" requires a "pos" anchor.`);
    }
    if ((edit["op"] === "append" || edit["op"] === "prepend") && hasOwn(edit, "end")) {
      throw new Error(`Edit ${index} with op "${edit["op"]}" does not support "end".`);
    }
  }
}

async function resolveStructuralEditOperations(params: {
  edits: HashlineToolEdit[];
  absolutePath: string;
  displayPath: string;
  content: string;
  totalBytes: number;
}): Promise<HashlineToolEdit[]> {
  if (!params.edits.some((edit) => edit.op === "replace_symbol")) {
    return params.edits;
  }

  const fileMap = await getCachedFileMap({
    filePath: params.absolutePath,
    content: params.content,
    totalBytes: params.totalBytes,
  });
  if (!fileMap || fileMap.symbols.length === 0) {
    throw new Error(`Symbol replacement is not available for ${params.displayPath}.`);
  }

  const contentLines = params.content.split("\n");
  return params.edits.map((edit) => {
    if (edit.op !== "replace_symbol") return edit;
    if (typeof edit.symbol !== "string") {
      throw new Error("replace_symbol requires a symbol field.");
    }

    const lookup = lookupSymbol(fileMap, edit.symbol);
    if (lookup.type !== "found") {
      throw new Error(formatSymbolLookupFailure(edit.symbol, lookup));
    }

    const startLine = lookup.symbol.startLine;
    const endLine = lookup.symbol.endLine;
    const startText = contentLines[startLine - 1] ?? "";
    const endText = contentLines[endLine - 1] ?? "";
    return {
      op: "replace",
      pos: `${startLine}#${computeLineHash(startLine, startText)}`,
      end: `${endLine}#${computeLineHash(endLine, endText)}`,
      lines: hashlineParseText(edit.lines ?? null),
    };
  });
}

export function registerEditTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "Edit",
    description: `Patch a UTF-8 text file using LINE#HASH anchors copied verbatim from read.

Submit one edit call per file. All operations for that file go in a single edits array; anchors within one call must all come from the same pre-edit read.

Ops:
- replace — replace the line at pos, or the inclusive range pos..end, with lines.
- append — insert lines after pos; omit pos to append at EOF.
- prepend — insert lines before pos; omit pos to insert at BOF.
- replace_text — replace the one exact unique occurrence of oldText with newText. Only when a match is guaranteed unique; otherwise read first and use anchors.
- replace_symbol — replace a mapped symbol by name with lines. Use symbol names from read map output.

Example:
{ "path": "src/main.ts", "edits": [
  { "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] }
] }

Rules:
- lines is literal file content: no LINE#HASH: prefix, no leading +/-. Match indentation exactly.
- Do not guess, shift, or construct anchors. Copy them from the most recent read of this file.
- Do not emit overlapping or adjacent edits — merge them into one.

On success (changed mode, default) the returned text is an --- Anchors A-B --- block with fresh LINE#HASH lines for the changed region. Use those for nearby follow-up edits in the same file without re-reading. For distant follow-ups, or on any error, call read again.

Errors come back as text starting with a bracketed code (e.g. [E_STALE_ANCHOR], [E_INVALID_PATCH], [E_NO_MATCH]). The message is self-describing and tells you what to retry; stale-anchor errors include the current >>> LINE#HASH: lines, ready to copy.`,
    promptSnippet: EDIT_PROMPT_SNIPPET,
    promptGuidelines: EDIT_PROMPT_GUIDELINES,
    parameters: hashlineEditToolSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertEditRequest(params);

      const normalizedParams = params as EditRequestParams;
      const absolutePath = resolveToCwd(normalizedParams.path, ctx.cwd);
      const toolEdits = normalizedParams.edits as HashlineToolEdit[];

      return withFileMutationQueue(absolutePath, async () => {
        throwIfAborted(signal);

        try {
          await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
        } catch (error: unknown) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") throw new Error(`File not found: ${normalizedParams.path}`);
          if (code === "EACCES" || code === "EPERM")
            throw new Error(`File is not writable: ${normalizedParams.path}`);
          throw new Error(`Cannot access file: ${normalizedParams.path}`);
        }

        throwIfAborted(signal);
        const file = await loadFileKindAndText(absolutePath);
        if (file.kind === "directory")
          throw new Error(`Path is a directory: ${normalizedParams.path}.`);
        if (file.kind === "image") throw new Error(`Path is an image: ${normalizedParams.path}.`);
        if (file.kind === "binary")
          throw new Error(`Path is a binary file: ${normalizedParams.path} (${file.description}).`);

        throwIfAborted(signal);
        const { bom, text: content } = stripBom(file.text);
        const originalEnding = detectLineEnding(content);
        const originalNormalized = normalizeToLF(content);

        const structuralEdits = await resolveStructuralEditOperations({
          edits: toolEdits,
          absolutePath,
          displayPath: normalizedParams.path,
          content: originalNormalized,
          totalBytes: Buffer.byteLength(file.text, "utf8"),
        });
        const resolved = resolveEditAnchors(structuralEdits);
        const editResult = applyHashlineEdits(originalNormalized, resolved, signal);
        const { content: result, firstChangedLine, lastChangedLine } = editResult;

        if (originalNormalized === result) {
          const noopSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;
          return buildNoopResponse({
            path: normalizedParams.path,
            snapshotId: noopSnapshotId,
            noopEdits: editResult.noopEdits,
          });
        }

        throwIfAborted(signal);
        await writeFileAtomically(absolutePath, bom + restoreLineEndings(result, originalEnding));
        const updatedSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;

        return buildChangedResponse({
          path: normalizedParams.path,
          originalNormalized,
          result,
          firstChangedLine,
          lastChangedLine,
          snapshotId: updatedSnapshotId,
          warnings: editResult.warnings,
          compatibilityDetails: undefined,
        });
      });
    },
  });
}
