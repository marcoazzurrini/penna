import vm from "node:vm";
import { camel } from "../shared/style.ts";
import { applyPatch, expandRef, findComponent, findDescendant, indexDoc, walk, type Located } from "../shared/tree.ts";
import type { NodePatch, NodeType, PennaDoc, PennaNode, PennaPage } from "../shared/types.ts";
import type { Headless, LayoutReport } from "./headless.ts";
import { Icons } from "./icons.ts";
import { pageSlug, type Store } from "./store.ts";

export interface Edit {
  find: string;
  replace: string;
  all?: boolean;
}

export interface ExecRequest {
  code?: string;
  editId?: string;
  edits?: Edit[];
}

export interface Shot {
  id: string;
  name: string;
  png: Buffer;
}

export interface ExecResult {
  ok: boolean;
  /** Print output, created ids, warnings, and errors, ready to show the agent. */
  text: string;
  editId?: string;
  shots: Shot[];
}

const TYPES = new Set<NodeType>(["frame", "text", "image", "icon", "svg", "ref"]);
const NODE_KEYS = new Set([
  "type", "name", "x", "y", "class", "style", "text", "spans", "src", "icon", "svg", "ref",
  "overrides", "component", "theme", "hidden", "children",
]);
const MAX_OUTPUT = 24_000;
const ID_CHARS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type Target =
  | { kind: "page"; page: PennaPage }
  | { kind: "node"; loc: Located }
  | { kind: "override"; inst: PennaNode; key: string };

interface ShotJob {
  ids: string[];
  scale?: number;
}

/** Runs agent snippets against a working copy of a document and commits on success. */
export class Executor {
  private failed = new Map<string, string>();
  /** Globals assigned by snippets persist here between calls. */
  private ctx = vm.createContext({});
  /** Called just before a change is committed, with the page the snippet worked on. */
  onCommit?: (page: string) => void;

  private store: Store;
  private headless: Headless;
  private icons: Icons;
  private url: () => string;

  constructor(store: Store, headless: Headless, iconDir: string, url: () => string) {
    this.store = store;
    this.headless = headless;
    this.icons = new Icons(iconDir);
    this.url = url;
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    let code = req.code ?? "";
    if (req.editId) {
      const prev = this.failed.get(req.editId);
      if (prev === undefined) {
        return { ok: false, text: `Unknown editId "${req.editId}". Send the full snippet as code instead.`, shots: [] };
      }
      code = prev;
      for (const e of req.edits ?? []) {
        const count = code.split(e.find).length - 1;
        if (count === 0) return this.fail(req.editId, code, `Edit failed: text not found: ${JSON.stringify(e.find.slice(0, 80))}`);
        if (count > 1 && !e.all) return this.fail(req.editId, code, `Edit failed: text found ${count} times; make it unique or set all:true: ${JSON.stringify(e.find.slice(0, 80))}`);
        code = e.all ? code.split(e.find).join(e.replace) : code.replace(e.find, () => e.replace);
      }
    }
    if (!code.trim()) return { ok: false, text: "Empty snippet.", shots: [] };

    const session = new Session(this.store, this.icons, this.headless);
    const ctx = this.ctx;
    // Copy descriptors, not values, so getters like `page` stay live.
    Object.defineProperties(ctx, { ...Object.getOwnPropertyDescriptors(session.api()), page: { get: () => session.currentPageId(), configurable: true } });
    try {
      const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: "snippet.js", lineOffset: -1 });
      await script.runInContext(ctx, { timeout: 5000 });
    } catch (err) {
      let message = formatError(err);
      if (message.startsWith("ReferenceError")) message += ". Globals are listed in the penna skill (read_skill tool, or `penna skill`).";
      return this.fail(req.editId, code, message, session);
    }

    if (session.changed) {
      this.onCommit?.(session.currentPageId());
      this.store.commit(session.doc);
    }
    if (req.editId) this.failed.delete(req.editId);

    const shots: Shot[] = [];
    if (session.shotJobs.length || session.checkJobs.length) {
      const page = session.currentPageId();
      const doc = session.doc;
      try {
        for (const job of session.shotJobs) {
          for (const id of job.ids) {
            const png = await this.headless.screenshot(doc, page, id, job.scale);
            shots.push({ id, name: session.nameOf(id), png });
          }
        }
        for (const id of session.checkJobs) {
          const report = await this.headless.layout(doc, page, id);
          session.print(formatProblems(session.nameOf(id), report));
        }
      } catch (err) {
        session.warn(`Rendering failed: ${(err as Error).message}`);
      }
    }
    return { ok: true, text: session.summary(this.url()), shots };
  }

  private fail(editId: string | undefined, code: string, message: string, session?: Session): ExecResult {
    const id = editId ?? randomId(6);
    this.failed.set(id, code);
    if (this.failed.size > 50) this.failed.delete(this.failed.keys().next().value!);
    const out = session?.outputLines.length ? "\nOutput before the error:\n" + session.outputLines.join("\n") : "";
    return {
      ok: false,
      editId: id,
      text: `Error: ${message}\nNothing was changed. Fix it by calling execute with editId "${id}" and edits.${out}`,
      shots: [],
    };
  }
}

