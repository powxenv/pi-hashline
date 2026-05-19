import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { executeAstSearch } from "../src/ast-search/tool";
import { executeFind } from "../src/find/tool";
import { executeLs } from "../src/ls/tool";
import { buildSyntaxRegressionWarning } from "../src/shared/syntax";
import { generateMap } from "../src/filemap/extract";
import { getCachedFileMap } from "../src/filemap/cache";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-hashline-tools-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ls and find tools", () => {
  test("ls is deterministic, includes dotfiles by default, and handles symlinks", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await writeFile(join(root, "README.md"), "hello\n");
    await symlink(join(root, "missing"), join(root, "broken-link"));

    const result = await executeLs({ rawParams: { path: ".", long: true }, cwd: root });
    const text = result.content[0]?.text ?? "";

    expect(text.split("\n")).toEqual([
      "directory         - src/",
      "file            9 B .env",
      "symlink           - broken-link",
      "file            6 B README.md",
    ]);
    expect(result.details).toEqual({ totalEntries: 4, returnedEntries: 4, truncated: false });
  });

  test("find respects gitignore by default and supports ignored files when disabled", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, ".gitignore"), "dist/\n");
    await writeFile(join(root, "src", "app.ts"), "export const app = 1;\n");
    await writeFile(join(root, "dist", "bundle.ts"), "export const bundle = 1;\n");

    const defaultResult = await executeFind({ rawParams: { pattern: "*.ts" }, cwd: root });
    expect(defaultResult.content[0]?.text).toBe("src/app.ts");

    const ignoredResult = await executeFind({
      rawParams: { pattern: "*.ts", respectGitignore: false },
      cwd: root,
    });
    expect(ignoredResult.content[0]?.text).toBe(["dist/bundle.ts", "src/app.ts"].join("\n"));
  });

  test("find supports depth, regex, limits, and bad regex errors", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "a"));
    await mkdir(join(root, "a", "b"));
    await writeFile(join(root, "a", "one.ts"), "export const one = 1;\n");
    await writeFile(join(root, "a", "b", "two.test.ts"), "export const two = 2;\n");

    const shallow = await executeFind({ rawParams: { regex: "one|two", maxDepth: 1 }, cwd: root });
    expect(shallow.content[0]?.text).toBe("a/one.ts");

    const limited = await executeFind({ rawParams: { pattern: "*.ts", limit: 1 }, cwd: root });
    expect(limited.details.truncated).toBe(true);
    expect(limited.content[0]?.text).toContain("[Showing 1 of 2 files.");

    await expect(executeFind({ rawParams: { regex: "[" }, cwd: root })).rejects.toThrow(
      "[E_BAD_REGEX]",
    );
  });
});

describe("ast_search", () => {
  test("finds TypeScript and TSX structural patterns with anchors", async () => {
    const root = await createTempRoot();
    await writeFile(join(root, "app.ts"), "const a = foo(1);\nfoo(2);\nbar(3);\n");
    await writeFile(
      join(root, "view.tsx"),
      "export const View = () => <Button label={foo(3)} />;\n",
    );

    const result = await executeAstSearch({
      rawParams: { pattern: "foo($ARG)", limit: 3 },
      cwd: root,
    });
    const text = result.content[0]?.text ?? "";

    expect(result.details.matches).toBe(3);
    expect(text).toContain("app.ts:1#");
    expect(text).toContain("const a = foo(1);");
    expect(text).toContain("app.ts:2#");
    expect(text).toContain("foo(2);");
    expect(text).toContain("view.tsx:1#");
  });

  test("respects gitignore and reports unsupported files", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await writeFile(join(root, "main.ts"), "target(1);\n");
    await writeFile(join(root, "notes.txt"), "target(2);\n");
    await writeFile(join(root, "ignored", "main.ts"), "target(3);\n");

    const result = await executeAstSearch({ rawParams: { pattern: "target($A)" }, cwd: root });
    expect(result.details.matches).toBe(1);
    expect(result.details.unsupportedFiles).toBe(2);
    expect(result.content[0]?.text).toContain("main.ts:1#");
    expect(result.content[0]?.text).not.toContain("target(3)");
  });

  test("supports ast-grep rule objects with pattern selectors", async () => {
    const root = await createTempRoot();
    await writeFile(join(root, "rules.ts"), "const value = 1;\nlet other = 2;\n");

    const result = await executeAstSearch({
      rawParams: {
        rule: {
          pattern: {
            context: "const $NAME = $VALUE",
            selector: "lexical_declaration",
          },
        },
      },
      cwd: root,
    });
    const text = result.content[0]?.text ?? "";

    expect(result.details.matches).toBe(1);
    expect(text).toContain("const value = 1;");
    expect(text).not.toContain("let other = 2;");
  });

  test("supports dynamic ast-grep language packages", async () => {
    const root = await createTempRoot();
    await writeFile(join(root, "script.py"), "def run(value):\n    return value\nrun(1)\n");
    await writeFile(join(root, "main.rs"), "fn main() {\n    run(2);\n}\n");

    const pythonResult = await executeAstSearch({
      rawParams: { pattern: "run($ARG)", language: "python", path: "script.py" },
      cwd: root,
    });
    const rustResult = await executeAstSearch({
      rawParams: { pattern: "run($ARG)", language: "rust", path: "main.rs" },
      cwd: root,
    });

    expect(pythonResult.details.matches).toBe(1);
    expect(pythonResult.content[0]?.text).toContain("run(1)");
    expect(rustResult.details.matches).toBe(1);
    expect(rustResult.content[0]?.text).toContain("run(2);");
  });

  test("rejects invalid rule objects early", async () => {
    const root = await createTempRoot();
    await writeFile(join(root, "rules.ts"), "const value = 1;\n");

    await expect(
      executeAstSearch({
        rawParams: { pattern: "foo($A)", rule: { pattern: "bar($A)" } },
        cwd: root,
      }),
    ).rejects.toThrow('either "pattern" or "rule"');
  });
});

