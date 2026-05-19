import { parseSync } from "oxc-parser";
import type { FileMap, FileSymbol } from "./types";
import { detectLanguage } from "./languages";

type ExtractorFn = (content: string, filePath: string) => FileSymbol[] | null;

function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split("\n");
  return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

type AstNode = Record<string, unknown> & {
  type: string;
  start: number;
  end: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAstNode(value: unknown): value is AstNode {
  if (!isRecord(value)) return false;
  return (
    typeof value["type"] === "string" &&
    typeof value["start"] === "number" &&
    typeof value["end"] === "number"
  );
}

function getAstNodeProperty(node: AstNode, key: string): AstNode | null {
  const value = node[key];
  return isAstNode(value) ? value : null;
}

function getAstNodeArrayProperty(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isAstNode);
}

function getStringProperty(node: AstNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === "string" ? value : undefined;
}

function extractOxcTsJs(
  content: string,
  filePath: string,
  lang: "ts" | "tsx" | "js" | "jsx" | "dts",
): FileSymbol[] | null {
  try {
    const result = parseSync(filePath, content, {
      lang,
      sourceType: "module",
      astType: lang === "js" || lang === "jsx" ? "js" : "ts",
      range: true,
    });

    const symbols: FileSymbol[] = [];
    const imports: string[] = [];

    for (const importDecl of result.module.staticImports) {
      const source = importDecl.moduleRequest.value;
      if (source && !imports.includes(source)) {
        imports.push(source);
      }
    }

    const programValue: unknown = result.program;
    const bodyValue = isRecord(programValue) ? programValue["body"] : undefined;
    const body: AstNode[] = Array.isArray(bodyValue) ? bodyValue.filter(isAstNode) : [];
    if (body.length === 0) return symbols.length > 0 ? symbols : null;

    for (const node of body) {
      const sym = extractTsNode(node, content);
      if (sym) {
        if (Array.isArray(sym)) {
          symbols.push(...sym);
        } else {
          symbols.push(sym);
        }
      }
    }

    if (imports.length > 0 && symbols.length > 0) {
      symbols[0]!.modifiers = [...(symbols[0]!.modifiers ?? []), `imports: ${imports.join(", ")}`];
    }

    return symbols.length > 0 ? symbols : null;
  } catch {
    return null;
  }
}

