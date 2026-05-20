type SymbolKind =
  | "class"
  | "function"
  | "method"
  | "variable"
  | "constant"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "import"
  | "module"
  | "namespace"
  | "property"
  | "heading"
  | "table"
  | "view"
  | "procedure"
  | "trigger"
  | "index"
  | "schema"
  | "unknown";

export interface FileSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature?: string;
  children?: FileSymbol[];
  modifiers?: string[];
  docstring?: string;
  isExported?: boolean;
}

export interface FileMap {
  path: string;
  totalLines: number;
  totalBytes: number;
  language: string;
  symbols: FileSymbol[];

}
