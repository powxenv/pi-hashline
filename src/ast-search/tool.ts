import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Lang, parse } from "@ast-grep/napi";
import type { NapiConfig, Rule } from "@ast-grep/napi";
import { Type } from "typebox";
import { extname, relative } from "node:path";

import { normalizeToLF, stripBom } from "../hashline/diff";
import { computeLineHash } from "../hashline/engine";
import { loadFileKindAndText } from "../shared/file-kind";
import { collectProjectFiles } from "../shared/project-files";
import { resolveToCwd } from "../shared/paths";
import { throwIfAborted } from "../shared/runtime";

const DEFAULT_LIMIT = 100;
const DEFAULT_CONTEXT_LINES = 0;
const DEFAULT_MAX_FILES_VISITED = 20_000;

const BUILTIN_LANG_EXTENSIONS = new Map<string, Lang>([
  [".ts", Lang.TypeScript],
  [".mts", Lang.TypeScript],
  [".cts", Lang.TypeScript],
  [".tsx", Lang.Tsx],
  [".js", Lang.JavaScript],
  [".mjs", Lang.JavaScript],
  [".cjs", Lang.JavaScript],
  [".jsx", Lang.Tsx],
  [".html", Lang.Html],
  [".htm", Lang.Html],
  [".css", Lang.Css],
]);

const LANGUAGE_ALIASES = new Map<string, Lang>([
  ["ts", Lang.TypeScript],
  ["typescript", Lang.TypeScript],
  ["tsx", Lang.Tsx],
  ["js", Lang.JavaScript],
  ["javascript", Lang.JavaScript],
  ["jsx", Lang.Tsx],
  ["html", Lang.Html],
  ["css", Lang.Css],
]);

type AstSearchParams = {
  pattern?: string;
  rule?: Rule;
  constraints?: Record<string, Rule>;
  utils?: Record<string, Rule>;
  path?: string;
  language?: Lang;
  include?: string[];
  exclude?: string[];
  context: number;
  before: number;
  after: number;
  limit: number;
  maxFilesVisited: number;
  respectGitignore?: boolean;
};

type AstSearchMatch = {
  path: string;
  startLine: number;
  endLine: number;
  textLines: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function getStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`ast_search field "${field}" must be an array of strings.`);
  }
  return value;
}

function parseLanguage(value: unknown): Lang | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error('ast_search field "language" must be a string.');
  const normalized = value.trim().toLowerCase();
  const language = LANGUAGE_ALIASES.get(normalized);
  if (language === undefined) {
    throw new Error(
      "ast_search language must be one of: typescript, tsx, javascript, jsx, html, css.",
    );
  }
  return language;
}

type AstSearchMatcher = string | NapiConfig;
type AstStrictness = "cst" | "smart" | "ast" | "relaxed" | "signature";
type AstRelation = Rule & { stopBy?: "neighbor" | "end" | Rule; field?: string };

const RULE_KEYS = new Set([
  "pattern",
  "kind",
  "range",
  "regex",
  "nthChild",
  "inside",
  "has",
  "precedes",
  "follows",
  "all",
  "any",
  "not",
  "matches",
]);

const RELATION_KEYS = new Set([...RULE_KEYS, "stopBy", "field"]);
const PATTERN_OBJECT_KEYS = new Set(["context", "selector", "strictness"]);
const NTH_CHILD_OBJECT_KEYS = new Set(["position", "ofRule", "reverse"]);
const RANGE_KEYS = new Set(["start", "end"]);
const POSITION_KEYS = new Set(["line", "column"]);
const STRICTNESS_VALUES = new Set<string>(["cst", "smart", "ast", "relaxed", "signature"]);

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${path} contains unknown field(s): ${unknownKeys.join(", ")}.`);
  }
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

function readInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${path} must be an integer.`);
  }
  return value;
}