function extractTsNode(node: AstNode, content: string): FileSymbol | FileSymbol[] | null {
  const startLine = offsetToLine(content, node.start);
  const endLine = offsetToLine(content, node.end);

  switch (node.type) {
    case "FunctionDeclaration":
    case "TSEmptyBodyFunctionExpression": {
      const id = getAstNodeProperty(node, "id");
      if (!id) return null;
      const name = content.slice(id.start, id.end);
      const async = node.async === true;
      const generator = node.generator === true;
      const params = extractParams(node, content);
      const mods: string[] = [];
      if (async) mods.push("async");
      if (generator) mods.push("generator");
      return {
        name,
        kind: "function",
        startLine,
        endLine,
        signature: `${async ? "async " : ""}function ${name}(${params})`,
        modifiers: mods.length > 0 ? mods : undefined,
      };
    }
    case "ClassDeclaration":
    case "ClassExpression": {
      const id = getAstNodeProperty(node, "id");
      const name = id ? content.slice(id.start, id.end) : "<anonymous>";
      const abstract = node.abstract === true;
      const mods: string[] = [];
      if (abstract) mods.push("abstract");
      const body = getAstNodeProperty(node, "body");
      const children: FileSymbol[] = [];
      if (body) {
        for (const member of getAstNodeArrayProperty(body, "body")) {
          const child = extractClassMember(member, content, name);
          if (child) children.push(child);
        }
      }
      return {
        name,
        kind: "class",
        startLine,
        endLine,
        modifiers: mods.length > 0 ? mods : undefined,
        children: children.length > 0 ? children : undefined,
      };
    }
    case "TSEnumDeclaration": {
      const id = getAstNodeProperty(node, "id");
      if (!id) return null;
      const name = content.slice(id.start, id.end);
      const body = getAstNodeProperty(node, "body");
      const children: FileSymbol[] = [];
      if (body) {
        for (const member of getAstNodeArrayProperty(body, "body")) {
          const memberId = getAstNodeProperty(member, "id");
          if (memberId) {
            children.push({
              name: content.slice(memberId.start, memberId.end),
              kind: "constant",
              startLine: offsetToLine(content, member.start),
              endLine: offsetToLine(content, member.end),
            });
          }
        }
      }
      return {
        name,
        kind: "enum",
        startLine,
        endLine,
        children: children.length > 0 ? children : undefined,
      };
    }
    case "TSInterfaceDeclaration": {
      const id = getAstNodeProperty(node, "id");
      if (!id) return null;
      return {
        name: content.slice(id.start, id.end),
        kind: "interface",
        startLine,
        endLine,
      };
    }
    case "TSTypeAliasDeclaration": {
      const id = getAstNodeProperty(node, "id");
      if (!id) return null;
      return {
        name: content.slice(id.start, id.end),
        kind: "type",
        startLine,
        endLine,
      };
    }
    case "VariableDeclaration": {
      const kind = getStringProperty(node, "kind") ?? "var";
      const declarations = getAstNodeArrayProperty(node, "declarations");
      if (!declarations) return null;
      const results: FileSymbol[] = [];
      for (const decl of declarations) {
        const declId = getAstNodeProperty(decl, "id");
        if (!declId) continue;
        const name = content.slice(declId.start, declId.end);
        const init = getAstNodeProperty(decl, "init");
        const isArrowOrFn =
          init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression");
        results.push({
          name,
          kind: isArrowOrFn ? "function" : kind === "const" ? "constant" : "variable",
          startLine: offsetToLine(content, decl.start),
          endLine: offsetToLine(content, decl.end),
          modifiers: kind === "const" ? ["const"] : kind === "let" ? ["let"] : undefined,
        });
      }
      return results;
    }
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration": {
      const declaration = getAstNodeProperty(node, "declaration");
      if (declaration) {
        const inner = extractTsNode(declaration, content);
        if (inner) {
          if (Array.isArray(inner)) {
            for (const sym of inner) {
              sym.isExported = true;
              sym.modifiers = [...(sym.modifiers ?? []), "export"];
            }
            return inner;
          }
          inner.isExported = true;
          inner.modifiers = [...(inner.modifiers ?? []), "export"];
          return inner;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function extractClassMember(node: AstNode, content: string, _className: string): FileSymbol | null {
  const startLine = offsetToLine(content, node.start);
  const endLine = offsetToLine(content, node.end);

  if (node.type === "MethodDefinition" || node.type === "PropertyDefinition") {
    const key = getAstNodeProperty(node, "key");
    if (!key) return null;
    const name = content.slice(key.start, key.end);
    const kind = getStringProperty(node, "kind") ?? "method";
    const isStatic = node.static === true;
    const value = getAstNodeProperty(node, "value");
    const isAsync = value?.async === true;
    const mods: string[] = [];
    if (isStatic) mods.push("static");
    if (isAsync) mods.push("async");
    if (kind === "get" || kind === "set") mods.push(kind);

    const params = value ? extractParams(value, content) : "";
    return {
      name,
      kind: node.type === "MethodDefinition" ? "method" : "property",
      startLine,
      endLine,
      signature: node.type === "MethodDefinition" ? `${name}(${params})` : undefined,
      modifiers: mods.length > 0 ? mods : undefined,
    };
  }

  if (node.type === "StaticBlock") {
    return { name: "static {}", kind: "unknown", startLine, endLine };
  }

  return null;
}

function extractParams(node: AstNode, content: string): string {
  const params = getAstNodeArrayProperty(node, "params");
  if (params.length === 0) return "";
  return params
    .map((p) => {
      const pattern = p.pattern ?? p;
      if (isAstNode(pattern)) {
        return content.slice(pattern.start, pattern.end);
      }
      return "?";
    })
    .join(", ");
}

function extractPythonSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");
  const currentClassStack: { name: string; endLine: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const lineNum = i + 1;

    const classMatch = trimmed.match(/^(?<indent>\s*)(?<access>class\s+)(?<name>\w+)/);
    if (classMatch?.groups) {
      const indent = classMatch.groups["indent"]!.length;
      while (
        currentClassStack.length > 0 &&
        currentClassStack[currentClassStack.length - 1]!.endLine >= indent
      ) {
        const finished = currentClassStack.pop()!;
        const lastSym = symbols.find(
          (s) => s.name === finished.name && s.kind === "class" && s.endLine === 0,
        );
        if (lastSym) lastSym.endLine = lineNum - 1;
      }
      const bases = trimmed.includes("(")
        ? trimmed.slice(trimmed.indexOf("("), trimmed.lastIndexOf(")") + 1)
        : "";
      symbols.push({
        name: classMatch.groups["name"]!,
        kind: "class",
        startLine: lineNum,
        endLine: 0,
        signature: bases ? `class ${classMatch.groups["name"]!}${bases}` : undefined,
        children: [],
      });
      currentClassStack.push({ name: classMatch.groups["name"]!, endLine: indent });
      continue;
    }

    const funcMatch = trimmed.match(
      /^(?<indent>\s*)(?<decorators>@\w+(?:\([^)]*\))?\s*)*(?<access>async\s+)?def\s+(?<name>\w+)\s*\((?<params>[^)]*)\)/,
    );
    if (funcMatch?.groups) {
      const name = funcMatch.groups["name"]!;
      const isAsync = funcMatch.groups["access"]?.includes("async") ?? false;
      const params = funcMatch.groups["params"] ?? "";
      const indent = funcMatch.groups["indent"]!.length;
      const mods: string[] = [];
      if (isAsync) mods.push("async");
      const sym: FileSymbol = {
        name,
        kind:
          currentClassStack.length > 0 &&
          indent > currentClassStack[currentClassStack.length - 1]!.endLine
            ? "method"
            : "function",
        startLine: lineNum,
        endLine: lineNum,
        signature: `${isAsync ? "async " : ""}def ${name}(${params})`,
        modifiers: mods.length > 0 ? mods : undefined,
      };

      const parentClass =
        currentClassStack.length > 0 ? currentClassStack[currentClassStack.length - 1] : null;
      if (parentClass) {
        const parentSym = symbols.find((s) => s.name === parentClass.name && s.kind === "class");
        if (parentSym?.children) parentSym.children.push(sym);
        else symbols.push(sym);
      } else {
        symbols.push(sym);
      }
    }
  }

  for (const sym of symbols) {
    if (sym.kind === "class" && sym.endLine === 0) {
      sym.endLine = lines.length;
    }
  }

  return symbols.length > 0 ? symbols : null;
}

function extractGoSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const lineNum = i + 1;

    const funcMatch = trimmed.match(
      /^func\s+(?:\((?<receiver>[^)]+)\)\s*)?(?<name>\w+)\s*\((?<params>[^)]*)\)/,
    );
    if (funcMatch?.groups) {
      const name = funcMatch.groups["name"]!;
      const receiver = funcMatch.groups["receiver"];
      const params = funcMatch.groups["params"] ?? "";
      const endLine = findGoBlockEnd(lines, i);
      symbols.push({
        name,
        kind: receiver ? "method" : "function",
        startLine: lineNum,
        endLine,
        signature: receiver ? `func (${receiver}) ${name}(${params})` : `func ${name}(${params})`,
      });
      continue;
    }

    const typeMatch = trimmed.match(/^type\s+(?<name>\w+)\s+(?<kind>struct|interface)/);
    if (typeMatch?.groups) {
      const name = typeMatch.groups["name"]!;
      const kind = typeMatch.groups["kind"]!;
      const endLine = findGoBlockEnd(lines, i);
      symbols.push({
        name,
        kind: kind === "struct" ? "struct" : "interface",
        startLine: lineNum,
        endLine,
      });
    }
  }

  return symbols.length > 0 ? symbols : null;
}

