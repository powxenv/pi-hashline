import { describe, expect, test } from "bun:test";
import { buildChangedResponse } from "../src/edit/response";

describe("edit response", () => {
  test("honors ranged return mode", () => {
    const response = buildChangedResponse({
      path: "sample.txt",
      originalNormalized: "alpha\nbeta\n",
      result: "alpha\nBETA\ngamma\n",
      firstChangedLine: 2,
      lastChangedLine: 3,
      snapshotId: "snapshot",
      warnings: undefined,
      compatibilityDetails: undefined,
      returnMode: "ranges",
      returnRanges: [{ start: 2, end: 3 }],
    });

    const text = response.content[0]?.text ?? "";
    expect(text).toContain("--- Anchors 2-3 ---");
    expect(text).toContain(":BETA");
    expect(text).toContain(":gamma");
  });
});
