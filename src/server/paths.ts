import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Works both from src/ (run with node directly) and from the bundled dist/cli.js.
function findPkgRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, "utf8")).bin?.penna) return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error("Cannot find the penna package root.");
    dir = up;
  }
}

export const PKG_ROOT = findPkgRoot();

export function pkgPath(...parts: string[]): string {
  return path.join(PKG_ROOT, ...parts);
}

const require = createRequire(path.join(PKG_ROOT, "package.json"));

/** Directory of an installed dependency. */
export function resolveDep(name: string): string {
  return path.dirname(require.resolve(name + "/package.json"));
}
