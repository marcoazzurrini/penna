import { refsIn } from "../shared/tree.ts";
import type { PennaNode, PennaPage } from "../shared/types.ts";
import type { DocMessage } from "../shared/wire.ts";
import { createCamera, type Rect } from "./camera.ts";
import { startHeadless } from "./headless.ts";
import { DocModel } from "./model.ts";
import { createPlay } from "./play.ts";
import { fontFamilies, loadFonts, renderNode, setKeyframes, setTailwindCss } from "./render.ts";
import { createSidebar } from "./sidebar.ts";

// The viewer: draws the open page, keeps the overlay in place, and wires the modules together.

interface Rendered {
  el: HTMLElement;
  label: HTMLElement;
  sig: string;
  node: PennaNode;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** localStorage can throw (private windows, blocked site data) and is only a convenience here. */
const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

function startViewer() {
  const viewport = $<HTMLElement>("viewport");
  const world = $<HTMLElement>("world");
  const labels = $<HTMLElement>("labels");
  const hoverBox = $<HTMLElement>("hover-box");
  const selectBox = $<HTMLElement>("select-box");
  const projectEl = $<HTMLElement>("project");
  const info = $<HTMLElement>("info");
  const zoomBtn = $<HTMLButtonElement>("zoom");
  const statusEl = $<HTMLElement>("status");
  const empty = $<HTMLElement>("empty");
  const problemsEl = $<HTMLElement>("problems");
  const follow = $<HTMLInputElement>("follow");
  const playBtn = $<HTMLButtonElement>("play");
  const play = createPlay(world);

  let ws: WebSocket | null = null;
  // localStorage is shared by every project served on this port, so keys include the project.
  let project = "";
  const key = (k: string) => `penna:${project}:${k}`;
  const model = new DocModel();
  let pageId = "";
  let selected: string | null = null;
  let hovered: string | null = null;
  const rendered = new Map<string, Rendered>();
  const sizes = new Map<string, { w: number; h: number }>();

  follow.checked = storage.get("penna:follow") !== "0";
  follow.onchange = () => storage.set("penna:follow", follow.checked ? "1" : "0");

  // Theme: follow the system, or force light or dark. The choice applies to every project.
  const THEMES = ["system", "light", "dark"] as const;
  const THEME_ICON = { system: "sun-moon", light: "sun", dark: "moon" };
  const themeBtn = $<HTMLButtonElement>("theme");
  const showTheme = () => {
    const t = (document.documentElement.dataset.theme ?? "system") as (typeof THEMES)[number];
    (themeBtn.firstElementChild as HTMLElement).style.setProperty("--i", `url(/icon/${THEME_ICON[t]}.svg)`);
    const label = `Theme: ${t[0].toUpperCase() + t.slice(1)}`;
    themeBtn.lastElementChild!.textContent = label;
    themeBtn.title = "Switch theme";
  };
  themeBtn.onclick = () => {
    const cur = THEMES.indexOf((document.documentElement.dataset.theme ?? "system") as (typeof THEMES)[number]);
    const next = THEMES[(cur + 1) % THEMES.length];
    document.documentElement.dataset.theme = next;
    storage.set("penna:theme", next);
    showTheme();
  };
  showTheme();

  const page = (): PennaPage | undefined => model.doc?.pages.find((p) => p.id === pageId);

  const camera = createCamera({
    viewport,
    world,
    zoomLabel: zoomBtn,
    onMove: updateOverlay,
    onRest: saveCamera,
    onClick: (x, y) => (play.on ? play.click(x, y) : select(hitTest(x, y), false)),
    onHover: (x, y) => {
      if (!play.on) queueHover(x, y);
    },
    onHoverEnd: () => setHover(null),
  });

  const sidebar = createSidebar({
    pagesEl: $<HTMLUListElement>("pages"),
    layersEl: $<HTMLElement>("layers"),
    doc: () => model.doc,
    page,
    index: () => model.index,
    onOpenPage(id) {
      if (id === pageId) return;
      saveCamera();
      pageId = id;
      selected = null;
      renderDoc(false, true);
    },
    onSelect: (id) => select(id, true),
    onZoomTo: zoomTo,
    onHover: setHover,
  });

  // ---------- Connection ----------

  function connect() {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => {
      statusEl.className = "";
      statusEl.title = "Connected";
    };
    ws.onclose = () => {
      statusEl.className = "off";
      statusEl.title = "Disconnected. Retrying…";
      setTimeout(connect, 1000);
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data) as DocMessage);
  }

