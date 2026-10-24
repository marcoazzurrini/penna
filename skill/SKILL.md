---
name: penna
description: Design UI screens on the penna canvas, an agent-first design tool whose designs live in the project's .penna/ folder. Use for any UI design work in a project that uses penna.
---

# penna

The `execute` tool runs a JavaScript snippet that reads and edits this project's penna design. Designs render as real HTML and CSS, so use normal CSS (flexbox, grid) and Tailwind v4 classes. One call can build a whole screen: use loops, helpers, and nested children.

MODEL
- Project → pages → nodes. One penna per project. Nodes placed directly on a page are screens with canvas `x`,`y`. Omit x/y to auto-place to the right.
- Node: `{type?, name?, class?, style?, children?, text?, icon?, src?, svg?, ref?, overrides?, component?, theme?, hidden?, x?, y?}`.
- Type is inferred: `text` or `spans` → text, `icon` → icon (Lucide name, kebab-case), `src` → image, `svg` → raw SVG markup, `ref` → component instance, otherwise frame. Strings inside `children` become text nodes.
- `style` is CSS with camelCase keys. Numbers become px, except unitless properties (fontWeight, lineHeight, opacity, flex, zIndex). `class` takes Tailwind classes. Use either or both.
- Mixed styles in one text: `{spans: [{text: "const ", style: {color: "#c79bff"}}, {text: "x = 1"}]}`.
- It is real HTML: frames are divs (display:block unless you set flex/grid), text is a div with pre-wrap, images are <img> with object-fit:cover, icons are 24px and use currentColor. CSS inherits (color, font) as usual. box-sizing is border-box.
- Default font is Inter. Any Google Font loads automatically when used in fontFamily.
- Variables are CSS custom properties: `SetVariables({accent:"#ff5a36"})`, then `var(--accent)` or Tailwind `bg-(--accent)`. Themes: `SetVariables({bg:"#111"}, "dark")` and `theme:"dark"` on a node.
- Components: set `component:true` on a node. Instance: `{ref: compId, style?, overrides: {Title: {text: "Hi"}}}`. `ref` takes an id or a component name. Override keys are descendant names or ids. `Update(instId + "/Title", {...})` also writes an override.
- A component on any page can be used on every page. Keep the design system on its own page (e.g. "Foundations") and build screens on other pages from it. Variables and themes are project-wide.

API (globals)
- `page`: current page id. `Page(name)`: switch to or create a page, returns its id. `DeletePage(idOrName)`.
- `Insert(parent, node | node[], index?)` → id or ids. parent is a page id or a node path.
- `Update(path, patch)`: style merges (null deletes a key); other props replace.
- `Replace(path, node)` → id. `Delete(path)`. `Move(path, parent?, index?)`. `Copy(path, parent?, patch?)` → id.
- `Get(path, depth?)` → node JSON. `Find(fn, root?)` → matching nodes. `Tree(path?, depth=4)` → compact outline string.
- `State()` → pages, current page, selection. `Selection()` → ids the user clicked in the viewer.
- `SetVariables(vars, theme?)`, `GetVariables()`.
- `Components()` → `[{id, name, page}]` for every component in the project.
- `Icons("words", limit?)` → Lucide icon names, best match first, e.g. `Icons("close")`. Use it when unsure of a name.
- `Screenshot(path | path[], {scale}?)`: images are returned after the call. A page id captures the whole page.
- `Check(path)`: after the call, reports layout problems (text overflowing its box, clipped, sticking-out, or zero-size nodes). Much cheaper than a screenshot.
- `await Layout(path)` → `{width, height, nodes: [[id, name, x, y, w, h]], problems}` for logic inside the snippet.
- `Print(...values)`: adds lines to the result.
- A path is an id, a name, or `ancestor/descendant` using ids or names, e.g. `"Home/Hero/Title"`.

RULES
- Each call is atomic: on error nothing changes. Fix a failed call with `editId` and `edits` (find/replace on the failed snippet) instead of resending it.
- Name nodes you will reference later. The result lists `name=id` for every named node you created.
- Globals assigned without let/const persist between calls, e.g. `home = Insert(...)`.
- Read before editing an existing design: `Print(Tree())`.
- Give screens an explicit width (1440 desktop, 390 mobile) and let height grow.
- Verify with `Check`, and take one `Screenshot` per finished section, in the same call that builds it.

EXAMPLE
```js
SetVariables({ink: "#14141a", accent: "#ff5a36"})
home = Insert(page, {name: "Home", style: {width: 1440, background: "#fff", color: "var(--ink)"}, children: [
  {name: "Nav", class: "flex items-center justify-between px-16 py-6", children: [
    {text: "Acme", class: "text-xl font-bold"},
    {class: "flex gap-8 text-sm", children: ["Product", "Pricing", "Docs"]},
  ]},
  {name: "Hero", class: "flex flex-col gap-6 px-16 py-24", children: [
    {name: "Title", text: "Design at the speed of thought", class: "text-6xl font-semibold tracking-tight max-w-3xl"},
    {name: "CTA", class: "flex items-center gap-2 self-start rounded-full px-5 py-3 text-white", style: {background: "var(--accent)"},
      children: ["Get started", {icon: "arrow-right", style: {width: 16, height: 16}}]},
  ]},
]})
Check(home)
Screenshot(home)
```
