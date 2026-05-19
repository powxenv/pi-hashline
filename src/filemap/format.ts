import { basename } from "node:path";
import type { FileMap, FileSymbol } from "./types";

const BOX_LINE = "───────────────────────────────────────";
const MAX_MAP_BYTES = 25 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSymbol(symbol: FileSymbol, indent: number): string {
  const prefix = "  ".repeat(indent);
  const lineRange =
    symbol.startLine === symbol.endLine
      ? `[${symbol.startLine}]`
      : `[${symbol.startLine}-${symbol.endLine}]`;

  let display = symbol.name;
  if (symbol.signature) {
    if (symbol.kind === "function" || symbol.kind === "method") {
      display = symbol.signature.includes(symbol.name)
        ? symbol.signature
        : `${symbol.name}${symbol.signature}`;
    } else if (symbol.kind === "heading") {
      display = symbol.signature;
    }
  }

  const mods = symbol.modifiers?.length ? `${symbol.modifiers.join(" ")} ` : "";
  return `${prefix}${mods}${display}: ${lineRange}`;
}

function formatSymbols(symbols: FileSymbol[], indent: number): string[] {
  const lines: string[] = [];
  for (const symbol of symbols) {
    lines.push(formatSymbol(symbol, indent));
    if (symbol.children?.length) {
      lines.push(...formatSymbols(symbol.children, indent + 1));
    }
  }
  return lines;
}

export function formatFileMap(fileMap: FileMap): string {
  const fileName = basename(fileMap.path);
  const lines: string[] = [
    "",
    BOX_LINE,
    `File Map: ${fileName}`,
    `${fileMap.totalLines} lines │ ${formatSize(fileMap.totalBytes)} │ ${fileMap.language}`,
    BOX_LINE,
    "",
  ];

  const symbolLines = formatSymbols(fileMap.symbols, 0);
  lines.push(...symbolLines);

  lines.push("");
  lines.push(BOX_LINE);
  lines.push("Use read(path, offset=LINE, limit=N) for targeted reads.");
  lines.push(BOX_LINE);

  const result = lines.join("\n");

  if (Buffer.byteLength(result, "utf8") > MAX_MAP_BYTES) {
    const outline = formatOutlineMap(fileMap);
    if (Buffer.byteLength(outline, "utf8") <= MAX_MAP_BYTES) {
      return outline;
    }
    return formatMinimalMap(fileMap);
  }

  return result;
}

function formatOutlineMap(fileMap: FileMap): string {
  const fileName = basename(fileMap.path);
  const lines: string[] = [
    "",
    BOX_LINE,
    `File Map: ${fileName}`,
    `${fileMap.totalLines} lines │ ${formatSize(fileMap.totalBytes)} │ ${fileMap.language}`,
    BOX_LINE,
    "[outline]",
    "",
  ];

  for (const symbol of fileMap.symbols) {
    const lineRange =
      symbol.startLine === symbol.endLine
        ? `[${symbol.startLine}]`
        : `[${symbol.startLine}-${symbol.endLine}]`;
    lines.push(`${symbol.kind} ${symbol.name}: ${lineRange}`);
  }

  lines.push("");
  lines.push(BOX_LINE);
  lines.push("Use read(path, offset=LINE, limit=N) for targeted reads.");
  lines.push(BOX_LINE);

  return lines.join("\n");
}

function formatMinimalMap(fileMap: FileMap): string {
  const fileName = basename(fileMap.path);
  const maxSymbols = 50;
  const symbols = fileMap.symbols.slice(0, maxSymbols);
  const hasMore = fileMap.symbols.length > maxSymbols;

  const lines: string[] = [
    "",
    BOX_LINE,
    `File Map: ${fileName}`,
    `${fileMap.totalLines} lines │ ${formatSize(fileMap.totalBytes)} │ ${fileMap.language}`,
    BOX_LINE,
    "",
  ];

  for (const symbol of symbols) {
    const lineRange =
      symbol.startLine === symbol.endLine
        ? `[${symbol.startLine}]`
        : `[${symbol.startLine}-${symbol.endLine}]`;
    lines.push(`${symbol.name}: ${lineRange}`);
  }

  if (hasMore) {
    lines.push(`... ${fileMap.symbols.length - maxSymbols} more symbols`);
  }

  lines.push("");
  lines.push(BOX_LINE);
  lines.push("Use read(path, offset=LINE, limit=N) for targeted reads.");
  lines.push(BOX_LINE);

  return lines.join("\n");
}
