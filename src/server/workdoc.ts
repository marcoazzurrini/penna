import { applyPatch, findDescendant, type Located, type NodeLookup } from "../shared/tree.ts";
import type { NodePatch, PennaDoc, PennaNode, PennaPage } from "../shared/types.ts";
import { pageSlug } from "./store.ts";

/** What a path names: a page, a node, or a part of a component instance. */
export type Target =
  | { kind: "page"; page: PennaPage }
  | { kind: "node"; loc: Located }
  | { kind: "override"; inst: PennaNode; key: string };

/** The nodes of one page, by id and by name. */
class PageIndex {
  readonly ids = new Map<string, Located>();
  readonly names = new Map<string, Set<PennaNode>>();

  constructor(page: PennaPage) {
    for (const n of page.children) this.add(n, page, page, n);
  }

  add(node: PennaNode, parent: PennaNode | PennaPage, page: PennaPage, top: PennaNode) {
    this.ids.set(node.id, { node, parent, page, top });
    this.name(node, node.name);
    if (node.children) for (const c of node.children) this.add(c, node, page, top);
  }

  remove(node: PennaNode) {
    this.ids.delete(node.id);
    this.unname(node, node.name);
    if (node.children) for (const c of node.children) this.remove(c);
  }

  name(node: PennaNode, name: string | undefined) {
    if (name === undefined) return;
    let set = this.names.get(name);
    if (!set) this.names.set(name, (set = new Set()));
    set.add(node);
  }

  unname(node: PennaNode, name: string | undefined) {
    if (name === undefined) return;
    const set = this.names.get(name);
    if (set?.delete(node) && !set.size) this.names.delete(name);
  }
}

// Stored pages are frozen and keep their identity until their file changes, so their
// indexes are built once and shared by every session.
const sharedIndexes = new WeakMap<PennaPage, PageIndex>();

/**
 * A session's working copy of the document. It starts as a view of the stored, frozen
 * document and copies a page the first time that page is changed, so a snippet costs
 * only as much as the pages it edits. Lookups by id and by name use per-page indexes
 * that are kept up to date as nodes move.
 *
 * Copying a page replaces its node objects. Take a node through `ownNode` or
 * `ownContainer` before changing it, and use what they return.
 */
export class WorkDoc implements NodeLookup {
  readonly doc: PennaDoc;
  changed = false;
  /** Ids of the pages this session copied or created. Only these can differ from the store. */
  readonly touched = new Set<string>();
  /** The page that paths resolve against first. */
  pageId: string;
  private owned = new Map<PennaPage, PageIndex>();
  private ownVariables = false;
  private ownThemes = false;
  private reserved: string[];

  /** `reserved` lists page ids that new pages must not take. */
  constructor(base: PennaDoc, viewing: string | null, reserved: string[] = []) {
    this.doc = { version: 2, variables: base.variables, themes: base.themes, pages: [...base.pages] };
    this.reserved = reserved;
    this.pageId = this.doc.pages.find((p) => p.id === viewing)?.id ?? this.doc.pages[0]?.id ?? this.addPage("Page 1").id;
  }

  // ---------- Lookup ----------

  private index(page: PennaPage): PageIndex {
    let pi = this.owned.get(page) ?? sharedIndexes.get(page);
    if (!pi) sharedIndexes.set(page, (pi = new PageIndex(page)));
    return pi;
  }

