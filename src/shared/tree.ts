import type { NodePatch, PennaDoc, PennaNode, PennaPage } from "./types.ts";

export interface Located {
  node: PennaNode;
  parent: PennaNode | PennaPage;
  page: PennaPage;
  /** The top-level node that contains this one, or the node itself. */
  top: PennaNode;
}

export function isPage(x: PennaNode | PennaPage): x is PennaPage {
  return !("type" in x);
}

/** Anything that finds a node by id. A `Map<string, Located>` is one. */
export interface NodeLookup {
  get(id: string): Located | undefined;
}

/** Add `node` and its descendants to `map`. */
export function indexInto(map: Map<string, Located>, node: PennaNode, parent: PennaNode | PennaPage, page: PennaPage, top: PennaNode): void {
  map.set(node.id, { node, parent, page, top });
  if (node.children) for (const c of node.children) indexInto(map, c, node, page, top);
}

/** Map of every node id in the document to its location. */
export function indexDoc(doc: PennaDoc): Map<string, Located> {
  const map = new Map<string, Located>();
  for (const page of doc.pages) for (const n of page.children) indexInto(map, n, page, page, n);
  return map;
}

/** Search below `root` (excluding root) for a node whose id or name matches. */
export function findDescendant(root: PennaNode | PennaPage, key: string): PennaNode | undefined {
  // Breadth-first so the shallowest match wins, which is what people expect from names.
  const queue = [...(root.children ?? [])];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n.id === key || n.name === key) return n;
    if (n.children) for (const c of n.children) queue.push(c);
  }
  return undefined;
}

export function applyPatch(node: PennaNode, patch: NodePatch): void {
  for (const k in patch) {
    const key = k as keyof NodePatch;
    if (key === "id" || key === "type") continue;
    const v = patch[key];
    if (key === "style") {
      const style = { ...(node.style ?? {}) };
      for (const s in v as Record<string, unknown>) {
        const sv = (v as Record<string, string | number | null>)[s];
        if (sv === null || sv === undefined) delete style[s];
        else style[s] = sv;
      }
      node.style = style;
      if (Object.keys(style).length === 0) delete node.style;
    } else if (v === null || v === undefined) {
      delete (node as unknown as Record<string, unknown>)[key];
    } else {
      (node as unknown as Record<string, unknown>)[key] = v;
    }
  }
}

function prefixIds(node: PennaNode, prefix: string): PennaNode {
  const copy: PennaNode = { ...node, id: prefix + "/" + node.id };
  if (node.children) copy.children = node.children.map((c) => prefixIds(c, prefix));
  return copy;
}

/**
 * Expand a component instance into a concrete subtree. Descendant ids become
 * `instanceId/originalId` so they stay addressable. Nested refs are left in place;
 * renderers expand them when they reach them.
 */
export function expandRef(inst: PennaNode, index: NodeLookup): PennaNode | undefined {
  const comp = inst.ref ? index.get(inst.ref)?.node : undefined;
  if (!comp) return undefined;
  const root: PennaNode = {
    ...comp,
    id: inst.id,
    name: inst.name ?? comp.name,
    component: undefined,
    x: inst.x,
    y: inst.y,
    children: comp.children?.map((c) => prefixIds(c, inst.id)),
  };
  if (inst.style) root.style = { ...(comp.style ?? {}), ...inst.style };
  for (const k of ["class", "text", "src", "icon", "svg", "theme", "hidden", "state", "on"] as const) {
    if (inst[k] !== undefined) (root as unknown as Record<string, unknown>)[k] = inst[k];
  }
  if (inst.overrides) {
    for (const key in inst.overrides) {
      const target = findDescendant(root, inst.id + "/" + key) ?? findDescendant(root, key);
      if (target) applyPatch(target, inst.overrides[key]);
    }
  }
  return root;
}

export function walk(nodes: PennaNode[], fn: (n: PennaNode, depth: number, parent?: PennaNode) => void | false, depth = 0, parent?: PennaNode) {
  for (const n of nodes) {
    if (fn(n, depth, parent) === false) continue;
    if (n.children) walk(n.children, fn, depth + 1, n);
  }
}

/** Find a component by id or name, preferring nodes marked as components. */
export function findComponent(doc: PennaDoc, key: string, index?: NodeLookup): PennaNode | undefined {
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

/** Ids of the components that `node` and its descendants instantiate directly. */
export function refsIn(node: PennaNode, out: string[] = []): string[] {
  if (node.type === "ref" && node.ref) out.push(node.ref);
  if (node.overrides) {
    for (const k in node.overrides) {
      const patch = node.overrides[k];
      if (typeof patch.ref === "string") out.push(patch.ref);
      if (patch.children) for (const c of patch.children) refsIn(c, out);
    }
  }
  if (node.children) for (const c of node.children) refsIn(c, out);
  return out;
}

/**
 * The smallest document that renders `id` (a page or a node) the same way `doc` does:
 * the page or the top-level node that holds it, plus every top-level node holding a
 * component it uses, directly or through other components.
 */
export function renderSubset(doc: PennaDoc, index: NodeLookup, id: string): PennaDoc {
  const keep = new Map<string, Set<PennaNode>>();
  const add = (loc: Located) => {
    let set = keep.get(loc.page.id);
    if (!set) keep.set(loc.page.id, (set = new Set()));
    set.add(loc.top);
  };
  const queue: string[] = [];
  const page = doc.pages.find((p) => p.id === id);
  if (page) {
    keep.set(page.id, new Set(page.children));
    for (const n of page.children) refsIn(n, queue);
  } else {
    const loc = index.get(id);
    if (loc) {
      add(loc);
      refsIn(loc.node, queue);
    }
  }
  const seen = new Set<string>();
  while (queue.length) {
    const ref = queue.pop()!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const loc = index.get(ref);
    if (!loc) continue;
    add(loc);
    refsIn(loc.node, queue);
  }
  const pages = doc.pages.flatMap((p) => {
    const set = keep.get(p.id);
    return set ? [{ id: p.id, name: p.name, children: p.children.filter((n) => set.has(n)) }] : [];
  });
  return { version: 2, variables: doc.variables, themes: doc.themes, keyframes: doc.keyframes, pages };
}
