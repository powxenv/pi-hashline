import { generateDiffString } from "../hashline/diff";
import { computeAffectedLineRange, formatHashlineRegion } from "../hashline/engine";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
};

type ReturnMode = "changed" | "full" | "ranges";

type ReturnRange = { start: number; end?: number };

const ANCHOR_TEXT_BUDGET_BYTES = 50 * 1024;

function getVisibleLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function formatAnchorsBlock(lines: string[], start: number, end: number): string {
  const region = lines.slice(start - 1, end);
  const formatted = formatHashlineRegion(region, start);
  return `--- Anchors ${start}-${end} ---\n${formatted}`;
}

function formatFullAnchors(lines: string[]): string {
  if (lines.length === 0) {
    return "File is empty. Use edit with prepend or append and omit pos to insert content.";
  }
  return formatAnchorsBlock(lines, 1, lines.length);
}

function formatRangeAnchors(lines: string[], ranges: ReturnRange[] | undefined): string {
  if (lines.length === 0) {
    return "File is empty. Use edit with prepend or append and omit pos to insert content.";
  }
  if (!ranges?.length) {
    return "No return ranges provided. Use returnRanges with returnMode=ranges.";
  }
  return ranges
    .map((range) => {
      if (range.start > lines.length) {
        const requestedEnd = range.end ?? range.start;
        return `--- Anchors ${range.start}-${requestedEnd} ---\n[Range starts beyond end of file (${lines.length} lines).]`;
      }
      const end = Math.min(range.end ?? range.start, lines.length);
      return formatAnchorsBlock(lines, range.start, end);
    })
    .join("\n\n");
}

function formatChangedAnchors(params: {
  lines: string[];
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
}): string {
  if (params.lines.length === 0) {
    return "File is empty. Use edit with prepend or append and omit pos to insert content.";
  }
  const anchorRange = computeAffectedLineRange({
    firstChangedLine: params.firstChangedLine,
    lastChangedLine: params.lastChangedLine,
    resultLineCount: params.lines.length,
  });
  if (!anchorRange) {
    return "Anchors omitted; use read for subsequent edits.";
  }
  return formatAnchorsBlock(params.lines, anchorRange.start, anchorRange.end);
}

function formatResponseAnchors(params: {
  mode: ReturnMode;
  lines: string[];
  ranges: ReturnRange[] | undefined;
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
}): string {
  const block =
    params.mode === "full"
      ? formatFullAnchors(params.lines)
      : params.mode === "ranges"
        ? formatRangeAnchors(params.lines, params.ranges)
        : formatChangedAnchors({
            lines: params.lines,
            firstChangedLine: params.firstChangedLine,
            lastChangedLine: params.lastChangedLine,
          });

  return Buffer.byteLength(block, "utf8") <= ANCHOR_TEXT_BUDGET_BYTES
    ? block
    : "Anchors omitted because the requested response is too large; use read with offset/limit for subsequent edits.";
}

export function buildNoopResponse(params: {
  path: string;
  snapshotId: string;
  noopEdits: Array<{ editIndex: number; loc: string; currentContent: string }> | undefined;
}): ToolResult {
  const noopText = params.noopEdits?.length
    ? params.noopEdits
        .map((e) => `Edit ${e.editIndex}: replacement for ${e.loc} is identical to current content`)
        .join("\n")
    : "The edits produced identical content.";

  return {
    content: [{ type: "text", text: `No changes made to ${params.path}\n${noopText}` }],
    details: {
      diff: "",
      firstChangedLine: undefined,
      snapshotId: params.snapshotId,
      classification: "noop",
    },
  };
}

export function buildChangedResponse(params: {
  path: string;
  originalNormalized: string;
  result: string;
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
  snapshotId: string;
  warnings: string[] | undefined;
  compatibilityDetails: Record<string, unknown> | undefined;
  returnMode: ReturnMode;
  returnRanges: ReturnRange[] | undefined;
}): ToolResult {
  const diffResult = generateDiffString(params.originalNormalized, params.result);
  const resultLines = getVisibleLines(params.result);
  const anchorsBlock = formatResponseAnchors({
    mode: params.returnMode,
    lines: resultLines,
    ranges: params.returnRanges,
    firstChangedLine: params.firstChangedLine,
    lastChangedLine: params.lastChangedLine,
  });
  const warningsBlock = params.warnings?.length
    ? `\n\nWarnings:\n${params.warnings.join("\n")}`
    : "";
  const text = `${anchorsBlock}${warningsBlock}`;

  return {
    content: [{ type: "text", text }],
    details: {
      diff: diffResult.diff,
      firstChangedLine: params.firstChangedLine ?? diffResult.firstChangedLine,
      snapshotId: params.snapshotId,
      ...(params.compatibilityDetails ? { compatibility: params.compatibilityDetails } : {}),
      metrics: {
        classification: "applied" as const,
        return_mode: params.returnMode,
        added_lines: countDiffLines(diffResult.diff, "+"),
        removed_lines: countDiffLines(diffResult.diff, "-"),
      },
    },
  };
}

function countDiffLines(diff: string, marker: "+" | "-"): number {
  if (!diff) return 0;
  let count = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith(marker) && !line.startsWith(`${marker}${marker}${marker}`)) {
      count += 1;
    }
  }
  return count;
}