function readStrictness(value: unknown, path: string): AstStrictness {
  const strictness = readNonEmptyString(value, path);
  if (!STRICTNESS_VALUES.has(strictness)) {
    throw new Error(`${path} must be one of: cst, smart, ast, relaxed, signature.`);
  }
  switch (strictness) {
    case "cst":
    case "smart":
    case "ast":
    case "relaxed":
    case "signature":
      return strictness;
  }
  throw new Error(`${path} must be one of: cst, smart, ast, relaxed, signature.`);
}

function readPosition(value: unknown, path: string): { line: number; column: number } {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  assertKnownKeys(value, POSITION_KEYS, path);
  return {
    line: readInteger(value["line"], `${path}.line`),
    column: readInteger(value["column"], `${path}.column`),
  };
}

function readRange(
  value: unknown,
  path: string,
): { start: { line: number; column: number }; end: { line: number; column: number } } {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  assertKnownKeys(value, RANGE_KEYS, path);
  return {
    start: readPosition(value["start"], `${path}.start`),
    end: readPosition(value["end"], `${path}.end`),
  };
}

function readPattern(
  value: unknown,
  path: string,
): string | { context: string; selector?: string; strictness?: AstStrictness } {
  if (typeof value === "string") return readNonEmptyString(value, path);
  if (!isRecord(value)) throw new Error(`${path} must be a string or pattern object.`);
  assertKnownKeys(value, PATTERN_OBJECT_KEYS, path);
  const context = readNonEmptyString(value["context"], `${path}.context`);
  const selector = value["selector"];
  const strictness = value["strictness"];
  return {
    context,
    ...(selector !== undefined
      ? { selector: readNonEmptyString(selector, `${path}.selector`) }
      : {}),
    ...(strictness !== undefined
      ? { strictness: readStrictness(strictness, `${path}.strictness`) }
      : {}),
  };
}

function readNthChild(
  value: unknown,
  path: string,
): number | string | { position: string | number; ofRule?: Rule; reverse?: boolean } {
  if (typeof value === "number") return readInteger(value, path);
  if (typeof value === "string") return readNonEmptyString(value, path);
  if (!isRecord(value)) throw new Error(`${path} must be a number, string, or object.`);
  assertKnownKeys(value, NTH_CHILD_OBJECT_KEYS, path);
  const position = value["position"];
  if (typeof position !== "string" && typeof position !== "number") {
    throw new Error(`${path}.position must be a string or number.`);
  }
  const ofRule = value["ofRule"];
  const reverse = value["reverse"];
  if (reverse !== undefined && typeof reverse !== "boolean") {
    throw new Error(`${path}.reverse must be a boolean.`);
  }
  return {
    position,
    ...(ofRule !== undefined ? { ofRule: readRule(ofRule, `${path}.ofRule`) } : {}),
    ...(reverse !== undefined ? { reverse } : {}),
  };
}

function readRuleArray(value: unknown, path: string): Rule[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array of rule objects.`);
  }
  return value.map((item, index) => readRule(item, `${path}[${index}]`));
}

function readRuleRecord(value: unknown, path: string): Record<string, Rule> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${path} must be an object mapping names to rules.`);
  const record: Record<string, Rule> = {};
  for (const [key, ruleValue] of Object.entries(value)) {
    if (key.trim().length === 0) throw new Error(`${path} contains an empty key.`);
    record[key] = readRule(ruleValue, `${path}.${key}`);
  }
  return record;
}

function readRelation(value: unknown, path: string): AstRelation {
  const baseRule = readRuleWithKeys(value, path, RELATION_KEYS);
  const relation: AstRelation = { ...baseRule };
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const stopBy = value["stopBy"];
  const field = value["field"];
  if (stopBy !== undefined) {
    if (stopBy === "neighbor" || stopBy === "end") relation.stopBy = stopBy;
    else relation.stopBy = readRule(stopBy, `${path}.stopBy`);
  }
  if (field !== undefined) relation.field = readNonEmptyString(field, `${path}.field`);
  return relation;
}

