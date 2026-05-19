import type { FileMap, FileSymbol } from "./types";

export type SymbolLookupResult =
  | { type: "found"; symbol: FileSymbol; qualifiedName: string }
  | { type: "ambiguous"; matches: Array<{ symbol: FileSymbol; qualifiedName: string }> }
  | { type: "not-found"; candidates: Array<{ symbol: FileSymbol; qualifiedName: string }> };

type IndexedSymbol = {
  symbol: FileSymbol;
  qualifiedName: string;
  searchNames: string[];
};

function parseQuery(query: string): { name: string; line?: number } {
  const trimmed = query.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return { name: trimmed };
  }

  const line = Number.parseInt(trimmed.slice(atIndex + 1), 10);
  if (!Number.isInteger(line) || line < 1) {
    return { name: trimmed };
  }

  return { name: trimmed.slice(0, atIndex), line };
}

function indexSymbols(symbols: FileSymbol[], parentName?: string): IndexedSymbol[] {
  const indexed: IndexedSymbol[] = [];

  for (const symbol of symbols) {
    const qualifiedName = parentName ? `${parentName}.${symbol.name}` : symbol.name;
    indexed.push({
      symbol,
      qualifiedName,
      searchNames: [symbol.name, qualifiedName],
    });

    if (symbol.children?.length) {
      indexed.push(...indexSymbols(symbol.children, qualifiedName));
    }
  }

  return indexed;
}

function lineMatches(symbol: FileSymbol, line: number | undefined): boolean {
  return (
    line === undefined ||
    symbol.startLine === line ||
    (line >= symbol.startLine && line <= symbol.endLine)
  );
}

function scoreCandidate(candidate: IndexedSymbol, query: string): number {
  const normalizedQuery = query.toLowerCase();
  const normalizedName = candidate.symbol.name.toLowerCase();
  const normalizedQualifiedName = candidate.qualifiedName.toLowerCase();

  if (normalizedName === normalizedQuery || normalizedQualifiedName === normalizedQuery) return 0;
  if (normalizedQualifiedName.endsWith(`.${normalizedQuery}`)) return 1;
  if (normalizedName.includes(normalizedQuery)) return 2;
  if (normalizedQualifiedName.includes(normalizedQuery)) return 3;
  return 4;
}

export function lookupSymbol(fileMap: FileMap, query: string): SymbolLookupResult {
  const parsed = parseQuery(query);
  if (parsed.name.length === 0) {
    return { type: "not-found", candidates: [] };
  }

  const indexed = indexSymbols(fileMap.symbols);
  const exactMatches = indexed.filter(
    (candidate) =>
      candidate.searchNames.some((name) => name === parsed.name) &&
      lineMatches(candidate.symbol, parsed.line),
  );

  if (exactMatches.length === 1) {
    const match = exactMatches[0]!;
    return { type: "found", symbol: match.symbol, qualifiedName: match.qualifiedName };
  }

  if (exactMatches.length > 1) {
    return { type: "ambiguous", matches: exactMatches };
  }

  const lowerQuery = parsed.name.toLowerCase();
  const fuzzyMatches = indexed
    .filter(
      (candidate) =>
        candidate.searchNames.some((name) => name.toLowerCase().includes(lowerQuery)) &&
        lineMatches(candidate.symbol, parsed.line),
    )
    .sort((left, right) => scoreCandidate(left, parsed.name) - scoreCandidate(right, parsed.name));

  if (fuzzyMatches.length === 1) {
    const match = fuzzyMatches[0]!;
    return { type: "found", symbol: match.symbol, qualifiedName: match.qualifiedName };
  }

  if (
    fuzzyMatches.length > 1 &&
    scoreCandidate(fuzzyMatches[0]!, parsed.name) < scoreCandidate(fuzzyMatches[1]!, parsed.name)
  ) {
    const match = fuzzyMatches[0]!;
    return { type: "found", symbol: match.symbol, qualifiedName: match.qualifiedName };
  }

  if (fuzzyMatches.length > 1) {
    return { type: "ambiguous", matches: fuzzyMatches.slice(0, 12) };
  }

  return { type: "not-found", candidates: indexed.slice(0, 12) };
}

export function formatSymbolLookupFailure(
  query: string,
  result: Exclude<SymbolLookupResult, { type: "found" }>,
): string {
  if (result.type === "ambiguous") {
    const lines = result.matches.map(
      (match) =>
        `${match.qualifiedName} (${match.symbol.kind}, lines ${match.symbol.startLine}-${match.symbol.endLine})`,
    );
    return `Symbol "${query}" is ambiguous. Use a qualified name or append @line.\n${lines.join("\n")}`;
  }

  if (result.candidates.length === 0) {
    return `Symbol "${query}" was not found.`;
  }

  const lines = result.candidates.map(
    (candidate) =>
      `${candidate.qualifiedName} (${candidate.symbol.kind}, lines ${candidate.symbol.startLine}-${candidate.symbol.endLine})`,
  );
  return `Symbol "${query}" was not found. Available symbols include:\n${lines.join("\n")}`;
}
