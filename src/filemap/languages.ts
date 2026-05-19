import { extname } from "node:path";

export interface LanguageInfo {
  id: string;
  name: string;
}

const EXTENSION_MAP: Record<string, LanguageInfo> = {
  ".py": { id: "python", name: "Python" },
  ".pyw": { id: "python", name: "Python" },
  ".pyi": { id: "python", name: "Python" },
  ".ts": { id: "typescript", name: "TypeScript" },
  ".tsx": { id: "typescript", name: "TypeScript" },
  ".mts": { id: "typescript", name: "TypeScript" },
  ".cts": { id: "typescript", name: "TypeScript" },
  ".js": { id: "javascript", name: "JavaScript" },
  ".jsx": { id: "javascript", name: "JavaScript" },
  ".mjs": { id: "javascript", name: "JavaScript" },
  ".cjs": { id: "javascript", name: "JavaScript" },
  ".go": { id: "go", name: "Go" },
  ".rs": { id: "rust", name: "Rust" },
  ".c": { id: "c", name: "C" },
  ".h": { id: "c", name: "C Header" },
  ".cpp": { id: "cpp", name: "C++" },
  ".cc": { id: "cpp", name: "C++" },
  ".cxx": { id: "cpp", name: "C++" },
  ".hpp": { id: "cpp", name: "C++" },
  ".hxx": { id: "cpp", name: "C++" },
  ".sql": { id: "sql", name: "SQL" },
  ".json": { id: "json", name: "JSON" },
  ".jsonc": { id: "json", name: "JSON" },
  ".jsonl": { id: "jsonl", name: "JSON Lines" },
  ".md": { id: "markdown", name: "Markdown" },
  ".mdx": { id: "markdown", name: "Markdown" },
  ".yml": { id: "yaml", name: "YAML" },
  ".yaml": { id: "yaml", name: "YAML" },
  ".toml": { id: "toml", name: "TOML" },
  ".csv": { id: "csv", name: "CSV" },
  ".tsv": { id: "csv", name: "TSV" },
};

export function detectLanguage(filePath: string): LanguageInfo | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}