function readRuleWithKeys(value: unknown, path: string, allowedKeys: ReadonlySet<string>): Rule {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  assertKnownKeys(value, allowedKeys, path);
  const rule: Rule = {};
  if (value["pattern"] !== undefined)
    rule.pattern = readPattern(value["pattern"], `${path}.pattern`);
  if (value["kind"] !== undefined) rule.kind = readNonEmptyString(value["kind"], `${path}.kind`);
  if (value["range"] !== undefined) rule.range = readRange(value["range"], `${path}.range`);
  if (value["regex"] !== undefined)
    rule.regex = readNonEmptyString(value["regex"], `${path}.regex`);
  if (value["nthChild"] !== undefined)
    rule.nthChild = readNthChild(value["nthChild"], `${path}.nthChild`);
  if (value["inside"] !== undefined) rule.inside = readRelation(value["inside"], `${path}.inside`);
  if (value["has"] !== undefined) rule.has = readRelation(value["has"], `${path}.has`);
  if (value["precedes"] !== undefined)
    rule.precedes = readRelation(value["precedes"], `${path}.precedes`);
  if (value["follows"] !== undefined)
    rule.follows = readRelation(value["follows"], `${path}.follows`);
  if (value["all"] !== undefined) rule.all = readRuleArray(value["all"], `${path}.all`);
  if (value["any"] !== undefined) rule.any = readRuleArray(value["any"], `${path}.any`);
  if (value["not"] !== undefined) rule.not = readRule(value["not"], `${path}.not`);
  if (value["matches"] !== undefined)
    rule.matches = readNonEmptyString(value["matches"], `${path}.matches`);
  if (Object.keys(rule).length === 0)
    throw new Error(`${path} must contain at least one rule field.`);
  return rule;
}

function readRule(value: unknown, path: string): Rule {
  return readRuleWithKeys(value, path, RULE_KEYS);
}

function parseParams(params: unknown): AstSearchParams {
  if (!isRecord(params)) throw new Error("ast_search params must be an object.");
  const patternInput = params["pattern"];
  const ruleInput = params["rule"];
  if (patternInput !== undefined && ruleInput !== undefined) {
    throw new Error('ast_search accepts either "pattern" or "rule", not both.');
  }
  const pattern =
    patternInput === undefined ? undefined : readNonEmptyString(patternInput, "ast_search.pattern");
  const rule = ruleInput === undefined ? undefined : readRule(ruleInput, "ast_search.rule");
  if (pattern === undefined && rule === undefined) {
    throw new Error('ast_search requires either a non-empty "pattern" string or a "rule" object.');
  }

  const context = getInteger(params["context"], DEFAULT_CONTEXT_LINES, 0, 20);
  return {
    ...(pattern !== undefined ? { pattern } : {}),
    ...(rule !== undefined ? { rule } : {}),
    constraints: readRuleRecord(params["constraints"], "ast_search.constraints"),
    utils: readRuleRecord(params["utils"], "ast_search.utils"),
    path: typeof params["path"] === "string" ? params["path"] : undefined,
    language: parseLanguage(params["language"]),
    include: getStringArray(params["include"], "include"),
    exclude: getStringArray(params["exclude"], "exclude"),
    context,
    before: getInteger(params["before"], context, 0, 20),
    after: getInteger(params["after"], context, 0, 20),
    limit: getInteger(params["limit"], DEFAULT_LIMIT, 1, 1000),
    maxFilesVisited: getInteger(params["maxFilesVisited"], DEFAULT_MAX_FILES_VISITED, 1, 100_000),
    respectGitignore: getBoolean(params["respectGitignore"]),
  };
}

function detectAstLanguage(filePath: string, requested: Lang | undefined): Lang | null {
  if (requested !== undefined) return requested;
  return BUILTIN_LANG_EXTENSIONS.get(extname(filePath).toLowerCase()) ?? null;
}

function buildAstMatcher(params: AstSearchParams, language: Lang): AstSearchMatcher {
  if (params.rule === undefined) {
    if (params.pattern === undefined) throw new Error("ast_search matcher is missing.");
    return params.pattern;
  }
  return {
    rule: params.rule,
    language,
    ...(params.constraints !== undefined ? { constraints: params.constraints } : {}),
    ...(params.utils !== undefined ? { utils: params.utils } : {}),
  };
}

