import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { collectProjectFiles, matchesProjectGlob } from "../src/shared/project-files";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-hashline-files-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project file collection", () => {
  test("respects gitignore and include globs", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, ".gitignore"), "ignored/\n*.log\n");
    await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(join(root, "src", "app.log"), "value\n");
    await writeFile(join(root, "ignored", "hidden.ts"), "export const hidden = 1;\n");

    const result = await collectProjectFiles({
      rootPath: root,
      cwd: root,
      signal: undefined,
      include: ["*.ts"],
    });

    expect(result.files.map((file) => relative(root, file))).toEqual([join("src", "app.ts")]);
  });

  test("can search ignored directories when gitignore handling is disabled", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await writeFile(join(root, "ignored", "hidden.ts"), "export const hidden = 1;\n");

    const result = await collectProjectFiles({
      rootPath: root,
      cwd: root,
      signal: undefined,
      include: ["*.ts"],
      respectGitignore: false,
    });

    expect(result.files.map((file) => relative(root, file))).toEqual([
      join("ignored", "hidden.ts"),
    ]);
  });

  test("does not hardcode dependency or build directory skips", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "node_modules", "pkg.ts"), "export const pkg = 1;\n");
    await writeFile(join(root, "dist", "bundle.ts"), "export const bundle = 1;\n");

    const result = await collectProjectFiles({
      rootPath: root,
      cwd: root,
      signal: undefined,
      include: ["*.ts"],
    });

    expect(result.files.map((file) => relative(root, file)).sort()).toEqual([
      join("dist", "bundle.ts"),
      join("node_modules", "pkg.ts"),
    ]);
  });

  test("supports escaped gitignore prefixes and spaces", async () => {
    const root = await createTempRoot();
    await writeFile(
      join(root, ".gitignore"),
      "\\#config\n\\!literal.ts\nspace\\ file.ts\n*.log\n!important.log\n",
    );
    await writeFile(join(root, "#config"), "secret\n");
    await writeFile(join(root, "!literal.ts"), "export const literal = 1;\n");
    await writeFile(join(root, "space file.ts"), "export const spaced = 1;\n");
    await writeFile(join(root, "ignored.log"), "ignored\n");
    await writeFile(join(root, "important.log"), "kept\n");
    await writeFile(join(root, "kept.ts"), "export const kept = 1;\n");

    const result = await collectProjectFiles({
      rootPath: root,
      cwd: root,
      signal: undefined,
    });

    expect(result.files.map((file) => relative(root, file)).sort()).toEqual([
      ".gitignore",
      "important.log",
      "kept.ts",
    ]);
  });

  test("matches basename and path globs", () => {
    expect(matchesProjectGlob("src/app.ts", "*.ts")).toBe(true);
    expect(matchesProjectGlob("src/app.ts", "src/*.ts")).toBe(true);
    expect(matchesProjectGlob("src/app.ts", "src/**/*.ts")).toBe(true);
    expect(matchesProjectGlob("src/nested/app.ts", "src/**/*.ts")).toBe(true);
    expect(matchesProjectGlob("tests/app.ts", "src/*.ts")).toBe(false);
  });
});
