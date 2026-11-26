import type { FilmPseudo, FilmReport, FilmRequest, FilmTrack } from "../shared/motion.ts";
import { kebab, variablesToCss } from "../shared/style.ts";
import { indexDoc } from "../shared/tree.ts";
import type { PennaDoc } from "../shared/types.ts";
import { fontFamilies, loadFonts, renderNode, safeSvg, setKeyframes, setTailwindCss } from "./render.ts";

// Render API driven by the server's headless browser for screenshots and layout checks.

const MAX_SIDE = 1600;
const MAX_PROBLEMS = 40;

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r(null)));
}

async function settle(stage: HTMLElement) {
  await nextFrame();
  void stage.offsetHeight;
  await document.fonts.ready;
  const imgs = [...stage.querySelectorAll("img")].filter((i) => !i.complete);
  await Promise.race([
    Promise.all(imgs.map((i) => new Promise((r) => ((i.onload = r), (i.onerror = r))))),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  await nextFrame();
}

/**
 * Bring every animation to its end, so a still picture or a measurement shows the
 * design at rest and not a moment of an entrance. Loops go back to their start.
 */
function rest() {
  for (const a of document.getAnimations()) {
    const end = a.effect?.getComputedTiming().endTime;
    if (typeof end === "number" && Number.isFinite(end)) a.finish();
    else a.cancel();
  }
}

/** `css` is null when the stylesheet from the last call still applies. */
async function mount(doc: PennaDoc, css: string | null, nodeId: string): Promise<HTMLElement> {
  document.getElementById("stage")?.remove();
  if (css !== null) setTailwindCss(css);
  setKeyframes(doc.keyframes);
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
    rest();
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
  const el = renderNode({ ...loc.node, hidden: false }, ctx);
  if (el) stage.appendChild(el);
  await settle(stage);
  rest();
  return stage;
}

async function render(doc: PennaDoc, css: string | null, nodeId: string, scale?: number) {
  const stage = await mount(doc, css, nodeId);
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

async function layout(doc: PennaDoc, css: string | null, nodeId: string) {
  const stage = await mount(doc, css, nodeId);
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

// ---------- Motion ----------
//
// A film draws the screen once per frame, side by side. Every animation is paused the
// moment it appears and then moved to its copy's time, so nothing depends on the clock.

interface FilmCell {
  label: HTMLElement;
  crop: HTMLElement;
  inner: HTMLElement;
}

interface Film {
  req: FilmRequest;
  stage: HTMLElement;
  cells: FilmCell[];
  /** Animations that started before the change, such as ones that play on load. */
  early: Set<Animation>;
  /** Animations that started after the screen settled: the ones the change set off. */
  late: Set<Animation>;
  settled: boolean;
  watch: number;
}

let film: Film | null = null;

const TRACK_LIMIT = 24;
const FILM_PAD = 12;
const LABEL_HEIGHT = 20;
/** Properties that make the browser lay the page out again on every frame. */
const LAYOUT_PROPS = /^(width|height|top|left|right|bottom|inset.*|margin.*|padding.*|min-.*|max-.*|font-size|line-height|gap|flex-basis|grid-template.*)$/;

const byId = (root: Element, id: string) => root.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);

function setState(el: HTMLElement, state: string | null) {
  if (state) el.dataset.state = state;
  else delete el.dataset.state;
}

function pauseNew(f: Film) {
  for (const a of document.getAnimations()) {
    if (f.early.has(a) || f.late.has(a)) continue;
    a.pause();
    (f.settled ? f.late : f.early).add(a);
  }
}

async function filmStart(doc: PennaDoc, css: string | null, req: FilmRequest): Promise<FilmPseudo[]> {
  filmEnd();
  document.getElementById("stage")?.remove();
  if (css !== null) setTailwindCss(css);
  setKeyframes(doc.keyframes);
  await loadFonts(fontFamilies(doc));
  const index = indexDoc(doc);
  const top = index.get(req.top)?.node;
  if (!top) throw new Error(`No node ${req.top}`);

  const stage = document.createElement("div");
  stage.id = "stage";
  stage.className = "pn-root film";
  stage.style.cssText = variablesToCss(doc.variables);
  const cells: FilmCell[] = [];
  const count = req.times?.length ?? req.frames;
  for (let i = 0; i < count; i++) {
    const el = renderNode({ ...top, hidden: false }, { doc, index });
    if (!el) throw new Error("Nothing to render.");
    const cell = document.createElement("div");
    const label = document.createElement("div");
    label.className = "film-label";
    const crop = document.createElement("div");
    crop.className = "film-crop";
    const inner = document.createElement("div");
    inner.className = "film-inner";
    inner.appendChild(el);
    crop.appendChild(inner);
    cell.append(label, crop);
    stage.appendChild(cell);
    cells.push({ label, crop, inner });
    if (!byId(inner, req.target)) throw new Error("The node to watch is hidden, so it has no motion to sample.");
    for (const id in req.from) {
      const node = byId(inner, id);
      if (!node) throw new Error(`Node ${id} is hidden, so its state cannot be set.`);
      setState(node, req.from[id]);
    }
    for (const id in req.pseudo) {
      const node = byId(inner, id);
      if (!node) throw new Error(`Node ${id} is hidden, so it cannot be hovered or focused.`);
      node.dataset.filmPseudo = req.pseudo[id].join(" ");
    }
  }
  document.body.appendChild(stage);
  const f: Film = { req, stage, cells, early: new Set(), late: new Set(), settled: false, watch: 0 };
  film = f;
  // Animations that play on load start now. Hold each one at its start.
  const watch = () => {
    pauseNew(f);
    f.watch = requestAnimationFrame(watch);
  };
  watch();
  await settle(stage);
  pauseNew(f);
  f.settled = true;
  const sets = new Set(Object.values(req.pseudo).map((classes) => classes.join(" ")));
  return [...sets].map((set) => ({ selector: `[data-film-pseudo="${set}"]`, classes: set.split(" ") }));
}

/** Where an element sits below `root`, as child positions, to find its twin in another copy. */
function pathFrom(root: Element, el: Element): number[] {
  const path: number[] = [];
  for (let n: Element = el; n !== root; n = n.parentElement!) path.unshift([...n.parentElement!.children].indexOf(n));
  return path;
}

function follow(root: Element, path: number[]): Element | null {
  let n: Element | null = root;
  for (const i of path) n = n?.children[i] ?? null;
  return n;
}

/** One iteration of an animation, including its delay, in ms. */
function endOf(a: Animation): number {
  const t = a.effect?.getComputedTiming();
  if (!t) return 0;
  if (typeof t.endTime === "number" && Number.isFinite(t.endTime)) return t.endTime;
  return (t.delay ?? 0) + (typeof t.duration === "number" ? t.duration : 0);
}

function properties(a: Animation): string[] {
  const transition = (a as Animation & { transitionProperty?: string }).transitionProperty;
  if (transition) return [transition];
  const found = new Set<string>();
  for (const frame of (a.effect as KeyframeEffect).getKeyframes()) {
    for (const k in frame) {
      if (k === "offset" || k === "computedOffset" || k === "easing" || k === "composite") continue;
      found.add(k === "cssFloat" ? "float" : k === "cssOffset" ? "offset" : kebab(k));
    }
  }
  return [...found];
}

/** Computed values are long: round the numbers and cap the length. */
function tidy(value: string): string {
  const v = value.replace(/-?\d*\.\d{4,}(e-?\d+)?/g, (n) => String(Math.round(parseFloat(n) * 1000) / 1000));
  return v.length > 64 ? v.slice(0, 63) + "…" : v;
}

function filmSample(): FilmReport {
  const f = film;
  if (!f) throw new Error("No film is running.");
  cancelAnimationFrame(f.watch);
  pauseNew(f);
  const { req, cells, stage } = f;
  const cellOf = (el: Element | null) => (el ? cells.findIndex((c) => c.inner.contains(el)) : -1);
  const targetOf = (a: Animation) => (a.effect as KeyframeEffect | null)?.target ?? null;

  const changes = Object.keys(req.to).length + Object.keys(req.pseudo).length > 0;
  let anims = [...f.early];
  if (changes) {
    // Bring what played on load to rest, so only the change is in motion. Loops stay.
    const loops: Animation[] = [];
    for (const a of f.early) {
      const end = a.effect?.getComputedTiming().endTime;
      if (typeof end === "number" && Number.isFinite(end)) a.currentTime = end;
      else loops.push(a);
    }
    for (const c of cells) for (const id in req.to) setState(byId(c.inner, id)!, req.to[id]);
    // Reading a computed style makes the browser start the transitions.
    void getComputedStyle(stage).opacity;
    pauseNew(f);
    anims = [...loops, ...f.late];
  }

  // The motion lasts as long as what the change set off inside the watched node. A
  // spinner that loops there, or anything elsewhere on the screen, must not stretch it.
  const watched = byId(cells[0].inner, req.target)!;
  const first = anims.filter((a) => cellOf(targetOf(a)) === 0);
  const inside = first.filter((a) => watched.contains(targetOf(a)));
  const caused = inside.filter((a) => f.late.has(a));
  const natural = Math.max(0, ...(caused.length ? caused : inside).map(endOf));
  const span = req.duration ?? natural;
  const times = req.times ?? cells.map((_, i) => (cells.length > 1 ? (span * i) / (cells.length - 1) : 0));
  for (const a of anims) {
    const i = cellOf(targetOf(a));
    if (i >= 0) a.currentTime = times[i];
  }

  // What changed, read from the first copy and followed into the others.
  const tracks: FilmTrack[] = [];
  const moving: number[][] = [];
  const seen = new Set<string>();
  const layout = new Set<string>();
  let hidden = 0, outside = 0;
  for (const a of first) {
    const el = targetOf(a)!;
    if (!watched.contains(el)) {
      outside++;
      continue;
    }
    const path = pathFrom(cells[0].inner, el);
    const pseudo = (a.effect as KeyframeEffect).pseudoElement ?? null;
    const owner = el.closest<HTMLElement>("[data-id]");
    let shown = false;
    for (const property of properties(a)) {
      const key = path.join(".") + (pseudo ?? "") + " " + property;
      if (seen.has(key)) continue;
      seen.add(key);
      const values = cells.map((c) => {
        const twin = follow(c.inner, path);
        return twin ? tidy(getComputedStyle(twin, pseudo).getPropertyValue(property)) : "";
      });
      if (values.every((v) => v === values[0])) continue;
      shown = true;
      if (LAYOUT_PROPS.test(property)) layout.add(property);
      if (tracks.length < TRACK_LIMIT) tracks.push({ id: owner?.dataset.id ?? "", name: (owner?.dataset.name ?? "?") + (pseudo ?? ""), property, values });
      else hidden++;
    }
    if (shown) moving.push(path);
    else hidden++;
  }

  const problems: string[] = [];
  const name = watched.dataset.name ?? req.target;
  if (!first.length || first.length === outside) {
    problems.push(
      changes
        ? `Nothing inside ${name} animated. The node that changes needs a transition (class "transition") and a style for the new state, such as data-[state=open]:opacity-100 or hover:scale-105.`
        : `Nothing inside ${name} animates on load. To sample a transition, pass what starts it: {state: "open"}, {hover: true}, {active: true} or {focus: true}.`,
    );
  } else if (!tracks.length) {
    problems.push(`Animations ran inside ${name}, but no value changed between the sampled moments.`);
  }
  if (layout.size) problems.push(`Animating ${[...layout].join(", ")} lays the page out again on every frame. transform, scale, translate and opacity are smoother.`);

  // Crop every frame to the same box: wherever the watched node and its moving parts go.
  const screen = cells[0].inner.firstElementChild as HTMLElement;
  const full = { x: 0, y: 0, w: screen.offsetWidth, h: screen.offsetHeight };
  let box = full;
  if (screen !== watched) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const targetPath = pathFrom(cells[0].inner, watched);
    for (const c of cells) {
      const origin = c.inner.getBoundingClientRect();
      for (const path of [targetPath, ...moving]) {
        const r = follow(c.inner, path)?.getBoundingClientRect();
        if (!r || (r.width < 0.5 && r.height < 0.5)) continue;
        x0 = Math.min(x0, r.left - origin.left);
        y0 = Math.min(y0, r.top - origin.top);
        x1 = Math.max(x1, r.right - origin.left);
        y1 = Math.max(y1, r.bottom - origin.top);
      }
    }
    x0 = Math.max(0, Math.floor(x0 - FILM_PAD));
    y0 = Math.max(0, Math.floor(y0 - FILM_PAD));
    x1 = Math.min(full.w, Math.ceil(x1 + FILM_PAD));
    y1 = Math.min(full.h, Math.ceil(y1 + FILM_PAD));
    if (x1 > x0 && y1 > y0) box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // With nothing in motion every frame is the same, so one is enough.
  const shown = tracks.length || hidden ? cells.length : 1;
  cells.forEach((c, i) => {
    (c.crop.parentElement as HTMLElement).style.display = i < shown ? "" : "none";
    c.label.textContent = `${Math.round(times[i])} ms`;
    c.crop.style.width = box.w + "px";
    c.crop.style.height = box.h + "px";
    c.inner.style.left = -box.x + "px";
    c.inner.style.top = -box.y + "px";
  });

  // Pick the grid that keeps the frames largest inside the size limit. The whole stage is
  // scaled with a transform: `zoom` would change computed lengths and restart transitions.
  const GAP = 10;
  const fit = (labelHeight: number) => {
    let best = { cols: shown, scale: 0 };
    for (let cols = shown; cols >= 1; cols--) {
      const rows = Math.ceil(shown / cols);
      const w = cols * box.w + (cols + 1) * GAP;
      const h = rows * (box.h + labelHeight) + (rows + 1) * GAP;
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      if (scale > best.scale) best = { cols, scale };
    }
    return best;
  };
  // Labels are drawn larger when the stage is scaled down, so they stay readable.
  let grid = fit(LABEL_HEIGHT);
  grid = fit(LABEL_HEIGHT / grid.scale);
  const scale = req.scale ?? grid.scale;
  stage.style.gridTemplateColumns = `repeat(${grid.cols}, max-content)`;
  stage.style.setProperty("--film-label", String(1 / Math.min(1, scale)));
  stage.style.transform = `scale(${scale})`;
  const size = stage.getBoundingClientRect();

  return { times: times.slice(0, shown), duration: natural, tracks, hidden, outside, problems, width: Math.round(size.width), height: Math.round(size.height) };
}

function filmEnd() {
  if (!film) return;
  cancelAnimationFrame(film.watch);
  film.stage.remove();
  film = null;
}

export function startHeadless() {
  document.body.classList.add("headless");
  (window as unknown as { __penna: unknown }).__penna = {
    ready: true,
    render,
    layout,
    filmStart,
    filmSample,
    filmEnd,
    // For tests of the sanitizer, which needs a real DOM.
    sanitizeSvg: (markup: string) => safeSvg(markup)?.outerHTML ?? null,
  };
}
