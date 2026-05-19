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
import { buildSyntaxRegressionWarning } from "../shared/syntax";
const EDIT_PROMPT_SNIPPET = `Edit a text file via LINE#HASH anchors copied from read`;

const EDIT_PROMPT_GUIDELINES = [
  "Always read a file before editing it to get current LINE#HASH anchors.",
  "Every item in edits should include an op: replace, append, prepend, replace_text, or replace_symbol.",
  "For exact text replacement, use op=replace_text with both oldText and newText; do not send oldText/newText by themselves.",
  "Copy anchors verbatim from read output — do not guess, renumber, shift, or construct anchors.",
  "Submit all edits for one file in a single edits array.",
  "Use replace_text only when a match is guaranteed unique; otherwise read first and use anchors.",
  "Use edit for file modifications instead of shell sed -i, perl -pi, or ad-hoc rewrite scripts.",
  "If an edit call fails before success output, treat the entire call as unapplied; reread and retry with fresh anchors.",
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
    op: Type.Optional(
      Type.String({
        description:
          'Required edit operation: "replace", "append", "prepend", "replace_text", or "replace_symbol"',
      }),
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

type CanonicalEditOp = "replace" | "append" | "prepend" | "replace_text" | "replace_symbol";

type EditRequestParams = {
  path: string;
  returnMode?: "changed" | "full" | "ranges";
  returnRanges?: Array<{ start: number; end?: number }>;
  edits: HashlineToolEdit[];
};

type RawHashlineToolEdit = {
  op?: string;
  pos?: string;
  end?: string;
  lines?: string[] | string | null;
  oldText?: string;
  newText?: string;
  symbol?: string;
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

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  message: string,
  options: { trim?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  if (!hasOwn(source, key)) return undefined;
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(message);
  }
  const finalValue = options.trim === true ? value.trim() : value;
  if (options.allowEmpty === false && finalValue.length === 0) {
    throw new Error(message.replace("must be a string", "must be a non-empty string"));
  }
  return finalValue;
}

function readOptionalLines(
  source: Record<string, unknown>,
  index: number,
): string[] | string | null | undefined {
  if (!hasOwn(source, "lines")) return undefined;
  const value = source["lines"];
  if (value !== null && typeof value !== "string" && !isStringArray(value)) {
    throw new Error(`Edit ${index} field "lines" must be a string array, string, or null.`);
  }
  return value;
}

function normalizeOperationKey(op: string): string {
  return op.trim().replaceAll("-", "_").replaceAll(" ", "_").toLowerCase();
}

function isDeleteOperationAlias(op: string): boolean {
  const key = normalizeOperationKey(op);
  return key === "delete" || key === "remove";
}

function normalizeExplicitOperation(op: string, index: number): CanonicalEditOp {
  const normalized = op.trim();
  if (normalized.length === 0) {
    throw new Error(`Edit ${index} requires a non-empty "op" string.`);
  }

  const key = normalizeOperationKey(normalized);
  if (key === "replacetext") return "replace_text";
  if (key === "replace_symbol" || key === "replacesymbol") return "replace_symbol";
  if (key === "delete" || key === "remove") return "replace";
  if (key === "replace" || key === "append" || key === "prepend" || key === "replace_text") {
    return key;
  }

  throw new Error(
    `Edit ${index} uses unknown op "${op}". Expected "replace", "append", "prepend", "replace_text", or "replace_symbol".`,
  );
}

function inferMissingOperation(edit: RawHashlineToolEdit, index: number): CanonicalEditOp {
  const hasExactTextFields = edit.oldText !== undefined || edit.newText !== undefined;
  if (hasExactTextFields) {
    if (edit.oldText !== undefined && edit.newText !== undefined) {
      return "replace_text";
    }
    throw new Error(
      `Edit ${index} omits "op" and has an incomplete exact text replacement. Use { "op": "replace_text", "oldText": "...", "newText": "..." }.`,
    );
  }

  if (edit.symbol !== undefined) {
    return "replace_symbol";
  }

  if (edit.pos !== undefined && edit.lines !== undefined) {
    return "replace";
  }

  throw new Error(
    `Edit ${index} requires an "op" field. Use "replace" with pos/lines, "append" or "prepend" with lines, "replace_text" with oldText/newText, or "replace_symbol" with symbol/lines.`,
  );
}

function buildRawEditItem(edit: Record<string, unknown>, index: number): RawHashlineToolEdit {
  const raw: RawHashlineToolEdit = {};
  const op = readOptionalString(edit, "op", `Edit ${index} field "op" must be a string.`, {
    trim: true,
    allowEmpty: false,
  });
  const pos = readOptionalString(edit, "pos", `Edit ${index} field "pos" must be a string.`);
  const end = readOptionalString(edit, "end", `Edit ${index} field "end" must be a string.`);
  const oldText = readOptionalString(
    edit,
    "oldText",
    `Edit ${index} field "oldText" must be a string.`,
  );
  const newText = readOptionalString(
    edit,
    "newText",
    `Edit ${index} field "newText" must be a string.`,
  );
  const symbol = readOptionalString(
    edit,
    "symbol",
    `Edit ${index} field "symbol" must be a string.`,
  );
  const lines = readOptionalLines(edit, index);

  if (op !== undefined) raw.op = op;
  if (pos !== undefined) raw.pos = pos;
  if (end !== undefined) raw.end = end;
  if (oldText !== undefined) raw.oldText = oldText;
  if (newText !== undefined) raw.newText = newText;
  if (symbol !== undefined) raw.symbol = symbol;
  if (lines !== undefined) raw.lines = lines;
  return raw;
}

function normalizeEditItem(edit: Record<string, unknown>, index: number): HashlineToolEdit {
  const unknownItemKeys = Object.keys(edit).filter((key) => !ITEM_KEYS.has(key));
  if (unknownItemKeys.length > 0) {
    throw new Error(`Edit ${index} contains unknown fields: ${unknownItemKeys.join(", ")}.`);
  }

  const raw = buildRawEditItem(edit, index);
  const deleteAlias = raw.op !== undefined && isDeleteOperationAlias(raw.op);
  const op =
    raw.op === undefined
      ? inferMissingOperation(raw, index)
      : normalizeExplicitOperation(raw.op, index);

  if (op === "replace_text") {
    if (typeof raw.oldText !== "string" || typeof raw.newText !== "string") {
      throw new Error(`Edit ${index} with op "replace_text" requires "oldText" and "newText".`);
    }
    if (
      raw.pos !== undefined ||
      raw.end !== undefined ||
      raw.lines !== undefined ||
      raw.symbol !== undefined
    ) {
      throw new Error(
        `Edit ${index} with op "replace_text" only supports "oldText" and "newText".`,
      );
    }
    return { op, oldText: raw.oldText, newText: raw.newText };
  }

  if (op === "replace_symbol") {
    if (typeof raw.symbol !== "string" || raw.symbol.trim().length === 0) {
      throw new Error(`Edit ${index} with op "replace_symbol" requires a non-empty "symbol".`);
    }
    if (raw.lines === undefined) {
      throw new Error(`Edit ${index} with op "replace_symbol" requires a "lines" field.`);
    }
    if (
      raw.pos !== undefined ||
      raw.end !== undefined ||
      raw.oldText !== undefined ||
      raw.newText !== undefined
    ) {
      throw new Error(`Edit ${index} with op "replace_symbol" only supports "symbol" and "lines".`);
    }
    return { op, symbol: raw.symbol, lines: raw.lines };
  }

  if (deleteAlias && raw.lines !== undefined && raw.lines !== null) {
    if (!Array.isArray(raw.lines) || raw.lines.length > 0) {
      throw new Error(
        `Edit ${index} with op "${raw.op}" removes content and does not accept replacement lines.`,
      );
    }
  }
  if (raw.lines === undefined) {
    if (deleteAlias && op === "replace") {
      raw.lines = null;
    } else {
      throw new Error(`Edit ${index} with op "${op}" requires a "lines" field.`);
    }
  }
  if (raw.oldText !== undefined || raw.newText !== undefined) {
    throw new Error(`Edit ${index} with op "${op}" does not support "oldText" or "newText".`);
  }
  if (raw.symbol !== undefined) {
    throw new Error(`Edit ${index} with op "${op}" does not support "symbol".`);
  }
  if (op === "replace" && typeof raw.pos !== "string") {
    throw new Error(`Edit ${index} with op "replace" requires a "pos" anchor.`);
  }
  if ((op === "append" || op === "prepend") && raw.end !== undefined) {
    throw new Error(`Edit ${index} with op "${op}" does not support "end".`);
  }

  return {
    op,
    ...(raw.pos !== undefined ? { pos: raw.pos } : {}),
    ...(raw.end !== undefined ? { end: raw.end } : {}),
    lines: raw.lines,
  };
}

function normalizeReturnRanges(
  request: Record<string, unknown>,
): Array<{ start: number; end?: number }> | undefined {
  if (!hasOwn(request, "returnRanges")) return undefined;
  const ranges = request["returnRanges"];
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error('Edit request field "returnRanges" must be a non-empty array when provided.');
  }

  return ranges.map((range, index) => {
    if (!isRecord(range)) {
      throw new Error(`returnRanges[${index}] must be an object.`);
    }
    const startValue = range["start"];
    if (typeof startValue !== "number" || !Number.isInteger(startValue) || startValue < 1) {
      throw new Error(`returnRanges[${index}].start must be a positive integer.`);
    }
    const endValue = range["end"];
    if (endValue !== undefined) {
      if (typeof endValue !== "number" || !Number.isInteger(endValue) || endValue < 1) {
        throw new Error(`returnRanges[${index}].end must be a positive integer when provided.`);
      }
      if (endValue < startValue) {
        throw new Error(`returnRanges[${index}].end must be >= start.`);
      }
      return { start: startValue, end: endValue };
    }
    return { start: startValue };
  });
}

export function parseEditRequest(request: unknown): EditRequestParams {
  if (!isRecord(request)) {
    throw new Error("Edit request must be an object.");
  }

  const unknownRootKeys = Object.keys(request).filter((key) => !ROOT_KEYS.has(key));
  if (unknownRootKeys.length > 0) {
    throw new Error(`Edit request contains unknown fields: ${unknownRootKeys.join(", ")}.`);
  }

  const path = request["path"];
  if (typeof path !== "string" || path.length === 0) {
    throw new Error('Edit request requires a non-empty "path" string.');
  }

  const editsInput = request["edits"];
  if (!Array.isArray(editsInput) || editsInput.length === 0) {
    throw new Error('Edit request requires a non-empty "edits" array.');
  }

  const returnModeInput = request["returnMode"];
  const returnMode =
    returnModeInput === undefined
      ? undefined
      : returnModeInput === "changed" || returnModeInput === "full" || returnModeInput === "ranges"
        ? returnModeInput
        : undefined;
  if (hasOwn(request, "returnMode") && returnMode === undefined) {
    throw new Error('Edit request field "returnMode" must be "changed", "full", or "ranges".');
  }

  const returnRanges = normalizeReturnRanges(request);
  if (returnMode === "ranges") {
    if (returnRanges === undefined) {
      throw new Error(
        'Edit request with returnMode "ranges" requires a non-empty "returnRanges" array.',
      );
    }
  } else if (returnRanges !== undefined) {
    throw new Error(
      'Edit request field "returnRanges" is only supported when returnMode is "ranges".',
    );
  }

  const edits = editsInput.map((edit, index) => {
    if (!isRecord(edit)) {
      throw new Error(`Edit ${index} must be an object.`);
    }
    return normalizeEditItem(edit, index);
  });

  return {
    path,
    ...(returnMode !== undefined ? { returnMode } : {}),
    ...(returnRanges !== undefined ? { returnRanges } : {}),
    edits,
  };
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
- replace — replace the line at pos, or the inclusive range pos..end, with lines. Use lines:null or lines:[] to delete.
- append — insert lines after pos; omit pos to append at EOF.
- prepend — insert lines before pos; omit pos to insert at BOF.
- replace_text — replace the one exact unique occurrence of oldText with newText. Only when a match is guaranteed unique; otherwise read first and use anchors.
- replace_symbol — replace a mapped symbol by name with lines. Use symbol names from read map output.

Example:
{ "path": "src/main.ts", "edits": [
  { "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] }
] }

Rules:
- Every edit object must include op. Do not send oldText/newText alone; use op:"replace_text".
- lines is literal file content: no LINE#HASH: prefix, no leading +/-. Match indentation exactly.
- Do not guess, shift, or construct anchors. Copy them from the most recent read of this file.
- Do not emit overlapping or adjacent edits — merge them into one.
- Failed validation/stale-anchor/conflict responses are atomic: no file changes are written before success output.

On success (changed mode, default) the returned text is an --- Anchors A-B --- block with fresh LINE#HASH lines for the changed region. Use those for nearby follow-up edits in the same file without re-reading. For distant follow-ups, or on any error, call read again.

Errors come back as text starting with a bracketed code (e.g. [E_STALE_ANCHOR], [E_INVALID_PATCH], [E_NO_MATCH]). The message is self-describing and tells you what to retry; stale-anchor errors include the current >>> LINE#HASH: lines, ready to copy.`,
    promptSnippet: EDIT_PROMPT_SNIPPET,
    promptGuidelines: EDIT_PROMPT_GUIDELINES,
    parameters: hashlineEditToolSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const normalizedParams = parseEditRequest(params);
      const absolutePath = resolveToCwd(normalizedParams.path, ctx.cwd);
      const toolEdits = normalizedParams.edits;

      return withFileMutationQueue(absolutePath, async () => {
        throwIfAborted(signal);

        try {
          await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
        } catch (error: unknown) {
          const code =
            isRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined;
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
        const syntaxWarning = buildSyntaxRegressionWarning({
          filePath: absolutePath,
          before: originalNormalized,
          after: result,
        });
        const editWarnings = editResult.warnings ?? [];
        const warnings = syntaxWarning === null ? editWarnings : [...editWarnings, syntaxWarning];

        await writeFileAtomically(absolutePath, bom + restoreLineEndings(result, originalEnding));
        const updatedSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;

        return buildChangedResponse({
          path: normalizedParams.path,
          originalNormalized,
          result,
          firstChangedLine,
          lastChangedLine,
          snapshotId: updatedSnapshotId,
          warnings,
          compatibilityDetails: undefined,
          returnMode: normalizedParams.returnMode ?? "changed",
          returnRanges: normalizedParams.returnRanges,
        });
      });
    },
  });
}
