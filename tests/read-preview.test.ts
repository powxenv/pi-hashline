import { describe, expect, test } from "bun:test";
import { formatHashlineReadPreview } from "../src/read/tool";

describe("read preview", () => {
  test("renders hashline anchors", () => {
    const preview = formatHashlineReadPreview("alpha\nbeta\n", {});
    expect(preview.text).toContain(":alpha");
    expect(preview.text).toContain(":beta");
  });

  test("supports offset and limit", () => {
    const preview = formatHashlineReadPreview("a\nb\nc\nd\n", { offset: 2, limit: 2 });
    expect(preview.text).toContain(":b");
    expect(preview.text).toContain(":c");
    expect(preview.text).not.toContain(":a");
    expect(preview.nextOffset).toBe(4);
  });

  test("does not suggest continuation for symbol-style bounded reads", () => {
    const preview = formatHashlineReadPreview("a\nb\nc\nd\n", {
      offset: 2,
      limit: 1,
      continuation: false,
    });
    expect(preview.text).not.toContain("Use offset=");
    expect(preview.nextOffset).toBeUndefined();
  });
});