function buildMatch(params: {
  displayPath: string;
  content: string;
  startLine: number;
  endLine: number;
  before: number;
  after: number;
}): AstSearchMatch {
  const lines = normalizeToLF(stripBom(params.content).text).split("\n");
  const start = Math.max(1, params.startLine - params.before);
  const end = Math.min(lines.length, params.endLine + params.after);
  return {
    path: params.displayPath,
    startLine: start,
    endLine: end,
    textLines: lines.slice(start - 1, end),
  };
}

function formatMatches(params: {
  matches: AstSearchMatch[];
  limit: number;
  matchLimitReached: boolean;
  fileLimitReached: boolean;
  unsupportedFiles: number;
  parseErrorFiles: number;
}): string {
  if (params.matches.length === 0) {
    const detailLines: string[] = ["No structural matches found."];
    if (params.unsupportedFiles > 0)
      detailLines.push(`Unsupported-language files skipped: ${params.unsupportedFiles}.`);
    if (params.parseErrorFiles > 0)
      detailLines.push(`Parse-error files skipped: ${params.parseErrorFiles}.`);
    if (params.fileLimitReached)
      detailLines.push("File visit limit reached. Narrow the path or raise maxFilesVisited.");
    return detailLines.join("\n");
  }

  const output: string[] = [];
  for (const match of params.matches) {
    const width = String(match.endLine).length;
    for (let index = 0; index < match.textLines.length; index++) {
      const lineNumber = match.startLine + index;
      const line = match.textLines[index] ?? "";
      output.push(
        `${match.path}:${String(lineNumber).padStart(width, " ")}#${computeLineHash(lineNumber, line)}:${line}`,
      );
    }
    output.push("");
  }
  output.pop();

  if (params.matchLimitReached) {
    output.push(
      "",
      `[Structural search stopped after ${params.limit} matches. Narrow the pattern/path for more results.]`,
    );
  }
  if (params.fileLimitReached) {
    output.push(
      "",
      "[Search stopped after the file visit limit. Narrow the path or raise maxFilesVisited.]",
    );
  }
  if (params.unsupportedFiles > 0 || params.parseErrorFiles > 0) {
    output.push(
      "",
      `[Skipped ${params.unsupportedFiles} unsupported-language file(s), ${params.parseErrorFiles} parse-error file(s).]`,
    );
  }
  return output.join("\n");
}

export type AstSearchResult = {
  content: Array<{ type: "text"; text: string }>;
  details: {
    matches: number;
    filesVisited: number;
    unsupportedFiles: number;
    parseErrorFiles: number;
    truncated: boolean;
    fileLimitReached: boolean;
  };
};