  function send(msg: object) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function onMessage(msg: DocMessage) {
    if (msg.t !== "doc") return;
    const label = msg.branch ? `${msg.project} · ${msg.branch}` : msg.project;
    if (msg.project !== project || projectEl.textContent !== label) {
      project = msg.project;
      projectEl.textContent = label;
      projectEl.title = label;
      document.title = `penna · ${label}`;
    }
    const first = !model.doc;
    const changedPages = model.apply(msg);
    const doc = model.doc!;
    if (msg.css !== undefined) setTailwindCss(msg.css);
    setKeyframes(doc.keyframes);
    if (msg.focus && follow.checked && doc.pages.some((p) => p.id === msg.focus)) pageId = msg.focus;
    if (!doc.pages.some((p) => p.id === pageId)) pageId = storage.get(key("page")) ?? "";
    if (!doc.pages.some((p) => p.id === pageId)) pageId = doc.pages[0]?.id ?? "";
    showProblems(msg.problems ?? []);
    // A full message means a new connection, perhaps to a restarted server that has no sizes yet.
    if (msg.full) resendSizes = true;
    renderDoc(first, changedPages.has(pageId));
  }

  function showProblems(problems: string[]) {
    problemsEl.hidden = !problems.length;
    problemsEl.textContent = "";
    for (const p of problems) {
      const line = document.createElement("p");
      line.textContent = p;
      problemsEl.appendChild(line);
    }
  }

  // ---------- Rendering ----------

  function clearCanvas() {
    world.textContent = "";
    labels.textContent = "";
    rendered.clear();
    sizes.clear();
  }

  /** The custom properties now set on the world, so the next update can remove the stale ones. */
  let variableNames: string[] = [];
  function applyVariables(vars: Record<string, string> | undefined) {
    for (const name of variableNames) world.style.removeProperty(name);
    variableNames = [];
    for (const k in vars) {
      const name = "--" + k.replace(/^--/, "");
      world.style.setProperty(name, String(vars[k]));
      variableNames.push(name);
    }
  }

  let lastPage = "";
  let resendSizes = false;
  /** `layersChanged` says whether the open page's nodes, name, or order changed. */
  function renderDoc(first: boolean, layersChanged: boolean) {
    const doc = model.doc;
    if (!doc) return;
    const pg = page();
    const pageChanged = pg?.id !== lastPage;
    if (pageChanged) {
      clearCanvas();
      lastPage = pg?.id ?? "";
      storage.set(key("page"), lastPage);
      send({ t: "view", page: lastPage });
    }
    applyVariables(doc.variables);
    void loadFonts(fontFamilies(doc));

    const ctx = { doc, index: model.index };
    const seen = new Set<string>();
    const nodes = pg?.children ?? [];
    for (const node of nodes) {
      seen.add(node.id);
      const sig = signature(node, pg!.id);
      const prev = rendered.get(node.id);
      if (prev && prev.sig === sig) {
        prev.node = node;
        continue;
      }
      const wrap = document.createElement("div");
      wrap.className = "pn-top";
      wrap.dataset.top = node.id;
      wrap.style.transform = `translate(${node.x ?? 0}px,${node.y ?? 0}px)`;
      const content = renderNode(node, ctx);
      if (content) wrap.appendChild(content);
      if (prev) prev.el.replaceWith(wrap);
      else world.appendChild(wrap);
      const label = prev?.label ?? document.createElement("div");
      label.className = "label";
      label.textContent = node.name ?? node.id;
      if (!prev) labels.appendChild(label);
      rendered.set(node.id, { el: wrap, label, sig, node });
    }
    for (const [id, r] of rendered) {
      if (seen.has(id)) continue;
      r.el.remove();
      r.label.remove();
      rendered.delete(id);
      sizes.delete(id);
    }
    // Keep z-order in sync with the document. Only move frames that are out of place,
    // because moving one makes the browser style and lay it out again.
    let at = world.firstElementChild;
    for (const node of nodes) {
      const el = rendered.get(node.id)?.el;
      if (!el) continue;
      if (el === at) at = at.nextElementSibling;
      else world.insertBefore(el, at);
    }
    // Frames render fully once so we can measure them. After that, content-visibility
    // lets the browser skip painting frames that are off screen.
    requestAnimationFrame(() => {
      const fresh: Record<string, [number, number]> = {};
      for (const [id, r] of rendered) {
        if (r.el.classList.contains("cv")) continue;
        const w = r.el.offsetWidth, h = r.el.offsetHeight;
        sizes.set(id, { w, h });
        fresh[id] = [w, h];
        r.el.style.containIntrinsicSize = `auto ${w}px auto ${h}px`;
        r.el.classList.add("cv");
      }
      // The server uses real sizes to auto-place new screens without overlap.
      if (resendSizes) for (const [id, s] of sizes) fresh[id] = [s.w, s.h];
      resendSizes = false;
      if (Object.keys(fresh).length) send({ t: "sizes", sizes: fresh });
      if (first || pageChanged) restoreCamera();
      else updateOverlay();
    });

    updateEmpty();

    if (selected && !model.index.has(selected) && !world.querySelector(`[data-id="${CSS.escape(selected)}"]`)) selected = null;
    sidebar.renderPages();
    // The layer tree only shows the open page, so most updates leave it as it is.
    if (pageChanged || layersChanged) sidebar.renderLayers(selected);
    else sidebar.select(selected);
  }

