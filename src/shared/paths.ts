import { isAbsolute, resolve as resolvePath } from "node:path";

function expandPath(filePath: string): string {
  if (filePath === "~") {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
    return home;
  }
  if (filePath.startsWith("~/")) {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
    return home + filePath.slice(1);
  }
  return filePath;
}

export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}
