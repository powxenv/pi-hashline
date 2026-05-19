import { parseSync } from "oxc-parser";
import { extname } from "node:path";

type SyntaxValidationResult =
  | { kind: "unsupported" }
  | { kind: "valid" }
  | { kind: "invalid"; errorCount: number; firstMessage: string };

type OxcLanguage = "ts" | "tsx" | "js" | "jsx" | "dts";

function getOxcLanguage(filePath: string): OxcLanguage | null {
  if (filePath.endsWith(".d.ts")) return "dts";
  switch (extname(filePath).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".jsx":
      return "jsx";
    default:
      return null;
  }
}

function formatFirstMessage(message: string): string {
  const firstLine = message.split("\n")[0]?.trim() ?? "syntax error";
  return firstLine.length > 0 ? firstLine : "syntax error";
}

function validateOxcSyntax(filePath: string, content: string): SyntaxValidationResult {
  const lang = getOxcLanguage(filePath);
  if (lang === null) return { kind: "unsupported" };

  try {
    const result = parseSync(filePath, content, {
      lang,
      sourceType: "module",
      astType: lang === "js" || lang === "jsx" ? "js" : "ts",
      range: false,
    });
    const errors = result.errors;
    if (errors.length === 0) return { kind: "valid" };
    const first = errors[0];
    return {
      kind: "invalid",
      errorCount: errors.length,
      firstMessage: formatFirstMessage(first?.message ?? "syntax error"),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "syntax parser failed";
    return { kind: "invalid", errorCount: 1, firstMessage: formatFirstMessage(message) };
  }
}

export function buildSyntaxRegressionWarning(params: {
  filePath: string;
  before: string;
  after: string;
}): string | null {
  const before = validateOxcSyntax(params.filePath, params.before);
  const after = validateOxcSyntax(params.filePath, params.after);
  if (after.kind !== "invalid") return null;
  if (before.kind === "unsupported") return null;
  if (before.kind === "valid") {
    return `Syntax validation warning: edited file now has ${after.errorCount} parse error(s); first: ${after.firstMessage}`;
  }
  if (after.errorCount > before.errorCount) {
    return `Syntax validation warning: parse errors increased from ${before.errorCount} to ${after.errorCount}; first: ${after.firstMessage}`;
  }
  return null;
}