function formatError(err: unknown): string {
  // Errors thrown by snippet code come from the sandbox realm, so instanceof Error fails.
  if (!err || typeof err !== "object" || !("message" in err)) return String(err);
  const e = err as { message: string; name?: string; stack?: string };
  const m = e.stack?.match(/snippet\.js:(\d+)/);
  const prefix = e.name && e.name !== "Error" ? e.name + ": " : "";
  return prefix + e.message + (m ? ` (line ${m[1]})` : "");
}

function formatProblems(name: string, r: LayoutReport): string {
  if (!r.problems.length) return `Check ${name}: no layout problems (${r.width}×${r.height}).`;
  return `Check ${name} (${r.width}×${r.height}): ${r.problems.length} problem(s)\n` + r.problems.map((p) => "  " + p).join("\n");
}

export function randomId(len = 5): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

/** The API exposed to one snippet run. */
class Session {
  doc: PennaDoc;
  changed = false;
  outputLines: string[] = [];
  private warnings: string[] = [];
  private created: string[] = [];
  shotJobs: ShotJob[] = [];
  checkJobs: string[] = [];
  private idx: Map<string, Located> | null = null;
  private pageId: string;
  private store: Store;
  private icons: Icons;
  private headless: Headless;

  constructor(store: Store, icons: Icons, headless: Headless) {
    this.store = store;
    this.icons = icons;
    this.headless = headless;
    this.doc = structuredClone(store.get());
    this.pageId = this.doc.pages.find((p) => p.id === store.viewing)?.id ?? this.doc.pages[0]?.id ?? this.addPage("Page 1");
  }

  currentPageId() {
    return this.pageId;
  }

  private index() {
    return (this.idx ??= indexDoc(this.doc));
  }

  private dirty() {
    this.changed = true;
    this.idx = null;
  }

  print(line: string) {
    this.outputLines.push(line);
  }

  warn(msg: string) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  nameOf(id: string): string {
    const t = this.tryResolve(id);
    if (t?.kind === "node") return t.loc.node.name ?? id;
    if (t?.kind === "page") return t.page.name;
    return id;
  }

  summary(url: string): string {
    const parts: string[] = [];
    let out = this.outputLines.join("\n");
    if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + `\n… output truncated (${out.length} chars). Print less.`;
    if (out) parts.push(out);
    if (this.created.length) {
      const shown = this.created.slice(0, 60).join(", ");
      parts.push("Created: " + shown + (this.created.length > 60 ? `, … and ${this.created.length - 60} more` : ""));
    }
    if (this.warnings.length) parts.push("Warnings:\n" + this.warnings.map((w) => "- " + w).join("\n"));
    if (!parts.length) parts.push(this.changed ? "Done." : "Done (no changes).");
    if (this.changed) parts.push(`View: ${url}`);
    return parts.join("\n");
  }