function findGoBlockEnd(lines: string[], startIdx: number): number {
  let braceCount = 0;
  let foundOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const char of lines[i]!) {
      if (char === "{") {
        braceCount++;
        foundOpen = true;
      } else if (char === "}") {
        braceCount--;
        if (foundOpen && braceCount === 0) {
          return i + 1;
        }
      }
    }
  }
  return lines.length;
}

function extractRustSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const lineNum = i + 1;

    const fnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(?<name>\w+)/);
    if (fnMatch?.groups) {
      const endLine = findRustBlockEnd(lines, i);
      const isAsync = trimmed.includes("async ");
      const isPub = trimmed.startsWith("pub ");
      const mods: string[] = [];
      if (isAsync) mods.push("async");
      if (isPub) mods.push("pub");
      symbols.push({
        name: fnMatch.groups["name"]!,
        kind: "function",
        startLine: lineNum,
        endLine,
        modifiers: mods.length > 0 ? mods : undefined,
      });
    } else if (trimmed.match(/^(?:pub\s+)?struct\s+/)) {
      const match = trimmed.match(/struct\s+(?<name>\w+)/);
      if (match?.groups) {
        symbols.push({
          name: match.groups["name"]!,
          kind: "struct",
          startLine: lineNum,
          endLine: findRustBlockEnd(lines, i),
        });
      }
    } else if (trimmed.match(/^(?:pub\s+)?enum\s+/)) {
      const match = trimmed.match(/enum\s+(?<name>\w+)/);
      if (match?.groups) {
        symbols.push({
          name: match.groups["name"]!,
          kind: "enum",
          startLine: lineNum,
          endLine: findRustBlockEnd(lines, i),
        });
      }
    } else if (trimmed.match(/^(?:pub\s+)?trait\s+/)) {
      const match = trimmed.match(/trait\s+(?<name>\w+)/);
      if (match?.groups) {
        symbols.push({
          name: match.groups["name"]!,
          kind: "interface",
          startLine: lineNum,
          endLine: findRustBlockEnd(lines, i),
        });
      }
    } else if (trimmed.match(/^(?:pub\s+)?impl\s+/)) {
      const match = trimmed.match(/impl\s+(?:<[^>]+>\s+)?(?<name>\w+)/);
      if (match?.groups) {
        symbols.push({
          name: `impl ${match.groups["name"]!}`,
          kind: "namespace",
          startLine: lineNum,
          endLine: findRustBlockEnd(lines, i),
        });
      }
    } else if (trimmed.match(/^(?:pub\s+)?mod\s+/)) {
      const match = trimmed.match(/mod\s+(?<name>\w+)/);
      if (match?.groups) {
        symbols.push({
          name: match.groups["name"]!,
          kind: "module",
          startLine: lineNum,
          endLine: findRustBlockEnd(lines, i),
        });
      }
    }
  }

  return symbols.length > 0 ? symbols : null;
}