  get(id: string): Located | undefined {
    for (const page of this.doc.pages) {
      const hit = this.index(page).ids.get(id);
      if (hit) return hit;
    }
    return undefined;
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  currentPage(): PennaPage {
    return this.doc.pages.find((p) => p.id === this.pageId)!;
  }

  findPage(key: string): PennaPage | undefined {
    return this.doc.pages.find((p) => p.id === key) ?? this.doc.pages.find((p) => p.name === key);
  }

  /** The shallowest node with this name, on the current page first, then on the others in order. */
  private findByName(name: string): PennaNode | undefined {
    const current = this.currentPage();
    for (const page of [current, ...this.doc.pages.filter((p) => p !== current)]) {
      const set = this.index(page).names.get(name);
      if (!set) continue;
      if (set.size === 1) return set.values().next().value;
      const hit = findDescendant(page, name);
      if (hit) return hit;
    }
    return undefined;
  }

  tryResolve(path: string): Target | undefined {
    try {
      return this.resolve(path);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve an id, a name, a page, or an `ancestor/descendant` path.
   * Order: page or node ids, then node names, then page names.
   */
  resolve(path: unknown): Target {
    if (typeof path !== "string" || !path) {
      throw new Error(`Expected a node id or path string, got ${JSON.stringify(path)?.slice(0, 60)}. Pass ids, not node objects.`);
    }
    const page = this.doc.pages.find((p) => p.id === path);
    if (page) return { kind: "page", page };
    // Names may contain slashes ("Row / Course"), so at each step match the longest run
    // of segments that names a node.
    const segs = path.split("/");
    let node: PennaNode | undefined;
    let i = 0;
    for (let j = segs.length; j >= 1 && !node; j--) {
      const key = segs.slice(0, j).join("/");
      node = this.get(key)?.node ?? this.findByName(key);
      i = j;
    }
    if (!node) {
      const byName = this.findPage(path);
      if (byName) return { kind: "page", page: byName };
      throw new Error(`No node "${segs[0]}".`);
    }
    while (i < segs.length) {
      if (node.type === "ref") return { kind: "override", inst: node, key: segs.slice(i).join("/") };
      let next: PennaNode | undefined;
      let j = segs.length;
      for (; j > i && !next; j--) next = findDescendant(node, segs.slice(i, j).join("/"));
      if (!next) throw new Error(`No "${segs[i]}" inside "${node.name ?? node.id}".`);
      node = next;
      i = j + 1;
    }
    return { kind: "node", loc: this.get(node.id)! };
  }

  resolveNode(path: unknown, op: string): Located {
    const t = this.resolve(path);
    if (t.kind === "node") return t.loc;
    if (t.kind === "page") throw new Error(`${op}: "${path}" is a page, not a node.`);
    throw new Error(`${op}: "${path}" is inside a component instance. Use Update on it to set an override, or edit the component.`);
  }

  /** The page or frame that `path` names, for inserting into. */
  container(path: unknown): PennaNode | PennaPage {
    const t = this.resolve(path);
    if (t.kind === "page") return t.page;
    if (t.kind === "override") throw new Error(`Cannot insert into an instance. Override its children with Update(path, {children: [...]}) or edit the component.`);
    const n = t.loc.node;
    if (n.type === "ref") throw new Error(`"${n.name ?? n.id}" is a component instance. Insert into the component instead.`);
    if (n.type !== "frame") throw new Error(`"${n.name ?? n.id}" is a ${n.type}; only frames have children.`);
    return n;
  }

  // ---------- Copy on write ----------

  /** This session's own copy of `page`, made on first use. */
  ownPage(page: PennaPage): PennaPage {
    if (this.owned.has(page)) return page;
    const copy = structuredClone(page);
    this.doc.pages[this.doc.pages.indexOf(page)] = copy;
    this.owned.set(copy, new PageIndex(copy));
    this.touched.add(copy.id);
    return copy;
  }

  /** The location of the same node in this session's own copy of its page. */
  ownNode(loc: Located): Located {
    if (this.owned.has(loc.page)) return loc;
    return this.owned.get(this.ownPage(loc.page))!.ids.get(loc.node.id)!;
  }

  ownContainer(c: PennaNode | PennaPage): PennaNode | PennaPage {
    return "type" in c ? this.ownNode(this.get(c.id)!).node : this.ownPage(c);
  }

  variables(): Record<string, string> {
    if (!this.ownVariables) {
      this.doc.variables = { ...(this.doc.variables ?? {}) };
      this.ownVariables = true;
    }
    return this.doc.variables!;
  }

  theme(name: string): Record<string, string> {
    if (!this.ownThemes) {
      this.doc.themes = structuredClone(this.doc.themes ?? {});
      this.ownThemes = true;
    }
    return (this.doc.themes![name] ??= {});
  }

  // ---------- Changes. Nodes and pages passed in must be owned. ----------

  addPage(name: string): PennaPage {
    const page: PennaPage = { id: pageSlug(name, [...this.doc.pages.map((p) => p.id), ...this.reserved]), name, children: [] };
    this.doc.pages.push(page);
    this.owned.set(page, new PageIndex(page));
    this.touched.add(page.id);
    this.changed = true;
    return page;
  }

  removePage(page: PennaPage) {
    this.doc.pages.splice(this.doc.pages.indexOf(page), 1);
    if (this.pageId === page.id) this.pageId = this.doc.pages[0].id;
    this.changed = true;
  }

  renamePage(page: PennaPage, name: string) {
    this.ownPage(page).name = name;
    this.changed = true;
  }

  /** Put `node` into `parent` at `index`, or at the end. */
  attach(parent: PennaNode | PennaPage, node: PennaNode, index?: number) {
    const list = (parent.children ??= []);
    const i = index === undefined || index < 0 || index > list.length ? list.length : index;
    list.splice(i, 0, node);
    if ("type" in parent) {
      const loc = this.get(parent.id)!;
      this.owned.get(loc.page)!.add(node, parent, loc.page, loc.top);
    } else this.owned.get(parent)!.add(node, parent, parent, node);
    this.changed = true;
  }

  /** Take a node out of its parent. */
  detach(loc: Located) {
    const list = loc.parent.children!;
    list.splice(list.indexOf(loc.node), 1);
    this.owned.get(loc.page)!.remove(loc.node);
    this.changed = true;
  }

  /** Put `node` where `loc.node` is. */
  swap(loc: Located, node: PennaNode) {
    const list = loc.parent.children!;
    const pi = this.owned.get(loc.page)!;
    pi.remove(loc.node);
    list[list.indexOf(loc.node)] = node;
    pi.add(node, loc.parent, loc.page, loc.parent === loc.page ? node : loc.top);
    this.changed = true;
  }

  patch(loc: Located, patch: NodePatch) {
    const pi = this.owned.get(loc.page)!;
    const node = loc.node;
    const newChildren = "children" in patch;
    if (newChildren && node.children) for (const c of node.children) pi.remove(c);
    pi.unname(node, node.name);
    applyPatch(node, patch);
    pi.name(node, node.name);
    if (newChildren && node.children) for (const c of node.children) pi.add(c, node, loc.page, loc.top);
    this.changed = true;
  }

  /** Throw if the indexes no longer match the document. Used by tests. */
  verify() {
    for (const page of this.doc.pages) {
      const have = this.index(page);
      const want = new PageIndex(page);
      const where = `Index of page "${page.id}"`;
      if (have.ids.size !== want.ids.size) throw new Error(`${where} has ${have.ids.size} ids, expected ${want.ids.size}.`);
      for (const [id, w] of want.ids) {
        const h = have.ids.get(id);
        if (!h || h.node !== w.node || h.parent !== w.parent || h.page !== w.page || h.top !== w.top) throw new Error(`${where} is stale for node ${id}.`);
      }
      if (have.names.size !== want.names.size) throw new Error(`${where} has ${have.names.size} names, expected ${want.names.size}.`);
      for (const [name, w] of want.names) {
        const h = have.names.get(name);
        if (!h || h.size !== w.size || [...w].some((n) => !h.has(n))) throw new Error(`${where} is stale for name "${name}".`);
      }
    }
  }
}