  function updateEmpty() {
    const doc = model.doc;
    const msg = !doc ? "" : !doc.pages.some((p) => p.children.length) ? "No designs yet." : !page()?.children.length ? "This page is empty." : "";
    empty.hidden = !msg;
    if (msg) empty.firstElementChild!.textContent = msg;
  }

  /**
   * A string that changes whenever the frame's rendered output could change: the
   * server's hash of the frame, of each frame holding a component it uses, and the themes.
   */
  function signature(node: PennaNode, pageId: string): string {
    let sig = model.hashOf(pageId, node.id) ?? JSON.stringify(node);
    for (const id of refsUsed(node)) {
      const loc = model.index.get(id);
      sig += ` ${id}=${loc ? model.hashOf(loc.page.id, loc.top.id) : "-"}`;
    }
    return sig + model.themesKey;
  }

  // Unchanged nodes keep their objects between updates, so their refs can be cached.
  const directRefs = new WeakMap<PennaNode, string[]>();
  function cachedRefs(node: PennaNode): string[] {
    let refs = directRefs.get(node);
    if (!refs) directRefs.set(node, (refs = refsIn(node)));
    return refs;
  }

  /** Ids of components that `node` uses, directly or through nested instances. */
  function refsUsed(node: PennaNode): Set<string> {
    const out = new Set<string>();
    const queue = [...cachedRefs(node)];
    while (queue.length) {
      const id = queue.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      const comp = model.index.get(id)?.node;
      if (comp) queue.push(...cachedRefs(comp));
    }
    return out;
  }

  // ---------- Camera ----------

  function saveCamera() {
    if (pageId) storage.set(key(`cam:${pageId}`), JSON.stringify(camera.current));
  }

  function restoreCamera() {
    let saved: unknown = null;
    try {
      saved = JSON.parse(storage.get(key(`cam:${pageId}`)) ?? "null");
    } catch {}
    if (!camera.restore(saved)) fitAll();
  }

