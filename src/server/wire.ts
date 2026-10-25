import crypto from "node:crypto";
import type { PennaDoc, PennaNode } from "../shared/types.ts";
import type { DocMessage } from "../shared/wire.ts";
import { classesIn, type Tailwind } from "./tailwind.ts";

interface PageState {
  /** Hash of each top-level node's JSON, by id. */
  hashes: Map<string, string>;
  classes: Set<string>;
}

const hash = (node: PennaNode) => crypto.createHash("sha1").update(JSON.stringify(node)).digest("base64url").slice(0, 16);

/**
 * Builds the document messages for viewers. Every viewer receives every update, so one
 * shared record of what was last sent lets updates carry only the top-level nodes that
 * changed. Only pages whose files changed are hashed again.
 */
export class Wire {
  private pages = new Map<string, PageState>();
  private tailwind: Tailwind;
  private project: string;
  /** The stylesheet for the current document. */
  css = "";

  constructor(project: string, tailwind: Tailwind) {
    this.project = project;
    this.tailwind = tailwind;
  }

  /**
   * Record a new version of the document and return the diff from the previous one.
   * `files` lists the changed paths in `.penna/`; omit it to compare every page.
   */
  update(doc: PennaDoc, rev: number, files?: Set<string>): DocMessage {
    const nodes: DocMessage["nodes"] = [];
    const next = new Map<string, PageState>();
    for (const p of doc.pages) {
      const prev = this.pages.get(p.id);
      if (prev && files && !files.has(`pages/${p.id}.json`)) {
        next.set(p.id, prev);
        continue;
      }
      const state: PageState = { hashes: new Map(), classes: classesIn(p.children) };
      for (const n of p.children) {
        const h = hash(n);
        state.hashes.set(n.id, h);
        if (prev?.hashes.get(n.id) !== h) nodes.push({ page: p.id, hash: h, node: n });
      }
      next.set(p.id, state);
    }
    this.pages = next;
    const msg = this.message(doc, rev, false, nodes);
    const css = this.build();
    if (css !== this.css) msg.css = this.css = css;
    return msg;
  }

  /** The whole document, for a viewer that just connected. */
  full(doc: PennaDoc, rev: number): DocMessage {
    const nodes = doc.pages.flatMap((p) => p.children.map((n) => ({ page: p.id, hash: this.pages.get(p.id)?.hashes.get(n.id) ?? hash(n), node: n })));
    return { ...this.message(doc, rev, true, nodes), css: this.css };
  }

  private build(): string {
    const all = new Set<string>();
    for (const s of this.pages.values()) for (const c of s.classes) all.add(c);
    return this.tailwind.build(all);
  }

  private message(doc: PennaDoc, rev: number, full: boolean, nodes: DocMessage["nodes"]): DocMessage {
    return {
      t: "doc",
      project: this.project,
      rev,
      full,
      variables: doc.variables ?? {},
      themes: doc.themes,
      pages: doc.pages.map((p) => ({ id: p.id, name: p.name, nodes: p.children.map((n) => n.id) })),
      nodes,
    };
  }
}
