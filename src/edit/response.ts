import { generateDiffString } from "../hashline/diff";
import { computeAffectedLineRange, formatHashlineRegion } from "../hashline/engine";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
};

function getVisibleLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
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
}): ToolResult {
  const CHANGED_ANCHOR_TEXT_BUDGET_BYTES = 50 * 1024;
  const diffResult = generateDiffString(params.originalNormalized, params.result);
  const resultLines = getVisibleLines(params.result);
  const anchorRange = computeAffectedLineRange({
    firstChangedLine: params.firstChangedLine,
    lastChangedLine: params.lastChangedLine,
    resultLineCount: resultLines.length,
  });

  let anchorsBlock: string;
  if (anchorRange) {
    const region = resultLines.slice(anchorRange.start - 1, anchorRange.end);
    const formatted = formatHashlineRegion(region, anchorRange.start);
    const block = `--- Anchors ${anchorRange.start}-${anchorRange.end} ---\n${formatted}`;
    anchorsBlock =
      Buffer.byteLength(block, "utf8") <= CHANGED_ANCHOR_TEXT_BUDGET_BYTES
        ? block
        : "Anchors omitted; use read for subsequent edits.";
  } else if (resultLines.length === 0) {
    anchorsBlock = "File is empty. Use edit with prepend or append and omit pos to insert content.";
  } else {
    anchorsBlock = "Anchors omitted; use read for subsequent edits.";
  }

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
        return_mode: "changed" as const,
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