function findRustBlockEnd(lines: string[], startIdx: number): number {
  let braceCount = 0;
  let foundOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const char of lines[i]!) {
      if (char === "{") {
        braceCount++;
        foundOpen = true;
      } else if (char === "}") {
        braceCount--;
        if (foundOpen && braceCount === 0) {
          return i + 1;
        }
      }
    }
  }
  return lines.length;
}

function extractCCodeSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const lineNum = i + 1;

    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

    const funcMatch = trimmed.match(
      /^(?<return>\w+(?:\s*\*)?)\s+(?<name>\w+)\s*\((?<params>[^)]*)\)/,
    );
    if (funcMatch?.groups && !/^(if|while|for|switch|return)$/.test(funcMatch.groups["name"]!)) {
      symbols.push({
        name: funcMatch.groups["name"]!,
        kind: "function",
        startLine: lineNum,
        endLine: lineNum,
        signature: `(${funcMatch.groups["params"] ?? ""})`,
      });
      continue;
    }

    const structMatch = trimmed.match(/(?:typedef\s+)?struct\s+(?<name>\w+)?\s*\{/);
    if (structMatch) {
      symbols.push({
        name: structMatch.groups?.["name"] ?? "<anonymous>",
        kind: "struct",
        startLine: lineNum,
        endLine: lineNum,
      });
      continue;
    }

    const enumMatch = trimmed.match(/(?:typedef\s+)?enum\s+(?<name>\w+)?\s*\{/);
    if (enumMatch) {
      symbols.push({
        name: enumMatch.groups?.["name"] ?? "<anonymous>",
        kind: "enum",
        startLine: lineNum,
        endLine: lineNum,
      });
    }
  }

  return symbols.length > 0 ? symbols : null;
}

function extractMarkdownSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match?.[1] && match[2]) {
      symbols.push({
        name: match[2].trim(),
        kind: "heading",
        startLine: i + 1,
        endLine: i + 1,
        signature: `${match[1]} ${match[2].trim()}`,
      });
    }
  }

  return symbols.length > 0 ? symbols : null;
}

function extractSqlSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const lineNum = i + 1;

    const tableMatch = trimmed.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?<schema>\w+)\.)?(?<name>\w+)/i,
    );
    if (tableMatch?.groups) {
      symbols.push({
        name: `TABLE ${tableMatch.groups["name"]!}`,
        kind: "class",
        startLine: lineNum,
        endLine: lineNum,
      });
      continue;
    }

    const viewMatch = trimmed.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?<name>\w+)/i);
    if (viewMatch?.groups) {
      symbols.push({
        name: `VIEW ${viewMatch.groups["name"]!}`,
        kind: "class",
        startLine: lineNum,
        endLine: lineNum,
      });
      continue;
    }

    const funcMatch = trimmed.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?<name>\w+)/i);
    if (funcMatch?.groups) {
      symbols.push({
        name: `FUNCTION ${funcMatch.groups["name"]!}`,
        kind: "function",
        startLine: lineNum,
        endLine: lineNum,
      });
    }
  }

  return symbols.length > 0 ? symbols : null;
}

function extractJsonSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed)) {
      for (const key of Object.keys(parsed)) {
        const val = parsed[key];
        const kindStr = Array.isArray(val) ? "array" : typeof val;
        symbols.push({
          name: `${key}: ${kindStr}`,
          kind: "property",
          startLine: 1,
          endLine: 1,
        });
      }
    }
  } catch {
    return null;
  }
  return symbols.length > 0 ? symbols : null;
}

function extractTomlSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const lineNum = i + 1;

    const arrayMatch = trimmed.match(/^\[\[(?<name>[^\]]+)\]\]/);
    if (arrayMatch?.groups) {
      symbols.push({
        name: `[[${arrayMatch.groups["name"]!}]]`,
        kind: "variable",
        startLine: lineNum,
        endLine: lineNum,
      });
      continue;
    }

    const sectionMatch = trimmed.match(/^\[(?<name>[^\]]+)\]/);
    if (sectionMatch?.groups) {
      symbols.push({
        name: `[${sectionMatch.groups["name"]!}]`,
        kind: "class",
        startLine: lineNum,
        endLine: lineNum,
      });
    }
  }

  return symbols.length > 0 ? symbols : null;
}

function extractYamlSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(/^(?<name>[a-zA-Z_][\w.-]*)\s*:/);
    if (match?.groups && !line.startsWith(" ") && !line.startsWith("-")) {
      symbols.push({
        name: match.groups["name"]!,
        kind: "property",
        startLine: i + 1,
        endLine: i + 1,
      });
    }
  }

  return symbols.length > 0 ? symbols : null;
}