  private newId(): string {
    const idx = this.index();
    for (;;) {
      const id = randomId();
      if (!idx.has(id)) return id;
    }
  }

  private addPage(name: string): string {
    const id = pageSlug(name, this.doc.pages.map((p) => p.id));
    this.doc.pages.push({ id, name, children: [] });
    this.dirty();
    return id;
  }

  private findPage(key: string): PennaPage | undefined {
    return this.doc.pages.find((p) => p.id === key) ?? this.doc.pages.find((p) => p.name === key);
  }

  private findByName(name: string): PennaNode | undefined {
    const current = this.findPage(this.pageId)!;
    const hit = findDescendant(current, name);
    if (hit) return hit;
    for (const p of this.doc.pages) {
      const n = findDescendant(p, name);
      if (n) return n;
    }
    return undefined;
  }

  private tryResolve(path: string): Target | undefined {
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
  private resolve(path: unknown): Target {
    if (typeof path !== "string" || !path) {
      throw new Error(`Expected a node id or path string, got ${JSON.stringify(path)?.slice(0, 60)}. Pass ids, not node objects.`);
    }
    const idx = this.index();
    const page = this.doc.pages.find((p) => p.id === path);
    if (page) return { kind: "page", page };
    // Names may contain slashes ("Row / Course"), so at each step match the longest run
    // of segments that names a node.
    const segs = path.split("/");
    let node: PennaNode | undefined;
    let i = 0;
    for (let j = segs.length; j >= 1 && !node; j--) {
      const key = segs.slice(0, j).join("/");
      node = idx.get(key)?.node ?? this.findByName(key);
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
    return { kind: "node", loc: idx.get(node.id)! };
  }

  private resolveNode(path: unknown, op: string): Located {
    const t = this.resolve(path);
    if (t.kind === "node") return t.loc;
    if (t.kind === "page") throw new Error(`${op}: "${path}" is a page, not a node.`);
    throw new Error(`${op}: "${path}" is inside a component instance. Use Update on it to set an override, or edit the component.`);
  }

  private container(path: unknown): PennaNode | PennaPage {
    const t = this.resolve(path);
    if (t.kind === "page") return t.page;
    if (t.kind === "override") throw new Error(`Cannot insert into an instance. Override its children with Update(path, {children: [...]}) or edit the component.`);
    const n = t.loc.node;
    if (n.type === "ref") throw new Error(`"${n.name ?? n.id}" is a component instance. Insert into the component instead.`);
    if (n.type !== "frame") throw new Error(`"${n.name ?? n.id}" is a ${n.type}; only frames have children.`);
    return n;
  }

  /** Validate agent input, infer types, assign ids, and collect warnings. */
  private normalize(input: unknown, topLevel: boolean, track: boolean): PennaNode {
    if (typeof input === "string" || typeof input === "number") input = { text: String(input) };
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(`Expected a node object, got ${JSON.stringify(input)?.slice(0, 60)}.`);
    }
    const raw = input as Record<string, unknown>;
    const node: PennaNode = { id: this.newId(), type: inferType(raw) };
    if (!TYPES.has(node.type)) throw new Error(`Unknown node type "${node.type}". Use frame, text, image, icon, svg, or ref.`);
    for (const key in raw) {
      if (key === "id" || key === "type") continue;
      if (!NODE_KEYS.has(key)) {
        this.warn(`Ignored unknown property "${key}" on ${node.type}. CSS goes in style.`);
        continue;
      }
      const v = raw[key];
      if (v === undefined || v === null) continue;
      if (key === "style") node.style = this.normStyle(v, node.type);
      else if (key === "children") {
        if (!Array.isArray(v)) throw new Error("children must be an array.");
        if (node.type !== "frame") {
          this.warn(`Ignored children on ${node.type}; only frames have children.`);
          continue;
        }
        node.children = v.flat().filter((c) => c !== null && c !== undefined && c !== false).map((c) => this.normalize(c, false, track));
      } else if (key === "spans") {
        if (!Array.isArray(v)) throw new Error("spans must be an array of {text, style?, class?}.");
        node.spans = v.map((s) => {
          const run = typeof s === "string" ? { text: s } : (s as { text?: unknown; style?: unknown; class?: unknown });
          const out: { text: string; style?: Record<string, string | number>; class?: string } = { text: String(run.text ?? "") };
          if (run.style) out.style = this.normStyle(run.style, "span");
          if (typeof run.class === "string") out.class = run.class;
          return out;
        });
      } else if (key === "ref") {
        node.ref = this.normRef(v);
      } else if (key === "overrides") {
        const ov: Record<string, NodePatch> = {};
        for (const k in v as object) ov[k] = this.normPatch((v as Record<string, unknown>)[k]);
        node.overrides = ov;
      } else (node as unknown as Record<string, unknown>)[key] = v;
    }
    if (!topLevel) {
      delete node.x;
      delete node.y;
    }
    this.check(node);
    if (track && typeof raw.name === "string") this.created.push(`${raw.name}=${node.id}`);
    if (!node.name) node.name = node.type === "ref" ? (this.index().get(node.ref ?? "")?.node.name ?? "Instance") : defaultName(node);
    return node;
  }

  private normStyle(v: unknown, type: string): Record<string, string | number> {
    if (typeof v !== "object" || !v || Array.isArray(v)) throw new Error(`style must be an object of CSS properties, got ${JSON.stringify(v)?.slice(0, 60)}.`);
    const out: Record<string, string | number> = {};
    for (const k in v as object) {
      const val = (v as Record<string, unknown>)[k];
      if (val === null || val === undefined) continue;
      if (typeof val !== "string" && typeof val !== "number") {
        this.warn(`style.${k} on ${type} must be a string or number.`);
        continue;
      }
      if (typeof val === "number" && !Number.isFinite(val)) {
        this.warn(`style.${k} on ${type} is ${val}.`);
        continue;
      }
      out[camel(k)] = val;
    }
    return out;
  }

  private normPatch(v: unknown): NodePatch {
    if (!v || typeof v !== "object") throw new Error(`Expected a patch object, got ${JSON.stringify(v)?.slice(0, 60)}.`);
    const raw = v as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k in raw) {
      if (k === "id") continue;
      if (k === "type") {
        this.warn("Cannot change a node's type with Update. Use Replace.");
        continue;
      }
      if (!NODE_KEYS.has(k)) {
        this.warn(`Ignored unknown property "${k}". CSS goes in style.`);
        continue;
      }
      if (k === "style" && raw.style) {
        const s: Record<string, unknown> = {};
        for (const sk in raw.style as object) s[camel(sk)] = (raw.style as Record<string, unknown>)[sk];
        patch.style = s;
      } else if (k === "ref" && raw.ref) {
        patch.ref = this.normRef(raw.ref);
      } else if (k === "children" && Array.isArray(raw.children)) {
        patch.children = raw.children.map((c) => this.normalize(c, false, true));
      } else patch[k] = raw[k];
    }
    return patch as NodePatch;
  }