  function bounds(): Rect | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [id, r] of rendered) {
      const x = r.node.x ?? 0, y = r.node.y ?? 0;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      const size = sizes.get(id) ?? { w: r.el.offsetWidth, h: r.el.offsetHeight };
      x1 = Math.max(x1, x + size.w);
      y1 = Math.max(y1, y + size.h);
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function fitAll() {
    const b = bounds();
    if (b) camera.fitRect(b);
  }

  const elementOf = (id: string) => world.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);

  function zoomTo(id: string) {
    const el = elementOf(id);
    if (!el) return;
    const cam = camera.current;
    const r = el.getBoundingClientRect();
    const v = viewport.getBoundingClientRect();
    camera.fitRect({ x: (r.left - v.left - cam.x) / cam.z, y: (r.top - v.top - cam.y) / cam.z, w: r.width / cam.z, h: r.height / cam.z }, 2);
  }

  function hitTest(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y);
    if (!el || !world.contains(el)) return null;
    return el.closest<HTMLElement>("[data-id]")?.dataset.id ?? null;
  }

  let hoverQueued: { x: number; y: number } | null = null;
  function queueHover(x: number, y: number) {
    const pending = hoverQueued;
    hoverQueued = { x, y };
    if (pending) return;
    requestAnimationFrame(() => {
      const p = hoverQueued!;
      hoverQueued = null;
      setHover(hitTest(p.x, p.y));
    });
  }

  // ---------- Selection & overlay ----------

  function setHover(id: string | null) {
    if (id === hovered) return;
    hovered = id;
    placeBox(hoverBox, id && id !== selected ? id : null);
  }

  function select(id: string | null, fromLayers: boolean) {
    selected = id;
    send({ t: "select", page: pageId, ids: id ? [id] : [] });
    if (fromLayers && id) {
      const v = viewport.getBoundingClientRect();
      const r = elementOf(id)?.getBoundingClientRect();
      if (r && (r.right < v.left || r.left > v.right || r.bottom < v.top || r.top > v.bottom)) zoomTo(id);
    }
    sidebar.select(selected);
    updateOverlay();
  }

  function placeBox(box: HTMLElement, id: string | null) {
    const el = id ? elementOf(id) : null;
    if (!el) {
      box.style.display = "none";
      return null;
    }
    const r = el.getBoundingClientRect();
    const v = viewport.getBoundingClientRect();
    box.style.display = "block";
    box.style.transform = `translate(${r.left - v.left}px,${r.top - v.top}px)`;
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    return r;
  }

  function updateOverlay() {
    const cam = camera.current;
    for (const [id, r] of rendered) {
      const x = (r.node.x ?? 0) * cam.z + cam.x;
      const y = (r.node.y ?? 0) * cam.z + cam.y - 18;
      r.label.style.transform = `translate(${x}px,${y}px)`;
      r.label.style.maxWidth = Math.max((sizes.get(id)?.w ?? 0) * cam.z, 40) + "px";
      r.label.classList.toggle("selected", id === selected);
    }
    placeBox(hoverBox, hovered && hovered !== selected ? hovered : null);
    const rect = placeBox(selectBox, selected);
    renderInfo(rect);
  }

  function renderInfo(rect: DOMRect | null) {
    if (!selected || !rect) {
      info.textContent = "";
      return;
    }
    const name = elementOf(selected)?.dataset.name ?? selected;
    const z = camera.current.z;
    const w = Math.round(rect.width / z), h = Math.round(rect.height / z);
    info.innerHTML = `<b></b><span class="muted">${w} × ${h}</span><code title="Click to copy the id"></code>`;
    info.querySelector("b")!.textContent = name;
    const code = info.querySelector("code")!;
    code.textContent = selected;
    code.onclick = () => navigator.clipboard?.writeText(selected!);
  }

  // ---------- Play mode ----------

  /** In play mode a click runs the node's triggers instead of selecting it. */
  function setPlay(value: boolean) {
    play.set(value);
    if (value) {
      play.replay();
      setHover(null);
    }
    viewport.classList.toggle("playing", value);
    playBtn.setAttribute("aria-pressed", String(value));
    playBtn.lastElementChild!.textContent = value ? "Stop" : "Play";
    (playBtn.firstElementChild as HTMLElement).style.setProperty("--i", `url(/icon/${value ? "square" : "play"}.svg)`);
    updateOverlay();
  }
  playBtn.onclick = () => setPlay(!play.on);
  setPlay(false);

  // ---------- Keyboard ----------

  window.addEventListener("keydown", (e) => {
    // Typing in a field must not trigger shortcuts. A checkbox takes no typing.
    if ((e.target instanceof HTMLInputElement && e.target.type !== "checkbox") || e.target instanceof HTMLSelectElement) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod && !e.altKey && e.key.toLowerCase() === "p") setPlay(!play.on);
    else if (!mod && !e.altKey && e.key.toLowerCase() === "r" && play.on) play.replay();
    else if (e.key === "Escape" && play.on) setPlay(false);
    else if (e.shiftKey && e.code === "Digit1") fitAll();
    else if (e.shiftKey && e.code === "Digit2" && selected) zoomTo(selected);
    else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      send({ t: e.shiftKey ? "redo" : "undo" });
    } else if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      camera.zoomCentre(1.25);
    } else if (mod && e.key === "-") {
      e.preventDefault();
      camera.zoomCentre(0.8);
    } else if (mod && e.key === "0") {
      e.preventDefault();
      camera.zoomCentre(1 / camera.current.z);
    } else if (e.key === "Escape" && selected) {
      const parent = elementOf(selected)?.parentElement?.closest<HTMLElement>("[data-id]");
      select(parent?.dataset.id ?? null, false);
    }
  });

  zoomBtn.onclick = fitAll;
  window.addEventListener("resize", () => updateOverlay());

  connect();
}

if (new URLSearchParams(location.search).has("headless")) {
  startHeadless();
} else {
  startViewer();
}
