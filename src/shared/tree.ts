import type { NodePatch, PennaDoc, PennaNode, PennaPage } from "./types.ts";

export interface Located {
  node: PennaNode;
  parent: PennaNode | PennaPage;
  page: PennaPage;
}

export function isPage(x: PennaNode | PennaPage): x is PennaPage {
  return !("type" in x);
}

/** Map of every node id in the document to its location. */
export function indexDoc(doc: PennaDoc): Map<string, Located> {
  const map = new Map<string, Located>();
  const visit = (node: PennaNode, parent: PennaNode | PennaPage, page: PennaPage) => {
    map.set(node.id, { node, parent, page });
    if (node.children) for (const c of node.children) visit(c, node, page);
  };
  for (const page of doc.pages) for (const n of page.children) visit(n, page, page);
  return map;
}

/** Search below `root` (excluding root) for a node whose id or name matches. */
export function findDescendant(root: PennaNode | PennaPage, key: string): PennaNode | undefined {
  // Breadth-first so the shallowest match wins, which is what people expect from names.
  const queue = [...(root.children ?? [])];
  while (queue.length) {
    const n = queue.shift()!;
    if (n.id === key || n.name === key) return n;
    if (n.children) queue.push(...n.children);
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
export function expandRef(inst: PennaNode, index: Map<string, Located>): PennaNode | undefined {
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
  for (const k of ["class", "text", "src", "icon", "svg", "theme", "hidden"] as const) {
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

/** Ids of components that `node` uses, directly or through nested instances. */
export function refsUsed(node: PennaNode, index: Map<string, Located>, out = new Set<string>()): Set<string> {
  walk([node], (n) => {
    if (n.type === "ref" && n.ref && !out.has(n.ref)) {
      out.add(n.ref);
      const comp = index.get(n.ref)?.node;
      if (comp) refsUsed(comp, index, out);
    }
  });
  return out;
}