  /** Resolve a ref given as a component id or name, on any page, to the component's id. */
  private normRef(v: unknown): string {
    if (typeof v !== "string" || !v) throw new Error(`ref must be a component id or name. Got ${JSON.stringify(v)?.slice(0, 60)}.`);
    return findComponent(this.doc, v, this.index())?.id ?? v;
  }

  private check(n: PennaNode) {
    const label = n.name ?? n.type;
    if (n.type === "text" && n.text === undefined && !n.spans) this.warn(`Text "${label}" has no text.`);
    if (n.type === "image" && !n.src) this.warn(`Image "${label}" has no src.`);
    if (n.type === "icon") {
      if (!n.icon) this.warn(`Icon "${label}" has no icon name.`);
      else if (!this.icons.has(n.icon)) {
        const close = this.icons.search(n.icon, 6);
        this.warn(`Unknown Lucide icon "${n.icon}".` + (close.length ? ` Close matches: ${close.join(", ")}.` : ` Find names with Icons("words").`));
      }
    }
    if (n.type === "ref") {
      if (!n.ref) this.warn(`Instance "${label}" has no ref.`);
      else if (!this.index().get(n.ref)?.node.component) {
        const target = this.index().get(n.ref)?.node;
        if (!target) this.warn(`Instance "${label}" refers to missing component "${n.ref}".`);
        else this.warn(`Instance "${label}" refers to "${target.name}", which is not marked component:true.`);
      }
    }
  }

