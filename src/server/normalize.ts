import { NODE_KEYS, propProblem, show, styleValueProblem } from "../shared/schema.ts";
import { camel } from "../shared/style.ts";
import { findComponent, type NodeLookup } from "../shared/tree.ts";
import type { NodePatch, NodeType, PennaDoc, PennaNode, Style, TextSpan } from "../shared/types.ts";
import type { Icons } from "./icons.ts";

const ID_CHARS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomId(len = 5): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

export interface NormalizeContext {
  doc: PennaDoc;
  lookup: NodeLookup;
  icons: Icons;
  warn(message: string): void;
  /** Called with `name=id` for each named node the agent created. */
  created(entry: string): void;
}

/**
 * Turns what an agent passes to the API into stored nodes and patches: infers types,
 * assigns ids, checks every value against the schema, and collects warnings. Values of
 * the wrong kind throw, so the snippet fails and nothing malformed is saved.
 */
export class Normalizer {
  private ctx: NormalizeContext;
  /** Ids handed out by this normalizer, which may not be in the document yet. */
  private fresh = new Set<string>();

  constructor(ctx: NormalizeContext) {
    this.ctx = ctx;
  }

  private newId(): string {
    for (;;) {
      const id = randomId();
      if (this.fresh.has(id) || this.ctx.lookup.get(id)) continue;
      this.fresh.add(id);
      return id;
    }
  }

  /** Build a node from agent input. `track` reports the named nodes as created. */
  node(input: unknown, topLevel: boolean, track: boolean): PennaNode {
    if (typeof input === "string" || typeof input === "number") input = { text: String(input) };
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`Expected a node object, got ${show(input)}.`);
    const raw = input as Record<string, unknown>;
    const type = inferType(raw);
    const typeProblem = propProblem("type", type);
    if (typeProblem) throw new Error(capital(typeProblem) + ".");
    const node: PennaNode = { id: this.newId(), type };
    const out = node as unknown as Record<string, unknown>;
    for (const key in raw) {
      if (key === "id" || key === "type") continue;
      if (!NODE_KEYS.has(key)) {
        this.ctx.warn(`Ignored unknown property "${key}" on ${type}. CSS goes in style.`);
        continue;
      }
      const v = raw[key];
      if (v === undefined || v === null) continue;
      if (key === "children" && type !== "frame") {
        this.ctx.warn(`Ignored children on ${type}; only frames have children.`);
        continue;
      }
      out[key] = this.value(key, v, type, false, track);
    }
    if (!topLevel) {
      delete node.x;
      delete node.y;
    }
    this.check(node);
    if (track && typeof node.name === "string") this.ctx.created(`${node.name}=${node.id}`);
    if (!node.name) node.name = type === "ref" ? (this.ctx.lookup.get(node.ref ?? "")?.node.name ?? "Instance") : defaultName(node);
    return node;
  }

  /** Build a patch from agent input, for Update and for overrides. */
  patch(input: unknown): NodePatch {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`Expected a patch object, got ${show(input)}.`);
    const raw = input as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key in raw) {
      if (key === "id") continue;
      if (key === "type") {
        this.ctx.warn("Cannot change a node's type with Update. Use Replace.");
        continue;
      }
      if (!NODE_KEYS.has(key)) {
        this.ctx.warn(`Ignored unknown property "${key}". CSS goes in style.`);
        continue;
      }
      const v = raw[key];
      // null and undefined delete the property.
      patch[key] = v === undefined || v === null ? null : this.value(key, v, "node", true, true);
    }
    return patch as NodePatch;
  }

  /** The stored form of one property value. Throws if it is not valid. */
  private value(key: string, v: unknown, type: string, patch: boolean, track: boolean): unknown {
    switch (key) {
      case "style":
        return this.style(v, type, patch);
      case "children":
        if (!Array.isArray(v)) throw new Error("children must be an array.");
        return v.flat().filter((c) => c !== null && c !== undefined && c !== false).map((c) => this.node(c, false, track));
      case "spans":
        if (!Array.isArray(v)) throw new Error("spans must be an array of {text, style?, class?}.");
        return v.map((s) => {
          const run: { text?: unknown; style?: unknown; class?: unknown } = s && typeof s === "object" ? s : { text: s };
          const span: TextSpan = { text: String(run.text ?? "") };
          if (run.style) span.style = this.style(run.style, "span", false) as Style;
          if (typeof run.class === "string") span.class = run.class;
          return span;
        });
      case "ref":
        return this.ref(v);
      case "overrides": {
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`overrides must be an object of patches, got ${show(v)}.`);
        const ov: Record<string, NodePatch> = {};
        for (const k in v) ov[k] = this.patch((v as Record<string, unknown>)[k]);
        return ov;
      }
      case "text":
      case "name":
        // Numbers are a common, harmless slip.
        if (typeof v === "number") v = String(v);
    }
    const problem = propProblem(key, v);
    if (problem) throw new Error(capital(problem) + ".");
    return v;
  }

  private style(v: unknown, type: string, patch: boolean): Record<string, string | number | null> {
    if (typeof v !== "object" || !v || Array.isArray(v)) throw new Error(`style must be an object of CSS properties, got ${show(v)}.`);
    const out: Record<string, string | number | null> = {};
    for (const k in v) {
      let val = (v as Record<string, unknown>)[k];
      if (val === undefined) val = null;
      if (val === null && !patch) continue;
      const problem = styleValueProblem(val, patch);
      if (problem) {
        this.ctx.warn(`Ignored style.${k} on ${type}: it ${problem}.`);
        continue;
      }
      out[camel(k)] = val as string | number | null;
    }
    return out;
  }

  /** Resolve a ref given as a component id or name, on any page, to the component's id. */
  private ref(v: unknown): string {
    if (typeof v !== "string" || !v) throw new Error(`ref must be a component id or name. Got ${show(v)}.`);
    return findComponent(this.ctx.doc, v, this.ctx.lookup)?.id ?? v;
  }

  /** Warn about a node that is valid but probably not what the agent meant. */
  check(n: PennaNode) {
    const { warn, icons, lookup } = this.ctx;
    const label = n.name ?? n.type;
    if (n.type === "text" && n.text === undefined && !n.spans) warn(`Text "${label}" has no text.`);
    if (n.type === "image" && !n.src) warn(`Image "${label}" has no src.`);
    if (n.type === "icon") {
      if (!n.icon) warn(`Icon "${label}" has no icon name.`);
      else if (!icons.has(n.icon)) {
        const close = icons.search(n.icon, 6);
        warn(`Unknown Lucide icon "${n.icon}".` + (close.length ? ` Close matches: ${close.join(", ")}.` : ` Find names with Icons("words").`));
      }
    }
    if (n.type === "ref") {
      if (!n.ref) warn(`Instance "${label}" has no ref.`);
      else {
        const target = lookup.get(n.ref)?.node;
        if (!target) warn(`Instance "${label}" refers to missing component "${n.ref}".`);
        else if (!target.component) warn(`Instance "${label}" refers to "${target.name}", which is not marked component:true.`);
      }
    }
  }
}

const capital = (s: string) => s[0].toUpperCase() + s.slice(1);

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

export function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
