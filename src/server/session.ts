import { MAX_FRAMES, PSEUDO, springEasing, type FilmRequest } from "../shared/motion.ts";
import { KEYFRAME_STOP, KEYFRAMES_NAME, styleValueProblem } from "../shared/schema.ts";
import { camel } from "../shared/style.ts";
import { applyPatch, expandRef, findDescendant, walk } from "../shared/tree.ts";
import type { NodePatch, PennaDoc, PennaNode, PennaPage, Style } from "../shared/types.ts";
import type { LayoutReport, Renderer } from "./headless.ts";
import type { Icons } from "./icons.ts";
import { Normalizer, truncate } from "./normalize.ts";
import type { Store } from "./store.ts";
import { WorkDoc } from "./workdoc.ts";

const MAX_OUTPUT = 24_000;

export interface ShotJob {
  ids: string[];
  scale?: number;
}

export interface FilmJob {
  req: FilmRequest;
  /** Whether to return the frames as an image, or only the report. */
  image: boolean;
  /** What started the motion, for the report. */
  cause: string;
}

const FILM_OPTIONS = ["state", "from", "hover", "active", "focus", "frames", "times", "duration", "scale"];
/** Keyframes that Tailwind's own animate-* classes define. */
const TAILWIND_KEYFRAMES = new Set(["spin", "ping", "pulse", "bounce"]);

/** One snippet run: a working copy of the document, the API the snippet sees, and its output. */
export class Session {
  readonly work: WorkDoc;
  outputLines: string[] = [];
  shotJobs: ShotJob[] = [];
  checkJobs: string[] = [];
  filmJobs: FilmJob[] = [];
  private closed = false;
  private warnings: string[] = [];
  private created: string[] = [];
  private norm: Normalizer;
  private store: Store;
  private icons: Icons;
  private renderer: Renderer;

  constructor(store: Store, icons: Icons, renderer: Renderer) {
    this.store = store;
    this.icons = icons;
    this.renderer = renderer;
    this.work = new WorkDoc(store.get(), store.viewing, store.reservedPageIds());
    this.norm = new Normalizer({
      doc: this.work.doc,
      lookup: this.work,
      icons,
      warn: (m) => this.warn(m),
      created: (entry) => this.created.push(entry),
    });
  }

  get doc(): PennaDoc {
    return this.work.doc;
  }

  get changed(): boolean {
    return this.work.changed;
  }

  /** After this, calls from the snippet throw. A snippet that outlives its run cannot touch a later one. */
  close() {
    this.closed = true;
  }

  print(line: string) {
    this.outputLines.push(line);
  }

  warn(msg: string) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  nameOf(id: string): string {
    const t = this.work.tryResolve(id);
    if (t?.kind === "node") return t.loc.node.name ?? id;
    if (t?.kind === "page") return t.page.name;
    return id;
  }

  /** Warn about triggers on the changed pages whose target is not a node. */
  checkTriggers() {
    for (const page of this.work.doc.pages) {
      if (!this.work.touched.has(page.id)) continue;
      walk(page.children, (n) => {
        if (!n.on) return;
        for (const event in n.on) {
          for (const a of n.on[event as keyof typeof n.on] ?? []) {
            if (a.target === undefined) continue;
            const t = this.work.tryResolve(a.target);
            const hit = t?.kind === "node" && (t.loc.node.id === a.target || t.loc.node.name === a.target);
            if (!hit) this.warn(`on.${event} of "${n.name ?? n.id}" targets "${a.target}", which is not the id or name of a node.`);
          }
        }
      });
    }
  }

  /** The DOM id of the node a path names, and the top-level node that holds it. */
  private domNode(path: unknown, op: string): { id: string; top: string } {
    const work = this.work;
    const t = work.resolve(path);
    if (t.kind === "page") throw new Error(`${op}: "${path}" is a page. Pass a node.`);
    if (t.kind === "node") return { id: t.loc.node.id, top: t.loc.top.id };
    const expanded = expandRef(t.inst, work);
    const hit = expanded && (findDescendant(expanded, t.inst.id + "/" + t.key) ?? findDescendant(expanded, t.key));
    if (!hit) throw new Error(`${op}: no "${t.key}" inside instance "${t.inst.name ?? t.inst.id}".`);
    return { id: hit.id, top: work.get(t.inst.id)!.top.id };
  }

