import { describe, expect, test } from "bun:test";
import { parseEditRequest } from "../src/edit/tool";

describe("edit tool request parsing", () => {
  test("recovers missing op for exact text replacement", () => {
    const request = parseEditRequest({
      path: "src/index.ts",
      edits: [{ oldText: "alpha", newText: "beta" }],
    });

    expect(request.edits).toEqual([{ op: "replace_text", oldText: "alpha", newText: "beta" }]);
  });

  test("recovers missing op for anchored replacement", () => {
    const request = parseEditRequest({
      path: "src/index.ts",
      edits: [{ pos: "1#ZZ", lines: ["beta"] }],
    });

    expect(request.edits).toEqual([{ op: "replace", pos: "1#ZZ", lines: ["beta"] }]);
  });

  test("supports remove alias for anchored deletion", () => {
    const request = parseEditRequest({
      path: "src/index.ts",
      edits: [{ op: "remove", pos: "1#ZZ", end: "2#ZZ" }],
    });

    expect(request.edits).toEqual([{ op: "replace", pos: "1#ZZ", end: "2#ZZ", lines: null }]);
  });
});
