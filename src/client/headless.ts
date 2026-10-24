import { variablesToCss } from "../shared/style.ts";
import { indexDoc } from "../shared/tree.ts";
import type { RenderDoc } from "../shared/types.ts";
import { fontFamilies, loadFonts, renderNode } from "./render.ts";

// Render API driven by the server's headless browser for screenshots and layout checks.

const MAX_SIDE = 1600;
const MAX_PROBLEMS = 40;

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r(null)));
}

async function settle(stage: HTMLElement) {
  await nextFrame();
  await nextFrame(); // Tailwind compiles new classes on a mutation observer.
  void stage.offsetHeight;
  await document.fonts.ready;
  const imgs = [...stage.querySelectorAll("img")].filter((i) => !i.complete);
  await Promise.race([
    Promise.all(imgs.map((i) => new Promise((r) => ((i.onload = r), (i.onerror = r))))),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  await nextFrame();
}

async function mount(doc: RenderDoc, pageId: string, nodeId: string): Promise<HTMLElement> {
  document.getElementById("stage")?.remove();
  const stage = document.createElement("div");
  stage.id = "stage";
  stage.className = "pn-root";
  stage.style.cssText = variablesToCss(doc.variables);
  document.body.appendChild(stage);
  await loadFonts(fontFamilies(doc));

  const index = indexDoc(doc);
  const ctx = { doc, index };
  const page = doc.pages.find((p) => p.id === nodeId);
  if (page) {
    // Whole page: place top-level nodes at their canvas positions, shifted to the origin.
    const minX = Math.min(...page.children.map((n) => n.x ?? 0));
    const minY = Math.min(...page.children.map((n) => n.y ?? 0));
    stage.style.position = "absolute";
    for (const n of page.children) {
      const el = renderNode(n, ctx);
      if (!el) continue;
      const wrap = document.createElement("div");
      wrap.style.cssText = `position:absolute;left:${(n.x ?? 0) - minX}px;top:${(n.y ?? 0) - minY}px`;
      wrap.appendChild(el);
      stage.appendChild(wrap);
    }
    await settle(stage);
    let w = 0, h = 0;
    for (const c of stage.children as HTMLCollectionOf<HTMLElement>) {
      w = Math.max(w, c.offsetLeft + c.offsetWidth);
      h = Math.max(h, c.offsetTop + c.offsetHeight);
    }
    stage.style.width = w + "px";
    stage.style.height = h + "px";
    return stage;
  }
  const loc = index.get(nodeId);
  if (!loc) throw new Error(`No node ${nodeId}`);
  void pageId;
  const el = renderNode({ ...loc.node, hidden: false }, ctx);
  if (el) stage.appendChild(el);
  await settle(stage);
  return stage;
}

async function render(doc: RenderDoc, pageId: string, nodeId: string, scale?: number) {
  const stage = await mount(doc, pageId, nodeId);
  const r = stage.getBoundingClientRect();
  const s = scale ?? Math.min(1, MAX_SIDE / Math.max(r.width, r.height, 1));
  if (s !== 1) {
    stage.style.zoom = String(s);
    await nextFrame();
  }
  const out = stage.getBoundingClientRect();
  return { width: Math.round(out.width), height: Math.round(out.height), scale: s };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function layout(doc: RenderDoc, pageId: string, nodeId: string) {
  const stage = await mount(doc, pageId, nodeId);
  const root = stage.firstElementChild as HTMLElement | null;
  if (!root) return { width: 0, height: 0, nodes: [], problems: ["Node is hidden or empty."] };
  const origin = root.getBoundingClientRect();
  const rect = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
  };
  const name = (el: HTMLElement) => `${el.dataset.name ?? "?"} (${el.dataset.id})`;
  const nodes: [string, string, number, number, number, number][] = [];
  const problems: string[] = [];
  const els = [root, ...root.querySelectorAll<HTMLElement>("[data-id]")];
  for (const el of els) {
    const r = rect(el);
    nodes.push([el.dataset.id!, el.dataset.name ?? "", Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]);
    if (problems.length >= MAX_PROBLEMS) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    if ((r.w < 0.5 || r.h < 0.5) && (el.childElementCount || el.textContent)) {
      problems.push(`${name(el)} has zero ${r.w < 0.5 ? "width" : "height"}.`);
      continue;
    }
    if (el.classList.contains("pn-text")) {
      // Glyphs can poke a few px outside tight line-heights. Only flag real overflow:
      // horizontal beyond 2px, vertical beyond half a line.
      const fontSize = parseFloat(cs.fontSize);
      const line = cs.lineHeight === "normal" ? fontSize * 1.2 : parseFloat(cs.lineHeight);
      if (el.scrollWidth > el.clientWidth + 2) problems.push(`${name(el)}: text is wider than its box (${el.scrollWidth} > ${el.clientWidth}).`);
      if (el.scrollHeight > el.clientHeight + line / 2) problems.push(`${name(el)}: text is taller than its box (${el.scrollHeight} > ${el.clientHeight}).`);
    }
    if (el === root) continue;
    const parent = el.parentElement?.closest<HTMLElement>("[data-id]");
    if (!parent || cs.position === "fixed") continue;
    const p = rect(parent);
    const out = Math.max(p.x - r.x, r.x + r.w - (p.x + p.w), p.y - r.y, r.y + r.h - (p.y + p.h));
    if (out > 1) {
      const pcs = getComputedStyle(parent);
      const clips = pcs.overflow !== "visible" || pcs.overflowX !== "visible" || pcs.overflowY !== "visible";
      const fully = r.x >= p.x + p.w || r.x + r.w <= p.x || r.y >= p.y + p.h || r.y + r.h <= p.y;
      if (clips) problems.push(`${name(el)} is ${fully ? "fully" : "partly"} clipped by ${name(parent)} (${Math.round(out)}px).`);
      else if (cs.position !== "absolute") problems.push(`${name(el)} sticks out of ${name(parent)} by ${Math.round(out)}px.`);
    }
  }
  if (problems.length >= MAX_PROBLEMS) problems.push("…more problems not shown.");
  return { width: Math.round(origin.width), height: Math.round(origin.height), nodes, problems };
}

export function startHeadless() {
  document.body.classList.add("headless");
  (window as unknown as { __penna: unknown }).__penna = { ready: true, render, layout };
}