function extractCsvSymbols(content: string): FileSymbol[] | null {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  const delimiter =
    (lines[0]!.match(/\t/g) ?? []).length > (lines[0]!.match(/,/g) ?? []).length ? "\t" : ",";
  const headers = lines[0]!.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
  const symbols: FileSymbol[] = [
    {
      name: `${lines.length - 1} rows × ${headers.length} columns`,
      kind: "table",
      startLine: 1,
      endLine: lines.length,
    },
  ];
  for (const [idx, header] of headers.entries()) {
    symbols.push({
      name: header || `Column ${idx + 1}`,
      kind: "property",
      startLine: 1,
      endLine: 1,
    });
  }
  return symbols;
}

function detectTsJsLang(filePath: string): "ts" | "tsx" | "js" | "jsx" | "dts" {
  if (filePath.endsWith(".d.ts")) return "dts";
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".jsx")) return "jsx";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs"))
    return "js";
  return "ts";
}

function findBraceBlockEnd(lines: string[], startIdx: number): number {
  let braceCount = 0;
  let foundOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const char of lines[i]!) {
      if (char === "{") {
        braceCount += 1;
        foundOpen = true;
      } else if (char === "}") {
        braceCount -= 1;
        if (foundOpen && braceCount === 0) return i + 1;
      }
    }
  }
  return lines.length;
}

function extractJvmLikeSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    const lineNum = i + 1;
    if (!trimmed || trimmed.startsWith("//")) continue;

    const typeMatch = trimmed.match(
      /^(?:public|private|protected|internal|abstract|final|sealed|data|open|static|\s)*\s*(?<kind>class|interface|enum|object|record)\s+(?<name>[A-Za-z_]\w*)/,
    );
    if (typeMatch?.groups) {
      const kindText = typeMatch.groups["kind"]!;
      symbols.push({
        name: typeMatch.groups["name"]!,
        kind: kindText === "interface" ? "interface" : kindText === "enum" ? "enum" : "class",
        startLine: lineNum,
        endLine: findBraceBlockEnd(lines, i),
        signature: trimmed.replace(/\s*\{\s*$/, ""),
      });
      continue;
    }

    const functionMatch = trimmed.match(
      /^(?:public|private|protected|internal|static|final|open|override|suspend|async|\s)*\s*(?:fun\s+)?(?:[\w<>[\],.?]+\s+)+(?<name>[A-Za-z_]\w*)\s*\((?<params>[^)]*)\)/,
    );
    if (
      functionMatch?.groups &&
      !/^(if|for|while|switch|catch)$/.test(functionMatch.groups["name"]!)
    ) {
      symbols.push({
        name: functionMatch.groups["name"]!,
        kind: "function",
        startLine: lineNum,
        endLine: trimmed.includes("{") ? findBraceBlockEnd(lines, i) : lineNum,
        signature: trimmed.replace(/\s*\{\s*$/, ""),
      });
    }
  }

  return symbols.length > 0 ? symbols : null;
}

function extractSwiftSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    const lineNum = i + 1;
    const typeMatch = trimmed.match(
      /^(?:public|private|internal|fileprivate|open|final|\s)*\s*(?<kind>class|struct|enum|protocol|actor|extension)\s+(?<name>[A-Za-z_]\w*)/,
    );
    if (typeMatch?.groups) {
      const kindText = typeMatch.groups["kind"]!;
      symbols.push({
        name:
          kindText === "extension"
            ? `extension ${typeMatch.groups["name"]!}`
            : typeMatch.groups["name"]!,
        kind:
          kindText === "protocol"
            ? "interface"
            : kindText === "struct"
              ? "struct"
              : kindText === "enum"
                ? "enum"
                : "class",
        startLine: lineNum,
        endLine: findBraceBlockEnd(lines, i),
        signature: trimmed.replace(/\s*\{\s*$/, ""),
      });
      continue;
    }

    const functionMatch = trimmed.match(
      /^(?:public|private|internal|fileprivate|open|static|class|mutating|async|\s)*\s*func\s+(?<name>[A-Za-z_]\w*)\s*\((?<params>[^)]*)\)/,
    );
    if (functionMatch?.groups) {
      symbols.push({
        name: functionMatch.groups["name"]!,
        kind: "function",
        startLine: lineNum,
        endLine: findBraceBlockEnd(lines, i),
        signature: trimmed.replace(/\s*\{\s*$/, ""),
      });
    }
  }

  return symbols.length > 0 ? symbols : null;
}

function extractShellSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    const nameMatch = trimmed.match(
      /^(?:function\s+)?(?<name>[A-Za-z_][\w-]*)\s*(?:\(\s*\))?\s*\{/,
    );
    if (nameMatch?.groups) {
      symbols.push({
        name: nameMatch.groups["name"]!,
        kind: "function",
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i),
        signature: trimmed.replace(/\s*\{\s*$/, ""),
      });
    }
  }
  return symbols.length > 0 ? symbols : null;
}

function extractClojureSymbols(content: string): FileSymbol[] | null {
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    const nsMatch = trimmed.match(/^\(ns\s+(?<name>[^\s)]+)/);
    if (nsMatch?.groups) {
      symbols.push({
        name: nsMatch.groups["name"]!,
        kind: "namespace",
        startLine: i + 1,
        endLine: i + 1,
      });
      continue;
    }
    const defMatch = trimmed.match(
      /^\((?<kind>defn|defn-|defmacro|defrecord|deftype|defprotocol|defmulti|defmethod|def)\s+(?<name>[^\s)]+)/,
    );
    if (defMatch?.groups) {
      const kindText = defMatch.groups["kind"]!;
      symbols.push({
        name: defMatch.groups["name"]!,
        kind:
          kindText === "def"
            ? "variable"
            : kindText === "defrecord" || kindText === "deftype"
              ? "class"
              : "function",
        startLine: i + 1,
        endLine: i + 1,
        signature: trimmed,
      });
    }
  }
  return symbols.length > 0 ? symbols : null;
}

const EXTRACTORS: Record<string, ExtractorFn> = {
  typescript: (content, filePath) => extractOxcTsJs(content, filePath, detectTsJsLang(filePath)),
  javascript: (content, filePath) => extractOxcTsJs(content, filePath, detectTsJsLang(filePath)),
  python: (content) => extractPythonSymbols(content),
  go: (content) => extractGoSymbols(content),
  rust: (content) => extractRustSymbols(content),
  c: (content) => extractCCodeSymbols(content),
  "c-header": (content) => extractCCodeSymbols(content),
  cpp: (content) => extractCCodeSymbols(content),
  java: (content) => extractJvmLikeSymbols(content),
  kotlin: (content) => extractJvmLikeSymbols(content),
  swift: (content) => extractSwiftSymbols(content),
  shell: (content) => extractShellSymbols(content),
  clojure: (content) => extractClojureSymbols(content),
  edn: (content) => extractClojureSymbols(content),
  markdown: (content) => extractMarkdownSymbols(content),
  sql: (content) => extractSqlSymbols(content),
  json: (content) => extractJsonSymbols(content),
  jsonl: (content) => extractJsonSymbols(content),
  toml: (content) => extractTomlSymbols(content),
  yaml: (content) => extractYamlSymbols(content),
  csv: (content) => extractCsvSymbols(content),
};

export function generateMap(content: string, filePath: string, totalBytes: number): FileMap | null {
  const langInfo = detectLanguage(filePath);
  const totalLines = countLines(content);

  const baseMap: FileMap = {
    path: filePath,
    totalLines,
    totalBytes,
    language: langInfo?.name ?? "Unknown",
    symbols: [],
    imports: [],
  };

  if (!langInfo) return baseMap;

  const extractor = EXTRACTORS[langInfo.id];
  if (!extractor) return baseMap;

  const symbols = extractor(content, filePath);
  return {
    ...baseMap,
    symbols: symbols ?? [],
  };
}
