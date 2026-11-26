import { indexInto, type Located } from "../shared/tree.ts";
import type { PennaDoc, PennaNode, PennaPage } from "../shared/types.ts";
import { frameKey, type DocMessage } from "../shared/wire.ts";

/**
 * The viewer's copy of the document, built from the server's messages. Each message
 * carries only the top-level nodes that changed, and this keeps everything else as it
 * was: unchanged nodes and pages keep their objects, and the id index is updated only
 * for the nodes that came or went. It has no DOM code, so it runs in tests.
 */
export class DocModel {
  doc: PennaDoc | null = null;
  /** Every node of the document, by id. */
  readonly index = new Map<string, Located>();
  /** Changes whenever the themes do. */
  themesKey = "null";
  /** Top-level nodes by frameKey, with the server's hash of each. */
  private frames = new Map<string, { node: PennaNode; hash: string }>();
  /** Page objects, kept across messages so index entries stay valid. */
  private pages = new Map<string, PennaPage>();

  /** The server's hash of a top-level node, which changes when anything inside it does. */
  hashOf(page: string, id: string): string | undefined {
    return this.frames.get(frameKey(page, id))?.hash;
  }

  /**
   * Take in a message. Returns the ids of the pages whose name, top-level nodes, or
   * order changed.
   */
  apply(msg: DocMessage): Set<string> {
    const changed = new Set<string>();
    const gone: PennaNode[] = [];
    const came: { key: string; page: string; node: PennaNode }[] = [];
    if (msg.full) {
      this.frames.clear();
      this.index.clear();
    }
    for (const f of msg.nodes) {
      const key = frameKey(f.page, f.node.id);
      const old = this.frames.get(key);
      if (old) gone.push(old.node);
      this.frames.set(key, { node: f.node, hash: f.hash });
      came.push({ key, page: f.page, node: f.node });
      changed.add(f.page);
    }

    const live = new Map<string, { node: PennaNode; hash: string }>();
    const pages = new Map<string, PennaPage>();
    for (const p of msg.pages) {
      let page = this.pages.get(p.id);
      if (!page) {
        page = { id: p.id, name: p.name, children: [] };
        changed.add(p.id);
      }
      const children: PennaNode[] = [];
      for (const id of p.nodes) {
        const key = frameKey(p.id, id);
        const f = this.frames.get(key);
        if (!f) continue;
        live.set(key, f);
        children.push(f.node);
      }
      if (page.name !== p.name || children.length !== page.children.length || children.some((n, i) => n !== page.children[i])) changed.add(p.id);
      page.name = p.name;
      page.children = children;
      pages.set(p.id, page);
    }
    for (const id of this.pages.keys()) if (!pages.has(id)) changed.add(id);
    for (const [key, f] of this.frames) if (!live.has(key)) gone.push(f.node);
    this.frames = live;
    this.pages = pages;

    // Remove before adding: a node that moved to another frame is in both lists.
    const remove = (n: PennaNode) => {
      this.index.delete(n.id);
      if (n.children) for (const c of n.children) remove(c);
    };
    for (const n of gone) remove(n);
    if (msg.full) {
      for (const page of pages.values()) for (const n of page.children) indexInto(this.index, n, page, page, n);
    } else {
      for (const f of came) {
        const page = pages.get(f.page);
        if (page && live.has(f.key)) indexInto(this.index, f.node, page, page, f.node);
      }
    }

    this.doc = { version: 2, variables: msg.variables, themes: msg.themes, pages: [...pages.values()] };
    this.themesKey = JSON.stringify(msg.themes ?? null);
    return changed;
  }
}
