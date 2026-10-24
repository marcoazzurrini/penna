import { styleToCss, variablesToCss } from "../shared/style.ts";
import { expandRef, type Located } from "../shared/tree.ts";
import type { PennaDoc, PennaNode } from "../shared/types.ts";

export interface RenderCtx {
  doc: PennaDoc;
  index: Map<string, Located>;
}

const MAX_REF_DEPTH = 12;

export function assetUrl(src: string): string {
  if (/^(https?:|data:|blob:|\/)/.test(src)) return src;
  return "/files/" + src.replace(/^\.?\//, "");
}

/** Build the DOM for one node. Returns null for hidden nodes. */
export function renderNode(node: PennaNode, ctx: RenderCtx, depth = 0): HTMLElement | null {
  if (node.hidden) return null;
  if (node.type === "ref") {
    const expanded = depth < MAX_REF_DEPTH ? expandRef(node, ctx.index) : undefined;
    if (!expanded) return missing(node);
    if (expanded.hidden) return null;
    const el = renderNode(expanded, ctx, depth + 1);
    if (el) el.dataset.ref = node.ref;
    return el;
  }

  let el: HTMLElement;
  switch (node.type) {
    case "text":
      el = document.createElement("div");
      el.className = "pn-text";
      if (node.spans) {
        for (const run of node.spans) {
          const span = document.createElement("span");
          span.textContent = run.text;
          if (run.class) span.className = run.class;
          if (run.style) span.style.cssText = styleToCss(run.style);
          el.appendChild(span);
        }
      } else el.textContent = node.text ?? "";
      break;
    case "image": {
      const img = document.createElement("img");
      img.className = "pn-image";
      img.draggable = false;
      if (node.src) img.src = assetUrl(node.src);
      img.alt = node.name ?? "";
      el = img;
      break;
    }
    case "icon":
      el = document.createElement("span");
      el.className = "pn-icon";
      break;
    case "svg":
      el = document.createElement("div");
      el.className = "pn-svg";
      {
        const svg = safeSvg(node.svg ?? "");
        if (svg) el.appendChild(svg);
      }
      break;
    default:
      el = document.createElement("div");
      el.className = "pn-frame";
      if (node.children) {
        for (const child of node.children) {
          const c = renderNode(child, ctx, depth);
          if (c) el.appendChild(c);
        }
      }
  }

  el.dataset.id = node.id;
  if (node.name) el.dataset.name = node.name;
  if (node.class) el.className += " " + node.class;
  let css = styleToCss(node.style);
  if (node.theme && ctx.doc.themes?.[node.theme]) css = variablesToCss(ctx.doc.themes[node.theme]) + css;
  if (node.type === "icon") css = `--pn-icon:url("/icon/${encodeURIComponent(node.icon ?? "")}.svg");` + css;
  if (css) el.style.cssText = css;
  return el;
}

// Design files can come from anyone (a pull request, a download), and the viewer runs on
// localhost. Never let their SVG run script: parse it as XML and keep only inert content.
const UNSAFE_TAGS = new Set(["script", "foreignobject", "iframe", "object", "embed", "handler", "listener"]);
const ANIMATION_TAGS = new Set(["animate", "set", "animatemotion", "animatetransform"]);
const LINK_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction"]);

function safeUrl(value: string): boolean {
  const v = value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  return v.startsWith("#") || v.startsWith("https:") || v.startsWith("http:") || v.startsWith("data:image/") && !v.startsWith("data:image/svg");
}

export function safeSvg(markup: string): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.getElementsByTagName("parsererror").length) return null;
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const tag = el.localName.toLowerCase();
    if (UNSAFE_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    if (ANIMATION_TAGS.has(tag) && /href|^on/i.test(el.getAttribute("attributeName") ?? "")) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || (LINK_ATTRS.has(name) && !safeUrl(attr.value))) el.removeAttribute(attr.name);
    }
  }
  return document.importNode(root, true) as unknown as SVGSVGElement;
}

function missing(node: PennaNode): HTMLElement {
  const el = document.createElement("div");
  el.className = "pn-missing";
  el.dataset.id = node.id;
  el.textContent = `Missing component ${node.ref ?? ""}`;
  return el;
}

/** Font families used anywhere in the document, for loading from Google Fonts. */
export function fontFamilies(doc: PennaDoc): string[] {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const first = value.split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (first && !first.startsWith("var(") && !GENERIC.has(first.toLowerCase())) found.add(first);
  };
  const visit = (n: PennaNode) => {
    add(n.style?.fontFamily);
    n.spans?.forEach((s) => add(s.style?.fontFamily));
    for (const m of n.class?.matchAll(/font-\['?([^\]']+)'?\]/g) ?? []) add(m[1].replace(/_/g, " "));
    if (n.overrides) for (const k in n.overrides) add(n.overrides[k].style?.fontFamily);
    n.children?.forEach(visit);
  };
  doc.pages.forEach((p) => p.children.forEach(visit));
  for (const v of Object.values(doc.variables ?? {})) if (/^\s*["']?[A-Z]/.test(v) && !v.includes("(")) add(v);
  for (const t of Object.values(doc.themes ?? {})) for (const v of Object.values(t)) if (/^\s*["']?[A-Z]/.test(v) && !v.includes("(")) add(v);
  return [...found].sort();
}

const GENERIC = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif",
  "ui-serif", "ui-monospace", "ui-rounded", "inherit", "initial", "unset", "-apple-system",
  "blinkmacsystemfont", "helvetica", "helvetica neue", "arial", "georgia", "times new roman",
  "menlo", "monaco", "sf pro", "sf pro display", "sf pro text", "sf mono", "courier new",
]);

let fontLink: HTMLLinkElement | null = null;
let fontKey = "";

/** Load the given families. Resolves once the stylesheet is in. */
export function loadFonts(families: string[]): Promise<void> {
  const key = families.join("|");
  if (key === fontKey) return Promise.resolve();
  fontKey = key;
  if (!families.length) return Promise.resolve();
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/fonts.css?f=" + encodeURIComponent(key);
  const done = new Promise<void>((resolve) => {
    link.onload = () => resolve();
    link.onerror = () => resolve();
  });
  document.head.appendChild(link);
  const old = fontLink;
  fontLink = link;
  void done.then(() => old?.remove());
  return done;
}