  /** Turn `Filmstrip` or `Motion` arguments into a job. */
  private film(op: string, path: unknown, opts: unknown, image: boolean): FilmJob {
    if (opts !== undefined && (!opts || typeof opts !== "object" || Array.isArray(opts))) throw new Error(`${op}(path, options?) takes an options object, got ${JSON.stringify(opts)}.`);
    const o = (opts ?? {}) as Record<string, unknown>;
    for (const k in o) if (!FILM_OPTIONS.includes(k)) throw new Error(`${op}: unknown option "${k}". Options: ${FILM_OPTIONS.join(", ")}.`);
    const target = this.domNode(path, op);
    const inScreen = (p: unknown) => {
      const n = this.domNode(p, op);
      if (n.top !== target.top) throw new Error(`${op}: "${p}" is on another screen than "${path}".`);
      return n.id;
    };
    const states = (v: unknown, name: string): Record<string, string | null> => {
      if (v === undefined) return {};
      if (v === null || typeof v === "string") return { [target.id]: v || null };
      if (typeof v !== "object" || Array.isArray(v)) throw new Error(`${op}: ${name} must be a state name, or {path: state}.`);
      const out: Record<string, string | null> = {};
      for (const k in v) {
        const s = (v as Record<string, unknown>)[k];
        if (s !== null && typeof s !== "string") throw new Error(`${op}: ${name}["${k}"] must be a state name or null.`);
        out[inScreen(k)] = s || null;
      }
      return out;
    };
    const req: FilmRequest = { top: target.top, target: target.id, frames: 5, from: states(o.from, "from"), to: states(o.state, "state"), pseudo: {} };
    const cause: string[] = [];
    const label = (id: string) => (id === target.id ? "" : ` on ${this.nameOf(id)}`);
    for (const id in req.to) cause.push(`state ${req.from[id] ?? this.work.get(id)?.node.state ?? "none"} → ${req.to[id] ?? "none"}${label(id)}`);
    for (const name in PSEUDO) {
      const v = o[name];
      if (v === undefined || v === false) continue;
      if (v !== true && typeof v !== "string") throw new Error(`${op}: ${name} must be true or a path.`);
      const id = v === true ? target.id : inScreen(v);
      req.pseudo[id] = [...new Set([...(req.pseudo[id] ?? []), ...PSEUDO[name]])];
      cause.push(name + label(id));
    }
    const ms = (v: unknown, name: string) => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${op}: ${name} must be a time in ms, got ${JSON.stringify(v)}.`);
      return v;
    };
    if (o.times !== undefined) {
      if (!Array.isArray(o.times) || !o.times.length || o.times.length > MAX_FRAMES) throw new Error(`${op}: times must be a list of 1 to ${MAX_FRAMES} times in ms.`);
      req.times = [...o.times].map((t) => ms(t, "each time")).sort((a, b) => a - b);
    }
    if (o.frames !== undefined) {
      if (!Number.isInteger(o.frames) || (o.frames as number) < 2 || (o.frames as number) > MAX_FRAMES) throw new Error(`${op}: frames must be a whole number from 2 to ${MAX_FRAMES}.`);
      req.frames = o.frames as number;
    }
    if (o.duration !== undefined) req.duration = ms(o.duration, "duration");
    if (o.scale !== undefined) {
      if (typeof o.scale !== "number" || !(o.scale > 0) || o.scale > 4) throw new Error(`${op}: scale must be a number up to 4.`);
      req.scale = o.scale;
    }
    return { req, image, cause: cause.join(", ") || "on load" };
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

  private rightEdge(page: PennaPage): number {
    let right = -Infinity;
    for (const n of page.children) {
      const w = this.store.sizes.get(n.id)?.[0] ?? (typeof n.style?.width === "number" ? n.style.width : parseFloat(String(n.style?.width ?? "")) || 1000);
      right = Math.max(right, (n.x ?? 0) + w);
    }
    return right === -Infinity ? 0 : right + 120;
  }

  /**
   * The functions a snippet can call, by name. They belong to this run: once it is
   * closed they throw, so a snippet that is still going cannot reach a later run.
   */
  api() {
    const self = this;
    const work = this.work;
    const norm = this.norm;
    const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
    const isPage = (x: PennaNode | PennaPage): x is PennaPage => !("type" in x);

    const api = {
      Print: (...values: unknown[]) => self.print(values.map(fmt).join(" ")),

      Insert(parent: string, input: unknown, index?: number): string | string[] {
        const found = work.container(parent);
        const top = isPage(found);
        const many = Array.isArray(input);
        // Build every node before changing anything, so a bad one leaves the page uncopied.
        const nodes = (many ? (input as unknown[]) : [input]).map((item) => norm.node(item, top, true));
        const target = work.ownContainer(found);
        nodes.forEach((node, i) => {
          if (top) {
            node.x ??= self.rightEdge(target as PennaPage);
            node.y ??= 0;
          }
          work.attach(target, node, index === undefined ? undefined : index + i);
        });
        const ids = nodes.map((n) => n.id);
        return many ? ids : ids[0];
      },

      Update(path: string, patch: unknown) {
        const t = work.resolve(path);
        const p = norm.patch(patch);
        if (t.kind === "page") {
          if (typeof p.name === "string") work.renamePage(t.page, p.name);
          return;
        }
        if (t.kind === "override") {
          const inst = work.ownNode(work.get(t.inst.id)!).node;
          const ov = (inst.overrides ??= {});
          const cur = (ov[t.key] ??= {});
          const style = p.style ? { ...(cur.style ?? {}), ...p.style } : cur.style;
          Object.assign(cur, p);
          if (style) cur.style = style;
          work.changed = true;
          return;
        }
        const loc = work.ownNode(t.loc);
        work.patch(loc, p);
        norm.check(loc.node);
      },

      Replace(path: string, input: unknown): string {
        const found = work.resolveNode(path, "Replace");
        const top = isPage(found.parent);
        const node = norm.node(input, top, true);
        const loc = work.ownNode(found);
        if (top) {
          node.x ??= loc.node.x;
          node.y ??= loc.node.y;
        }
        work.swap(loc, node);
        return node.id;
      },

      Delete(path: string) {
        const t = work.resolve(path);
        if (t.kind === "page") throw new Error(`"${path}" is a page. Use DeletePage.`);
        if (t.kind === "override") {
          const inst = work.ownNode(work.get(t.inst.id)!).node;
          const ov = (inst.overrides ??= {});
          ov[t.key] = { ...(ov[t.key] ?? {}), hidden: true };
          work.changed = true;
        } else work.detach(work.ownNode(t.loc));
      },

      Move(path: string, parent?: string, index?: number) {
        const loc = work.ownNode(work.resolveNode(path, "Move"));
        const target = parent === undefined ? loc.parent : work.ownContainer(work.container(parent));
        let n: PennaNode | PennaPage | undefined = target;
        while (n && !isPage(n)) {
          if (n === loc.node) throw new Error("Cannot move a node inside itself.");
          n = work.get(n.id)?.parent;
        }
        work.detach(loc);
        if (isPage(target)) {
          loc.node.x ??= self.rightEdge(target);
          loc.node.y ??= 0;
        } else {
          delete loc.node.x;
          delete loc.node.y;
        }
        work.attach(target, loc.node, index);
      },

      Copy(path: string, parent?: string, patch?: unknown): string {
        const found = work.resolveNode(path, "Copy");
        const dest = parent === undefined ? found.parent : work.container(parent);
        const clone = norm.node(stripIds(found.node), isPage(dest), false);
        if (found.node.component) delete clone.component;
        if (patch) applyPatch(clone, norm.patch(patch));
        const target = work.ownContainer(dest);
        // Owning the target's page may have replaced the source node.
        const source = work.get(found.node.id)!;
        if (isPage(target)) {
          if ((patch as NodePatch | undefined)?.x === undefined) clone.x = self.rightEdge(target);
          clone.y ??= 0;
        }
        work.attach(target, clone, target === source.parent ? target.children!.indexOf(source.node) + 1 : undefined);
        return clone.id;
      },

      Get(path: string, depth?: number): PennaNode | PennaPage {
        const t = work.resolve(path);
        if (t.kind === "page") return trim(structuredClone(t.page) as PennaPage, depth);
        if (t.kind === "node") return trim(structuredClone(t.loc.node), depth);
        const expanded = expandRef(t.inst, work);
        const hit = expanded && (findDescendant(expanded, t.inst.id + "/" + t.key) ?? findDescendant(expanded, t.key));
        if (!hit) throw new Error(`No "${t.key}" inside instance "${t.inst.name ?? t.inst.id}".`);
        return trim(structuredClone(hit), depth);
      },

      Find(pred: (n: PennaNode) => unknown, root?: string): PennaNode[] {
        if (typeof pred !== "function") throw new Error("Find(predicate, root?) needs a function.");
        const roots = root ? [work.resolve(root)] : work.doc.pages.map((page) => ({ kind: "page" as const, page }));
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
          if (n.type === "ref") s += "→" + (work.get(n.ref!)?.node.name ?? n.ref);
          if (n.type === "text") s += " " + JSON.stringify(truncate(n.text ?? n.spans?.map((r) => r.text).join("") ?? "", 40));
          if (n.type === "icon") s += " " + n.icon;
          if (n.x !== undefined) s += ` @${n.x},${n.y}`;
          const w = n.style?.width, h = n.style?.height;
          if (w !== undefined || h !== undefined) s += ` ${w ?? "auto"}×${h ?? "auto"}`;
          if (n.hidden) s += " hidden";
          if (n.state) s += ` state=${n.state}`;
          if (n.on) s += ` on:${Object.keys(n.on).join(",")}`;
          lines.push(s);
          if (n.children) {
            if (d + 1 > depth) lines.push("  ".repeat(d + 1) + `… ${n.children.length} children`);
            else for (const c of n.children) line(c, d + 1);
          }
        };
        if (path) {
          const t = work.resolve(path);
          if (t.kind === "page") t.page.children.forEach((c) => line(c, 0));
          else if (t.kind === "node") line(t.loc.node, 0);
          else throw new Error("Tree does not read inside instances. Use Get.");
        } else work.currentPage().children.forEach((c) => line(c, 0));
        return lines.join("\n") || "(empty)";
      },

      State() {
        return {
          page: work.pageId,
          pages: work.doc.pages.map((p) => ({ id: p.id, name: p.name, frames: p.children.length })),
          selection: self.store.selection?.ids ?? [],
          variables: Object.keys(work.doc.variables ?? {}).length,
          themes: Object.keys(work.doc.themes ?? {}),
          keyframes: Object.keys(work.doc.keyframes ?? {}),
        };
      },

      Selection(): string[] {
        return [...(self.store.selection?.ids ?? [])];
      },

      Page(name: string): string {
        if (typeof name !== "string" || !name) throw new Error("Page(name) needs a page name or id.");
        work.pageId = (work.findPage(name) ?? work.addPage(name)).id;
        return work.pageId;
      },

      DeletePage(key: string) {
        const page = work.findPage(key);
        if (!page) throw new Error(`No page "${key}".`);
        if (work.doc.pages.length === 1) throw new Error("Cannot delete the only page.");
        work.removePage(page);
      },

      SetVariables(vars: Record<string, string | number | null>, theme?: string) {
        if (!vars || typeof vars !== "object") throw new Error("SetVariables({name: value}, theme?) needs an object.");
        if (theme !== undefined && (typeof theme !== "string" || !theme)) throw new Error("The theme must be a name.");
        const target = theme ? work.theme(theme) : work.variables();
        for (const k in vars) {
          const key = k.replace(/^--/, "");
          if (vars[k] === null) delete target[key];
          else target[key] = String(vars[k]);
        }
        work.changed = true;
      },

      SetKeyframes(rules: Record<string, Record<string, Record<string, unknown>> | null>) {
        if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error("SetKeyframes({name: {from: {...}, to: {...}}}) needs an object.");
        const target = work.keyframes();
        for (const name in rules) {
          const stops = rules[name];
          if (stops === null) {
            delete target[name];
            continue;
          }
          if (!KEYFRAMES_NAME.test(name)) throw new Error(`Keyframes name "${name}" must be letters, digits, - and _, starting with a letter.`);
          if (!stops || typeof stops !== "object" || Array.isArray(stops)) throw new Error(`Keyframes "${name}" must be an object of stops, like {from: {...}, to: {...}}.`);
          if (TAILWIND_KEYFRAMES.has(name)) self.warn(`Keyframes "${name}" replace the ones behind Tailwind's animate-${name}.`);
          const rule: Record<string, Style> = {};
          for (const key in stops) {
            // A bare number is a percentage: {0: ..., 50: ..., 100: ...}.
            const stop = /^\d+(\.\d+)?$/.test(key) ? key + "%" : key.trim();
            if (!KEYFRAME_STOP.test(stop)) throw new Error(`Keyframes "${name}" has a bad stop "${key}". Use from, to, or a percentage.`);
            const css = stops[key];
            if (!css || typeof css !== "object" || Array.isArray(css)) throw new Error(`Keyframes "${name}" stop "${key}" must be an object of CSS properties.`);
            const style: Style = {};
            for (const k in css) {
              const problem = styleValueProblem(css[k]);
              if (problem) throw new Error(`Keyframes "${name}" stop "${key}": ${k} ${problem}.`);
              style[camel(k)] = css[k] as string | number;
            }
            rule[stop] = style;
          }
          if (!Object.keys(rule).length) throw new Error(`Keyframes "${name}" has no stops.`);
          target[name] = rule;
        }
        work.changed = true;
      },

      GetKeyframes() {
        return structuredClone(work.doc.keyframes ?? {});
      },

      Spring: (bounce?: number) => springEasing(bounce),

      Filmstrip(path: string, opts?: unknown) {
        self.filmJobs.push(self.film("Filmstrip", path, opts, true));
      },

      Motion(path: string, opts?: unknown) {
        self.filmJobs.push(self.film("Motion", path, opts, false));
      },

      Components(): { id: string; name: string; page: string }[] {
        const out: { id: string; name: string; page: string }[] = [];
        for (const p of work.doc.pages) {
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
        return { variables: { ...(work.doc.variables ?? {}) }, themes: structuredClone(work.doc.themes ?? {}) };
      },

      Screenshot(ids: string | string[], opts?: { scale?: number }) {
        const list = (Array.isArray(ids) ? ids : [ids]).map((p) => {
          const t = work.resolve(p);
          if (t.kind === "override") throw new Error("Screenshot the instance, not a part of it.");
          return t.kind === "page" ? t.page.id : t.loc.node.id;
        });
        self.shotJobs.push({ ids: list, scale: opts?.scale });
      },

      Check(path: string) {
        self.checkJobs.push(work.resolveNode(path, "Check").node.id);
      },

      Layout(path: string): Promise<LayoutReport> {
        const loc = work.resolveNode(path, "Layout");
        return self.renderer.layout(work.doc, work, loc.node.id);
      },
    };

    // Every call checks that the run is still open.
    const guarded: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(api)) {
      guarded[name] = (...args: unknown[]) => {
        if (self.closed) throw new Error("This snippet's run has ended.");
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
    }
    guarded.console = { log: guarded.Print };
    return guarded;
  }
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
