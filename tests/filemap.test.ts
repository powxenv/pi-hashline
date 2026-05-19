import { describe, expect, test } from "bun:test";
import { generateMap } from "../src/filemap/extract";
import { lookupSymbol } from "../src/filemap/symbols";

describe("file maps", () => {
  const source = [
    "import { value } from './value';",
    "export function add(a: number, b: number) {",
    "  return a + b;",
    "}",
    "export class Calculator {",
    "  multiply(a: number, b: number) {",
    "    return a * b;",
    "  }",
    "}",
    "export interface Point { x: number; y: number }",
    "export type Result<T> = { value: T };",
    "export enum Color { Red, Blue }",
    "export const VERSION = '1.0.0';",
  ].join("\n");

  test("extracts common TypeScript symbols", () => {
    const map = generateMap(source, "sample.ts", Buffer.byteLength(source, "utf8"));
    expect(map?.language).toBe("TypeScript");
    expect(map?.symbols.map((symbol) => symbol.name)).toEqual([
      "add",
      "Calculator",
      "Point",
      "Result",
      "Color",
      "VERSION",
    ]);
  });

  test("resolves qualified child symbols", () => {
    const map = generateMap(source, "sample.ts", Buffer.byteLength(source, "utf8"));
    expect(map).not.toBeNull();
    const result = lookupSymbol(map!, "Calculator.multiply");
    expect(result.type).toBe("found");
    if (result.type === "found") {
      expect(result.qualifiedName).toBe("Calculator.multiply");
      expect(result.symbol.startLine).toBe(6);
      expect(result.symbol.endLine).toBe(8);
    }
  });

  test("uses @line to disambiguate symbol lookups", () => {
    const duplicateSource = [
      "export function run() {",
      "  return 1;",
      "}",
      "export class Task {",
      "  run() {",
      "    return 2;",
      "  }",
      "}",
    ].join("\n");
    const map = generateMap(duplicateSource, "duplicate.ts", Buffer.byteLength(duplicateSource, "utf8"));
    expect(map).not.toBeNull();
    const ambiguous = lookupSymbol(map!, "run");
    expect(ambiguous.type).toBe("ambiguous");
    const selected = lookupSymbol(map!, "run@5");
    expect(selected.type).toBe("found");
    if (selected.type === "found") {
      expect(selected.qualifiedName).toBe("Task.run");
    }
  });
});
