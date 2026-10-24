import { variablesToCss } from "../shared/style.ts";
import { indexDoc, refsUsed, type Located } from "../shared/tree.ts";
import type { PennaNode, PennaPage, PennaDoc } from "../shared/types.ts";
import { startHeadless } from "./headless.ts";
import { fontFamilies, loadFonts, renderNode } from "./render.ts";

interface Camera {
  x: number;
  y: number;
  z: number;
}

interface Rendered {
  el: HTMLElement;
  label: HTMLElement;
  sig: string;
  node: PennaNode;
}

type ServerMsg = { t: "doc"; project: string; rev: number; doc: PennaDoc; focus?: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function startViewer() {
  const viewport = $<HTMLElement>("viewport");
  const world = $<HTMLElement>("world");
  const labels = $<HTMLElement>("labels");
  const hoverBox = $<HTMLElement>("hover-box");
  const selectBox = $<HTMLElement>("select-box");
  const projectEl = $<HTMLElement>("project");
  const pagesEl = $<HTMLUListElement>("pages");
  const layersEl = $<HTMLElement>("layers");
  const info = $<HTMLElement>("info");
  const zoomBtn = $<HTMLButtonElement>("zoom");
  const statusEl = $<HTMLElement>("status");
  const empty = $<HTMLElement>("empty");
  const follow = $<HTMLInputElement>("follow");

  let ws: WebSocket | null = null;
  // localStorage is shared by every project served on this port, so keys include the project.
  let project = "";
  const key = (k: string) => `penna:${project}:${k}`;
  let doc: PennaDoc | null = null;
  let index = new Map<string, Located>();
  let pageId = "";
  let selected: string | null = null;
  let hovered: string | null = null;
  let cam: Camera = { x: 0, y: 0, z: 1 };
  const rendered = new Map<string, Rendered>();
  const expanded = new Set<string>();
  const sizes = new Map<string, { w: number; h: number }>();

  follow.checked = localStorage.getItem("penna:follow") !== "0";
  follow.onchange = () => localStorage.setItem("penna:follow", follow.checked ? "1" : "0");

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
    localStorage.setItem("penna:theme", next);
    showTheme();
  };
  showTheme();

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
    ws.onmessage = (e) => onMessage(JSON.parse(e.data) as ServerMsg);
  }

  function send(msg: object) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function onMessage(msg: ServerMsg) {
    if (msg.t === "doc") {
      if (msg.project !== project) {
        project = msg.project;
        projectEl.textContent = project;
        document.title = `penna · ${project}`;
      }
      const first = !doc;
      doc = msg.doc;
      index = indexDoc(doc);
      if (msg.focus && follow.checked && doc.pages.some((p) => p.id === msg.focus)) pageId = msg.focus;
      if (!doc.pages.some((p) => p.id === pageId)) pageId = localStorage.getItem(key("page")) ?? "";
      if (!doc.pages.some((p) => p.id === pageId)) pageId = doc.pages[0]?.id ?? "";
      renderDoc(first);
    }
  }

  // ---------- Rendering ----------

  function page(): PennaPage | undefined {
    return doc?.pages.find((p) => p.id === pageId);
  }

  function clearCanvas() {
    world.textContent = "";
    labels.textContent = "";
    rendered.clear();
    sizes.clear();
  }

  let lastPage = "";
  function renderDoc(first: boolean) {
    if (!doc) return;
    const pg = page();
    const pageChanged = pg?.id !== lastPage;
    if (pageChanged) {
      clearCanvas();
      lastPage = pg?.id ?? "";
      localStorage.setItem(key("page"), lastPage);
      send({ t: "view", page: lastPage });
    }
    world.style.cssText = variablesToCss(doc.variables) + world.style.cssText.replace(/--[^;]+;/g, "");
    void loadFonts(fontFamilies(doc));

    const ctx = { doc, index };
    const seen = new Set<string>();
    const nodes = pg?.children ?? [];
    for (const node of nodes) {
      seen.add(node.id);
      const sig = signature(node);
      const prev = rendered.get(node.id);
      if (prev && prev.sig === sig) {
        prev.node = node;
        world.appendChild(prev.el); // keeps z-order in sync with the document
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
    }
    // Frames render fully once so we can measure them. After that, content-visibility
    // lets the browser skip painting frames that are off screen.
    requestAnimationFrame(() => {
      for (const [id, r] of rendered) {
        if (r.el.classList.contains("cv")) continue;
        const w = r.el.offsetWidth, h = r.el.offsetHeight;
        sizes.set(id, { w, h });
        r.el.style.containIntrinsicSize = `auto ${w}px auto ${h}px`;
        r.el.classList.add("cv");
      }
      // The server uses real sizes to auto-place new screens without overlap.
      send({ t: "sizes", sizes: Object.fromEntries([...sizes].map(([id, s]) => [id, [s.w, s.h]])) });
      if (first || pageChanged) restoreCamera();
      else updateOverlay();
    });

    updateEmpty();

    if (selected && !document.querySelector(`[data-id="${CSS.escape(selected)}"]`) && !index.has(selected)) selected = null;
    renderPages();
    renderLayers();
  }

  function updateEmpty() {
    const msg = !doc ? "" : !doc.pages.some((p) => p.children.length) ? "No designs yet." : !page()?.children.length ? "This page is empty." : "";
    empty.hidden = !msg;
    if (msg) empty.firstElementChild!.textContent = msg;
  }

  /** A string that changes whenever the frame's rendered output could change. */
  function signature(node: PennaNode): string {
    let sig = JSON.stringify(node);
    const used = refsUsed(node, index);
    for (const id of used) sig += JSON.stringify(index.get(id)?.node ?? null);
    if (doc?.themes) sig += JSON.stringify(doc.themes);
    return sig;
  }

  // ---------- Sidebar ----------


  function renderPages() {
    pagesEl.textContent = "";
    for (const p of doc?.pages ?? []) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = p.id === pageId ? "row active" : "row";
      if (p.id === pageId) btn.setAttribute("aria-current", "page");
      btn.innerHTML = `<span class="lname"></span><span class="count"></span>`;
      btn.firstElementChild!.textContent = p.name;
      btn.lastElementChild!.textContent = p.children.length ? String(p.children.length) : "";
      btn.onclick = () => {
        if (p.id === pageId) return;
        saveCamera();
        pageId = p.id;
        selected = null;
        renderDoc(false);
      };
      li.appendChild(btn);
      pagesEl.appendChild(li);
    }
  }

  const KIND: Record<string, string> = { text: "type", image: "image", icon: "shapes", svg: "spline", ref: "diamond" };
  const icon = (name: string, cls = "") => `<i class="ico ${cls}" style="--i:url(/icon/${name}.svg)"></i>`;

  /** Lucide icon for a layer row. Frames show their layout, like Figma's auto layout icons. */
  function kindIcon(n: PennaNode, depth: number): string {
    if (n.component) return "component";
    if (n.type !== "frame") return KIND[n.type] ?? "square-dashed";
    if (depth === 0) return "frame";
    const display = String(n.style?.display ?? "");
    const cls = ` ${n.class ?? ""} `;
    if (display === "grid" || / grid /.test(cls)) return "layout-grid";
    if (display === "flex" || / flex /.test(cls)) {
      const column = String(n.style?.flexDirection ?? "").startsWith("column") || / flex-col /.test(cls);
      return column ? "rows-3" : "columns-3";
    }
    return "square-dashed";
  }

  function renderLayers() {
    layersEl.textContent = "";
    const frag = document.createDocumentFragment();
    if (selected) {
      // Reveal the selected node by expanding its ancestors.
      let loc = index.get(selected.split("/")[0]);
      while (loc && "type" in loc.parent) {
        expanded.add(loc.parent.id);
        loc = index.get(loc.parent.id);
      }
    }
    const row = (n: PennaNode, depth: number) => {
      const div = document.createElement("div");
      div.className = "layer";
      if (n.component) div.classList.add("component");
      if (n.type === "ref") div.classList.add("instance");
      // Parts of an instance aren't listed, so highlight the instance itself.
      if (selected && (n.id === selected || n.id === selected.split("/")[0])) div.classList.add("selected");
      div.style.paddingInlineStart = 4 + depth * 14 + "px";
      const hasKids = !!n.children?.length;
      const open = expanded.has(n.id);
      if (open) div.classList.add("open");
      div.innerHTML = `<span class="twisty">${hasKids ? icon("chevron-right") : ""}</span>${icon(kindIcon(n, depth), "kind")}<span class="lname"></span>`;
      div.querySelector(".lname")!.textContent = n.name ?? n.id;
      if (n.hidden) div.classList.add("hidden-node");
      div.querySelector(".twisty")!.addEventListener("click", (e) => {
        e.stopPropagation();
        if (open) expanded.delete(n.id);
        else expanded.add(n.id);
        renderLayers();
      });
      div.onclick = () => select(n.id, true);
      div.ondblclick = () => zoomTo(n.id);
      div.onmouseenter = () => setHover(n.id);
      div.onmouseleave = () => setHover(null);
      frag.appendChild(div);
      if (hasKids && open) for (const c of n.children!) row(c, depth + 1);
    };
    for (const n of page()?.children ?? []) row(n, 0);
    layersEl.appendChild(frag);
    layersEl.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }

  // ---------- Camera ----------

  let moveTimer: number | undefined;
  let frameQueued = false;

  function applyCamera() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      world.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.z})`;
      zoomBtn.textContent = Math.round(cam.z * 100) + "%";
      updateOverlay();
    });
    // Promote the world to its own GPU layer while moving, then let it re-raster crisply.
    world.classList.add("moving");
    clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => {
      world.classList.remove("moving");
      saveCamera();
    }, 180);
  }

  function saveCamera() {
    if (pageId) localStorage.setItem(key(`cam:${pageId}`), JSON.stringify(cam));
  }

  function restoreCamera() {
    const saved = localStorage.getItem(key(`cam:${pageId}`));
    if (saved) {
      cam = JSON.parse(saved);
      applyCamera();
    } else fitAll();
  }

  function bounds(ids?: string[]) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [id, r] of rendered) {
      if (ids && !ids.includes(id)) continue;
      const x = r.node.x ?? 0, y = r.node.y ?? 0;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      const size = sizes.get(id) ?? { w: r.el.offsetWidth, h: r.el.offsetHeight };
      x1 = Math.max(x1, x + size.w);
      y1 = Math.max(y1, y + size.h);
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function fitRect(b: { x: number; y: number; w: number; h: number }, maxZoom = 1) {
    const vw = viewport.clientWidth, vh = viewport.clientHeight, pad = 64;
    const z = Math.min((vw - pad * 2) / Math.max(b.w, 1), (vh - pad * 2) / Math.max(b.h, 1), maxZoom);
    cam = { z, x: (vw - b.w * z) / 2 - b.x * z, y: (vh - b.h * z) / 2 - b.y * z };
    applyCamera();
  }

  function fitAll() {
    const b = bounds();
    if (b) fitRect(b);
  }

  function zoomTo(id: string) {
    const el = world.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const v = viewport.getBoundingClientRect();
    fitRect({ x: (r.left - v.left - cam.x) / cam.z, y: (r.top - v.top - cam.y) / cam.z, w: r.width / cam.z, h: r.height / cam.z }, 2);
  }

  function zoomAt(factor: number, sx: number, sy: number) {
    const z = Math.min(8, Math.max(0.02, cam.z * factor));
    const k = z / cam.z;
    cam = { z, x: sx - (sx - cam.x) * k, y: sy - (sy - cam.y) * k };
    applyCamera();
  }

  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const v = viewport.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const dy = Math.max(-30, Math.min(30, e.deltaMode ? e.deltaY * 16 : e.deltaY));
        zoomAt(Math.exp(-dy / 120), e.clientX - v.left, e.clientY - v.top);
      } else {
        const k = e.deltaMode ? 16 : 1;
        cam.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
        cam.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
        applyCamera();
      }
    },
    { passive: false },
  );

  // Safari pinch gestures.
  let gestureZ = 1;
  viewport.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gestureZ = cam.z;
  });
  viewport.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    const g = e as unknown as { scale: number; clientX: number; clientY: number };
    const v = viewport.getBoundingClientRect();
    zoomAt((gestureZ * g.scale) / cam.z, g.clientX - v.left, g.clientY - v.top);
  });

  // Drag pans, click selects.
  let drag: { x: number; y: number; cx: number; cy: number; moved: boolean; id: number } | null = null;
  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest("#hud")) return;
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, id: e.pointerId };
  });
  window.addEventListener("pointermove", (e) => {
    if (drag && drag.id === e.pointerId) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 3) {
        drag.moved = true;
        viewport.classList.add("panning");
        viewport.setPointerCapture(e.pointerId);
        setHover(null);
      }
      if (drag.moved) {
        cam.x = drag.cx + dx;
        cam.y = drag.cy + dy;
        applyCamera();
      }
      return;
    }
    if (e.target instanceof Node && viewport.contains(e.target)) queueHover(e.clientX, e.clientY);
  });
  window.addEventListener("pointerup", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const wasClick = !drag.moved;
    drag = null;
    viewport.classList.remove("panning");
    if (wasClick && e.button === 0 && !(e.target as HTMLElement).closest("#hud")) select(hitTest(e.clientX, e.clientY), false);
  });
  viewport.addEventListener("pointerleave", () => setHover(null));

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
      const el = world.querySelector(`[data-id="${CSS.escape(id)}"]`);
      const v = viewport.getBoundingClientRect();
      const r = el?.getBoundingClientRect();
      if (r && (r.right < v.left || r.left > v.right || r.bottom < v.top || r.top > v.bottom)) zoomTo(id);
    }
    renderLayers();
    updateOverlay();
  }

  function placeBox(box: HTMLElement, id: string | null) {
    const el = id ? world.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) : null;
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
    const el = world.querySelector<HTMLElement>(`[data-id="${CSS.escape(selected)}"]`);
    const name = el?.dataset.name ?? selected;
    const w = Math.round(rect.width / cam.z), h = Math.round(rect.height / cam.z);
    info.innerHTML = `<b></b><span class="muted">${w} × ${h}</span><code title="Click to copy the id"></code>`;
    info.querySelector("b")!.textContent = name;
    const code = info.querySelector("code")!;
    code.textContent = selected;
    code.onclick = () => navigator.clipboard?.writeText(selected!);
  }

  // ---------- Keyboard ----------

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.shiftKey && e.code === "Digit1") fitAll();
    else if (e.shiftKey && e.code === "Digit2" && selected) zoomTo(selected);
    else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      send({ t: e.shiftKey ? "redo" : "undo" });
    } else if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoomAt(1.25, viewport.clientWidth / 2, viewport.clientHeight / 2);
    } else if (mod && e.key === "-") {
      e.preventDefault();
      zoomAt(0.8, viewport.clientWidth / 2, viewport.clientHeight / 2);
    } else if (mod && e.key === "0") {
      e.preventDefault();
      zoomAt(1 / cam.z, viewport.clientWidth / 2, viewport.clientHeight / 2);
    } else if (e.key === "Escape" && selected) {
      const parent = world.querySelector(`[data-id="${CSS.escape(selected)}"]`)?.parentElement?.closest<HTMLElement>("[data-id]");
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
