import fs from "node:fs";
import path from "node:path";
import { compile } from "tailwindcss";
import type { PennaNode } from "../shared/types.ts";
import { resolveDep } from "./paths.ts";

type Compiler = Awaited<ReturnType<typeof compile>>;

/**
 * Compiles the Tailwind classes used in designs to one stylesheet, so the viewer does
 * not have to. Builds are incremental: the compiler remembers every class it has seen
 * and only generates new ones, so the stylesheet only grows while the server runs.
 */
export class Tailwind {
  private compiler: Compiler;

  private constructor(compiler: Compiler) {
    this.compiler = compiler;
  }

  static async create(): Promise<Tailwind> {
    const dir = resolveDep("tailwindcss");
    const compiler = await compile(`@import "tailwindcss";`, {
      base: dir,
      loadStylesheet: async (id, base) => {
        const file = id === "tailwindcss" ? path.join(dir, "index.css") : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    });
    return new Tailwind(compiler);
  }

  /** The stylesheet for every class seen so far, including `classes`. */
  build(classes: Iterable<string>): string {
    return this.compiler.build([...classes]);
  }
}

/** Every class name used in `nodes` and their descendants. */
export function classesIn(nodes: PennaNode[], out = new Set<string>()): Set<string> {
  const add = (cls: string | undefined) => {
    if (cls) for (const c of cls.split(/\s+/)) if (c) out.add(c);
  };
  const visit = (n: PennaNode) => {
    add(n.class);
    if (n.spans) for (const s of n.spans) add(s.class);
    if (n.overrides) for (const k in n.overrides) add(n.overrides[k].class);
    if (n.children) for (const c of n.children) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}
