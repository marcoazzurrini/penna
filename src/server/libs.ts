import { indexDoc, walk, type Located } from "../shared/tree.ts";
import type { PennaDoc, PennaNode, RenderDoc } from "../shared/types.ts";
import type { Store } from "./store.ts";

/** Split `file#id` into its parts. Local refs have no file. */
export function splitRef(ref: string): [file: string | undefined, id: string] {
  const i = ref.indexOf("#");
  return i < 0 ? [undefined, ref] : [ref.slice(0, i), ref.slice(i + 1)];
}

/** Find a component by id or name, preferring nodes marked as components. */
export function findComponent(doc: PennaDoc, key: string, index?: Map<string, Located>): PennaNode | undefined {
  const byId = (index ?? indexDoc(doc)).get(key)?.node;
  if (byId) return byId;
  let comp: PennaNode | undefined;
  let other: PennaNode | undefined;
  for (const p of doc.pages) {
    walk(p.children, (n) => {
      if (n.name !== key) return;
      if (n.component) comp ??= n;
      else other ??= n;
    });
  }
  return comp ?? other;
}

export interface WithLibraries {
  doc: RenderDoc;
  /** Every other file the document depends on, directly or through nested instances. */
  files: Set<string>;
}

/**
 * Prepare `doc` (the contents of `file`) for rendering: copy in the components it uses
 * from other files, and merge in those files' variables and themes. The document's own
 * variables win over library ones.
 */
export function withLibraries(store: Store, file: string, doc: PennaDoc): WithLibraries {
  const libs: Record<string, PennaNode> = {};
  const files = new Set<string>();
  const libDocs: PennaDoc[] = [];
  const indexes = new Map<string, Map<string, Located>>();
  const queue: string[] = [];

  // Refs inside a library component are relative to its own file.
  const qualify = (ref: string, from: string | undefined) => {
    const [f, id] = splitRef(ref);
    const target = f ?? from;
    return !target || target === file ? id : `${target}#${id}`;
  };
  const collect = (nodes: PennaNode[]) =>
    walk(nodes, (n) => {
      if (n.type === "ref" && n.ref?.includes("#") && !(n.ref in libs)) queue.push(n.ref);
    });

  for (const p of doc.pages) collect(p.children);
  while (queue.length) {
    const key = queue.pop()!;
    if (key in libs) continue;
    const [f, id] = splitRef(key);
    const lib = store.get(f!);
    if (!lib) continue;
    if (!files.has(f!)) {
      files.add(f!);
      libDocs.push(lib);
      indexes.set(f!, indexDoc(lib));
    }
    const node = indexes.get(f!)!.get(id)?.node;
    if (!node) continue;
    const copy = structuredClone(node);
    walk([copy], (n) => {
      if (n.type === "ref" && n.ref) n.ref = qualify(n.ref, f);
    });
    libs[key] = copy;
    collect([copy]);
  }
  if (!files.size) return { doc, files };

  const variables = Object.assign({}, ...libDocs.map((d) => d.variables ?? {}), doc.variables ?? {});
  const themes: Record<string, Record<string, string>> = {};
  for (const d of [...libDocs, doc]) {
    for (const name in d.themes ?? {}) themes[name] = { ...(themes[name] ?? {}), ...d.themes![name] };
  }
  return { doc: { ...doc, variables, themes, libs }, files };
}