export async function executeAstSearch(paramsInput: {
  rawParams: unknown;
  cwd: string;
  signal?: AbortSignal;
}): Promise<AstSearchResult> {
  const params = parseParams(paramsInput.rawParams);
  const rootPath = resolveToCwd(params.path ?? ".", paramsInput.cwd);
  const collection = await collectProjectFiles({
    rootPath,
    cwd: paramsInput.cwd,
    signal: paramsInput.signal,
    include: params.include,
    exclude: params.exclude,
    maxFilesVisited: params.maxFilesVisited,
    respectGitignore: params.respectGitignore,
  });

  const matches: AstSearchMatch[] = [];
  let unsupportedFiles = 0;
  let parseErrorFiles = 0;
  let matchLimitReached = false;

  for (const filePath of collection.files) {
    throwIfAborted(paramsInput.signal);
    if (matches.length >= params.limit) {
      matchLimitReached = true;
      break;
    }

    const language = detectAstLanguage(filePath, params.language);
    if (language === null) {
      unsupportedFiles += 1;
      continue;
    }

    const displayPath = relative(paramsInput.cwd, filePath) || filePath;
    const file = await loadFileKindAndText(filePath);
    if (file.kind !== "text") continue;
    const content = normalizeToLF(stripBom(file.text).text);

    try {
      const root = parse(language, content);
      const matcher = buildAstMatcher(params, language);
      const nodes = root.root().findAll(matcher);
      for (const node of nodes) {
        if (matches.length >= params.limit) {
          matchLimitReached = true;
          break;
        }
        const range = node.range();
        matches.push(
          buildMatch({
            displayPath,
            content,
            startLine: range.start.line + 1,
            endLine:
              range.end.column === 0
                ? Math.max(range.start.line + 1, range.end.line)
                : range.end.line + 1,
            before: params.before,
            after: params.after,
          }),
        );
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.toLowerCase().includes("pattern")) throw error;
      parseErrorFiles += 1;
    }
  }

  return {
    content: [
      {
        type: "text",
        text: formatMatches({
          matches,
          limit: params.limit,
          matchLimitReached,
          fileLimitReached: collection.truncated,
          unsupportedFiles,
          parseErrorFiles,
        }),
      },
    ],
    details: {
      matches: matches.length,
      filesVisited: collection.filesVisited,
      unsupportedFiles,
      parseErrorFiles,
      truncated: matchLimitReached || collection.truncated,
      fileLimitReached: collection.truncated,
    },
  };
}

export function registerAstSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ast_search",
    label: "AST Search",
    description:
      "Search code structurally with ast-grep patterns or rule objects and return hashline-anchored matches. Supports TypeScript, TSX/JSX, JavaScript, HTML, and CSS.",
    promptSnippet: "Search code structurally with ast-grep patterns and anchored output",
    promptGuidelines: [
      "Use ast_search when text grep is too broad and the task needs syntax-aware matches.",
      "Use grep for plain text searches and ast_search for code shape patterns such as foo($ARG).",
      "Use rule objects for kind, regex, relational, composite, constraint, or utility-rule matching.",
      "Set language when searching extensionless or ambiguous files.",
      "Use edit for changes after inspecting anchored matches.",
    ],
    parameters: Type.Object(
      {
        pattern: Type.Optional(
          Type.String({
            description: "ast-grep pattern, e.g. 'foo($ARG)' or 'if ($COND) { $$$BODY }'",
          }),
        ),
        rule: Type.Optional(
          Type.Unknown({
            description:
              "ast-grep rule object with pattern/kind/range/regex/nthChild/inside/has/precedes/follows/all/any/not/matches fields",
          }),
        ),
        constraints: Type.Optional(
          Type.Unknown({
            description: "ast-grep constraints object mapping metavariables to rules",
          }),
        ),
        utils: Type.Optional(
          Type.Unknown({ description: "ast-grep utility rules object mapping names to rules" }),
        ),
        path: Type.Optional(
          Type.String({ description: "File or directory to search; defaults to cwd" }),
        ),
        language: Type.Optional(
          Type.String({ description: "typescript, tsx, javascript, jsx, html, or css" }),
        ),
        include: Type.Optional(
          Type.Array(Type.String(), { description: "Glob patterns to include" }),
        ),
        exclude: Type.Optional(
          Type.Array(Type.String(), { description: "Glob patterns to exclude" }),
        ),
        context: Type.Optional(
          Type.Integer({ minimum: 0, maximum: 20, description: "Context lines around matches" }),
        ),
        before: Type.Optional(
          Type.Integer({ minimum: 0, maximum: 20, description: "Lines before each match" }),
        ),
        after: Type.Optional(
          Type.Integer({ minimum: 0, maximum: 20, description: "Lines after each match" }),
        ),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum matches to return" }),
        ),
        maxFilesVisited: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 100000, description: "Maximum files to visit" }),
        ),
        respectGitignore: Type.Optional(
          Type.Boolean({ description: "Respect .gitignore files. Defaults to true" }),
        ),
      },
      { additionalProperties: false },
    ),

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      return executeAstSearch({ rawParams, cwd: ctx.cwd, signal });
    },
  });
}