  private rightEdge(page: PennaPage): number {
    let right = -Infinity;
    for (const n of page.children) {
      const w = this.store.sizes.get(n.id)?.[0] ?? (typeof n.style?.width === "number" ? n.style.width : parseFloat(String(n.style?.width ?? "")) || 1000);
      right = Math.max(right, (n.x ?? 0) + w);
    }
    return right === -Infinity ? 0 : right + 120;
  }

  private insertInto(parent: PennaNode | PennaPage, node: PennaNode, index?: number) {
    const list = (parent.children ??= []);
    const i = index === undefined || index < 0 || index > list.length ? list.length : index;
    list.splice(i, 0, node);
    this.dirty();
  }

  api() {
    const self = this;
    const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

    return {
      get page() {
        return self.pageId;
      },
      Print: (...values: unknown[]) => self.print(values.map(fmt).join(" ")),
      console: { log: (...values: unknown[]) => self.print(values.map(fmt).join(" ")) },

      Insert(parent: string, input: unknown, index?: number): string | string[] {
        const target = self.container(parent);
        const top = "type" in target ? false : true;
        const many = Array.isArray(input);
        const ids: string[] = [];
        for (const item of many ? (input as unknown[]) : [input]) {
          const node = self.normalize(item, top, true);
          if (top && (node.x === undefined || node.y === undefined)) {
            node.x ??= self.rightEdge(target as PennaPage);
            node.y ??= 0;
          }
          self.insertInto(target, node, index === undefined ? undefined : index + ids.length);
          ids.push(node.id);
        }
        return many ? ids : ids[0];
      },

      Update(path: string, patch: unknown) {
        const t = self.resolve(path);
        const p = self.normPatch(patch);
        if (t.kind === "page") {
          if (typeof p.name === "string") t.page.name = p.name;
          self.dirty();
          return;
        }
        if (t.kind === "override") {
          const ov = (t.inst.overrides ??= {});
          const cur = (ov[t.key] ??= {});
          const style = p.style ? { ...(cur.style ?? {}), ...p.style } : cur.style;
          Object.assign(cur, p);
          if (style) cur.style = style;
          self.dirty();
          return;
        }
        applyPatch(t.loc.node, p);
        self.check(t.loc.node);
        self.dirty();
      },

      Replace(path: string, input: unknown): string {
        const loc = self.resolveNode(path, "Replace");
        const top = !("type" in loc.parent);
        const node = self.normalize(input, top, true);
        if (top) {
          node.x ??= loc.node.x;
          node.y ??= loc.node.y;
        }
        const list = loc.parent.children!;
        list[list.indexOf(loc.node)] = node;
        self.dirty();
        return node.id;
      },

      Delete(path: string) {
        const t = self.resolve(path);
        if (t.kind === "page") throw new Error(`"${path}" is a page. Use DeletePage.`);
        if (t.kind === "override") {
          const ov = (t.inst.overrides ??= {});
          ov[t.key] = { ...(ov[t.key] ?? {}), hidden: true };
        } else {
          const list = t.loc.parent.children!;
          list.splice(list.indexOf(t.loc.node), 1);
        }
        self.dirty();
      },

      Move(path: string, parent?: string, index?: number) {
        const loc = self.resolveNode(path, "Move");
        const target = parent === undefined ? loc.parent : self.container(parent);
        let n: PennaNode | PennaPage | undefined = "type" in target ? target : undefined;
        while (n && "type" in n) {
          if (n === loc.node) throw new Error("Cannot move a node inside itself.");
          n = self.index().get(n.id)?.parent;
        }
        const list = loc.parent.children!;
        list.splice(list.indexOf(loc.node), 1);
        if (!("type" in target)) {
          loc.node.x ??= self.rightEdge(target);
          loc.node.y ??= 0;
        } else {
          delete loc.node.x;
          delete loc.node.y;
        }
        self.insertInto(target, loc.node, index);
      },

      Copy(path: string, parent?: string, patch?: unknown): string {
        const loc = self.resolveNode(path, "Copy");
        const target = parent === undefined ? loc.parent : self.container(parent);
        const clone = self.normalize(stripIds(loc.node), !("type" in target), false);
        if (loc.node.component) delete clone.component;
        if (patch) applyPatch(clone, self.normPatch(patch));
        if (!("type" in target)) {
          if ((patch as NodePatch | undefined)?.x === undefined) clone.x = self.rightEdge(target);
          clone.y ??= 0;
        }
        const list = target.children ?? [];
        self.insertInto(target, clone, target === loc.parent ? list.indexOf(loc.node) + 1 : undefined);
        return clone.id;
      },

      Get(path: string, depth?: number): PennaNode | PennaPage {
        const t = self.resolve(path);
        if (t.kind === "page") return trim(structuredClone(t.page) as PennaPage, depth);
        if (t.kind === "node") return trim(structuredClone(t.loc.node), depth);
        const expanded = expandRef(t.inst, self.index());
        const hit = expanded && findDescendant(expanded, t.inst.id + "/" + t.key) ? findDescendant(expanded, t.inst.id + "/" + t.key) : expanded && findDescendant(expanded, t.key);
        if (!hit) throw new Error(`No "${t.key}" inside instance "${t.inst.name ?? t.inst.id}".`);
        return trim(structuredClone(hit), depth);
      },

      Find(pred: (n: PennaNode) => unknown, root?: string): PennaNode[] {
        if (typeof pred !== "function") throw new Error("Find(predicate, root?) needs a function.");
        const roots = root ? [self.resolve(root)] : self.doc.pages.map((page) => ({ kind: "page", page }) as Target);
        const out: PennaNode[] = [];
        const visit = (n: PennaNode) => {
          if (pred(n)) out.push(structuredClone(n));
          n.children?.forEach(visit);
        };
        for (const r of roots) {
          if (r.kind === "page") r.page.children.forEach(visit);
          else if (r.kind === "node") r.loc.node.children?.forEach(visit);
        }
        return out;
      },

      Tree(path?: string, depth = 4): string {
        const lines: string[] = [];
        const line = (n: PennaNode, d: number) => {
          let s = "  ".repeat(d) + (n.name ?? "") + " " + n.id + " " + n.type;
          if (n.component) s += " component";
          if (n.type === "ref") s += "→" + (self.index().get(n.ref!)?.node.name ?? n.ref);
          if (n.type === "text") s += " " + JSON.stringify(truncate(n.text ?? n.spans?.map((r) => r.text).join("") ?? "", 40));
          if (n.type === "icon") s += " " + n.icon;
          if (n.x !== undefined) s += ` @${n.x},${n.y}`;
          const w = n.style?.width, h = n.style?.height;
          if (w !== undefined || h !== undefined) s += ` ${w ?? "auto"}×${h ?? "auto"}`;
          if (n.hidden) s += " hidden";
          lines.push(s);
          if (n.children) {
            if (d + 1 > depth) lines.push("  ".repeat(d + 1) + `… ${n.children.length} children`);
            else for (const c of n.children) line(c, d + 1);
          }
        };
        if (path) {
          const t = self.resolve(path);
          if (t.kind === "page") t.page.children.forEach((c) => line(c, 0));
          else if (t.kind === "node") line(t.loc.node, 0);
          else throw new Error("Tree does not read inside instances. Use Get.");
        } else self.findPage(self.pageId)!.children.forEach((c) => line(c, 0));
        return lines.join("\n") || "(empty)";
      },

      State() {
        return {
          page: self.pageId,
          pages: self.doc.pages.map((p) => ({ id: p.id, name: p.name, frames: p.children.length })),
          selection: self.store.selection?.ids ?? [],
          variables: Object.keys(self.doc.variables ?? {}).length,
          themes: Object.keys(self.doc.themes ?? {}),
        };
      },

      Selection(): string[] {
        return [...(self.store.selection?.ids ?? [])];
      },

      Page(name: string): string {
        const existing = self.findPage(name);
        if (existing) {
          self.pageId = existing.id;
          return existing.id;
        }
        self.pageId = self.addPage(name);
        return self.pageId;
      },

      DeletePage(key: string) {
        const page = self.findPage(key);
        if (!page) throw new Error(`No page "${key}".`);
        if (self.doc.pages.length === 1) throw new Error("Cannot delete the only page.");
        self.doc.pages.splice(self.doc.pages.indexOf(page), 1);
        if (self.pageId === page.id) self.pageId = self.doc.pages[0].id;
        self.dirty();
      },

      SetVariables(vars: Record<string, string | number | null>, theme?: string) {
        if (!vars || typeof vars !== "object") throw new Error("SetVariables({name: value}, theme?) needs an object.");
        const target = theme ? ((self.doc.themes ??= {})[theme] ??= {}) : (self.doc.variables ??= {});
        for (const k in vars) {
          const key = k.replace(/^--/, "");
          if (vars[k] === null) delete target[key];
          else target[key] = String(vars[k]);
        }
        self.dirty();
      },

      Components(): { id: string; name: string; page: string }[] {
        const out: { id: string; name: string; page: string }[] = [];
        for (const p of self.doc.pages) {
          walk(p.children, (n) => {
            if (n.component) out.push({ id: n.id, name: n.name ?? n.id, page: p.name });
          });
        }
        return out;
      },

      Icons(query: string, limit?: number): string[] {
        if (typeof query !== "string") throw new Error('Icons("words", limit?) needs a search string.');
        return self.icons.search(query, limit);
      },

      GetVariables() {
        return { variables: { ...(self.doc.variables ?? {}) }, themes: structuredClone(self.doc.themes ?? {}) };
      },

      Screenshot(ids: string | string[], opts?: { scale?: number }) {
        const list = (Array.isArray(ids) ? ids : [ids]).map((p) => {
          const t = self.resolve(p);
          if (t.kind === "override") throw new Error("Screenshot the instance, not a part of it.");
          return t.kind === "page" ? t.page.id : t.loc.node.id;
        });
        self.shotJobs.push({ ids: list, scale: opts?.scale });
      },

      Check(path: string) {
        self.checkJobs.push(self.resolveNode(path, "Check").node.id);
      },

      async Layout(path: string) {
        const loc = self.resolveNode(path, "Layout");
        return self.headless.layout(self.doc, self.pageId, loc.node.id);
      },
    };
  }
}

function inferType(raw: Record<string, unknown>): NodeType {
  if (typeof raw.type === "string") return raw.type as NodeType;
  if (raw.ref !== undefined) return "ref";
  if (raw.text !== undefined || raw.spans !== undefined) return "text";
  if (raw.icon !== undefined) return "icon";
  if (raw.src !== undefined) return "image";
  if (raw.svg !== undefined) return "svg";
  return "frame";
}

function defaultName(n: PennaNode): string {
  switch (n.type) {
    case "text":
      return truncate(n.text ?? n.spans?.map((s) => s.text).join("") ?? "Text", 24);
    case "icon":
      return n.icon ?? "Icon";
    case "image":
      return "Image";
    case "svg":
      return "Vector";
    default:
      return "Frame";
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function stripIds(n: PennaNode): Record<string, unknown> {
  const { id: _id, children, ...rest } = n;
  return children ? { ...rest, children: children.map(stripIds) } : rest;
}

function trim<T extends { children?: PennaNode[] }>(n: T, depth?: number): T {
  if (depth === undefined || !n.children) return n;
  if (depth <= 0) {
    (n as Record<string, unknown>).children = `… ${n.children.length}`;
    return n;
  }
  n.children.forEach((c) => trim(c, depth - 1));
  return n;
}