describe("syntax validation and file maps", () => {
  test("detects syntax regressions without warning for pre-existing errors", () => {
    expect(
      buildSyntaxRegressionWarning({
        filePath: "sample.ts",
        before: "export const value = 1;\n",
        after: "export const = ;\n",
      }),
    ).toContain("Syntax validation warning");

    expect(
      buildSyntaxRegressionWarning({
        filePath: "sample.ts",
        before: "export const = ;\n",
        after: "export const = ;\n",
      }),
    ).toBeNull();
  });

  test("extracts maps for TSX, Java, Swift, Shell, and Clojure", () => {
    const tsx = generateMap("export const View = () => <div />;\n", "view.tsx", 38);
    const java = generateMap(
      'public class User {\n  public String name() { return ""; }\n}\n',
      "User.java",
      64,
    );
    const swift = generateMap(
      'struct User {\n  func name() -> String { "" }\n}\n',
      "User.swift",
      48,
    );
    const shell = generateMap("deploy() {\n  echo ok\n}\n", "deploy.sh", 23);
    const clojure = generateMap("(ns demo.core)\n(defn run [] 1)\n", "core.clj", 31);

    expect(tsx?.symbols.map((symbol) => symbol.name)).toContain("View");
    expect(java?.symbols.map((symbol) => symbol.name)).toContain("User");
    expect(swift?.symbols.map((symbol) => symbol.name)).toContain("User");
    expect(shell?.symbols.map((symbol) => symbol.name)).toContain("deploy");
    expect(clojure?.symbols.map((symbol) => symbol.name)).toEqual(["demo.core", "run"]);
  });

  test("prunes persistent map cache by file count", async () => {
    const root = await createTempRoot();
    const cacheDir = join(root, "cache");
    const previousCacheDir = process.env["PI_HASHLINE_MAP_CACHE_DIR"];
    const previousMaxFiles = process.env["PI_HASHLINE_MAP_CACHE_MAX_FILES"];
    process.env["PI_HASHLINE_MAP_CACHE_DIR"] = cacheDir;
    process.env["PI_HASHLINE_MAP_CACHE_MAX_FILES"] = "2";

    try {
      for (let index = 0; index < 4; index++) {
        const filePath = join(root, `file-${index}.ts`);
        const content = `export const value${index} = ${index};\n`;
        await writeFile(filePath, content);
        await getCachedFileMap({
          filePath,
          content,
          totalBytes: Buffer.byteLength(content, "utf8"),
        });
      }

      const cacheFiles = (await readdir(cacheDir)).filter((entry) => entry.endsWith(".json"));
      expect(cacheFiles.length).toBeLessThanOrEqual(2);
    } finally {
      if (previousCacheDir === undefined) delete process.env["PI_HASHLINE_MAP_CACHE_DIR"];
      else process.env["PI_HASHLINE_MAP_CACHE_DIR"] = previousCacheDir;
      if (previousMaxFiles === undefined) delete process.env["PI_HASHLINE_MAP_CACHE_MAX_FILES"];
      else process.env["PI_HASHLINE_MAP_CACHE_MAX_FILES"] = previousMaxFiles;
    }
  });
});
