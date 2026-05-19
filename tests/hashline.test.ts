import { describe, expect, test } from "bun:test";
import {
  applyHashlineEdits,
  computeLineHash,
  formatHashlineRegion,
  resolveEditAnchors,
} from "../src/hashline/engine";

function anchor(line: number, text: string): string {
  return `${line}#${computeLineHash(line, text)}`;
}

describe("hashline editing", () => {
  test("formats stable anchors for read output", () => {
    expect(formatHashlineRegion(["alpha", "beta"], 1)).toBe(
      `1#${computeLineHash(1, "alpha")}:alpha\n2#${computeLineHash(2, "beta")}:beta`,
    );
  });

  test("replaces one anchored line", () => {
    const content = "alpha\nbeta\ngamma\n";
    const edits = resolveEditAnchors([
      { op: "replace", pos: anchor(2, "beta"), lines: ["BETA"] },
    ]);
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("alpha\nBETA\ngamma\n");
    expect(result.firstChangedLine).toBe(2);
    expect(result.lastChangedLine).toBe(2);
  });

  test("replaces anchored ranges", () => {
    const content = "a\nb\nc\nd\n";
    const edits = resolveEditAnchors([
      {
        op: "replace",
        pos: anchor(2, "b"),
        end: anchor(3, "c"),
        lines: ["x", "y", "z"],
      },
    ]);
    expect(applyHashlineEdits(content, edits).content).toBe("a\nx\ny\nz\nd\n");
  });

  test("appends and prepends around anchored lines", () => {
    const content = "a\nb\nc\n";
    const edits = resolveEditAnchors([
      { op: "prepend", pos: anchor(2, "b"), lines: ["before"] },
      { op: "append", pos: anchor(3, "c"), lines: ["after"] },
    ]);
    expect(applyHashlineEdits(content, edits).content).toBe("a\nbefore\nb\nc\nafter\n");
  });

  test("rejects stale anchors", () => {
    const edits = resolveEditAnchors([{ op: "replace", pos: "2#ZZ", lines: ["BETA"] }]);
    expect(() => applyHashlineEdits("alpha\nbeta\n", edits)).toThrow("[E_STALE_ANCHOR]");
  });

  test("rejects overlapping edits", () => {
    const content = "a\nb\nc\n";
    const edits = resolveEditAnchors([
      { op: "replace", pos: anchor(2, "b"), lines: ["x"] },
      { op: "replace", pos: anchor(2, "b"), lines: ["y"] },
    ]);
    expect(() => applyHashlineEdits(content, edits)).toThrow("[E_EDIT_CONFLICT]");
  });

  test("replace_text requires a unique match", () => {
    const edits = resolveEditAnchors([
      { op: "replace_text", oldText: "same", newText: "new" },
    ]);
    expect(() => applyHashlineEdits("same\nsame\n", edits)).toThrow("[E_MULTI_MATCH]");
  });
});
