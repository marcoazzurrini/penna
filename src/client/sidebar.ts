import type { Located } from "../shared/tree.ts";
import type { PennaDoc, PennaNode, PennaPage } from "../shared/types.ts";

// The sidebar: the page list and the layer tree of the open page.

export interface SidebarOptions {
  pagesEl: HTMLElement;
  layersEl: HTMLElement;
  doc(): PennaDoc | null;
  page(): PennaPage | undefined;
  index(): Map<string, Located>;
  onOpenPage(id: string): void;
  onSelect(id: string): void;
  onZoomTo(id: string): void;
  onHover(id: string | null): void;
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

export function createSidebar(opts: SidebarOptions) {
  const { pagesEl, layersEl } = opts;
  const expanded = new Set<string>();
  /** The rows now in the layer tree, by node id. */
  const rows = new Map<string, HTMLElement>();
  let selectedRow: HTMLElement | null = null;

  function renderPages() {
    const current = opts.page()?.id;
    pagesEl.textContent = "";
    for (const p of opts.doc()?.pages ?? []) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = p.id === current ? "row active" : "row";
      if (p.id === current) btn.setAttribute("aria-current", "page");
      btn.innerHTML = `<span class="lname"></span><span class="count"></span>`;
      btn.firstElementChild!.textContent = p.name;
      btn.lastElementChild!.textContent = p.children.length ? String(p.children.length) : "";
      btn.onclick = () => opts.onOpenPage(p.id);
      li.appendChild(btn);
      pagesEl.appendChild(li);
    }
  }

  // Parts of an instance aren't listed, so an instance stands for everything inside it.
  const rowId = (selected: string) => selected.split("/")[0];

  /** Expand the ancestors of `id`. Returns whether any of them was collapsed. */
  function reveal(id: string): boolean {
    let opened = false;
    let loc = opts.index().get(id);
    while (loc && "type" in loc.parent) {
      if (!expanded.has(loc.parent.id)) {
        expanded.add(loc.parent.id);
        opened = true;
      }
      loc = opts.index().get(loc.parent.id);
    }
    return opened;
  }

  function mark(selected: string | null) {
    selectedRow?.classList.remove("selected");
    selectedRow = selected ? (rows.get(rowId(selected)) ?? null) : null;
    selectedRow?.classList.add("selected");
    selectedRow?.scrollIntoView({ block: "nearest" });
  }

  /** Build the layer tree again. Needed when the page's nodes changed or a row opened or closed. */
  function renderLayers(selected: string | null) {
    if (selected) reveal(rowId(selected));
    rows.clear();
    selectedRow = null;
    const frag = document.createDocumentFragment();
    const row = (n: PennaNode, depth: number) => {
      const div = document.createElement("div");
      div.className = "layer";
      if (n.component) div.classList.add("component");
      if (n.type === "ref") div.classList.add("instance");
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
        renderLayers(currentSelection);
      });
      div.onclick = () => opts.onSelect(n.id);
      div.ondblclick = () => opts.onZoomTo(n.id);
      div.onmouseenter = () => opts.onHover(n.id);
      div.onmouseleave = () => opts.onHover(null);
      rows.set(n.id, div);
      frag.appendChild(div);
      if (hasKids && open) for (const c of n.children!) row(c, depth + 1);
    };
    for (const n of opts.page()?.children ?? []) row(n, 0);
    layersEl.textContent = "";
    layersEl.appendChild(frag);
    currentSelection = selected;
    mark(selected);
  }

  let currentSelection: string | null = null;

  /** Show `selected` as the selected layer, rebuilding the tree only if a parent must open. */
  function select(selected: string | null) {
    currentSelection = selected;
    if (selected && reveal(rowId(selected))) renderLayers(selected);
    else mark(selected);
  }

  return { renderPages, renderLayers, select };
}
