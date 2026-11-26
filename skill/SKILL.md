---
name: penna
description: Design UI screens on the penna canvas, an agent-first design tool whose designs live in the project's .penna/ folder. Use for any UI design work in a project that uses penna.
---

# penna

The `execute` tool runs a JavaScript snippet that reads and edits this project's penna design. Designs render as real HTML and CSS, so use normal CSS (flexbox, grid) and Tailwind v4 classes. One call can build a whole screen: use loops, helpers, and nested children.

MODEL
- Project → pages → nodes. One penna per project. Nodes placed directly on a page are screens with canvas `x`,`y`. Omit x/y to auto-place to the right.
- Node: `{type?, name?, class?, style?, children?, text?, icon?, src?, svg?, ref?, overrides?, component?, theme?, hidden?, state?, on?, x?, y?}`.
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
- `SetKeyframes(rules)`, `GetKeyframes()`, `Spring(bounce?)`, `Motion(path, opts?)`, `Filmstrip(path, opts?)`: see MOTION.
- A path is an id, a name, or `ancestor/descendant` using ids or names, e.g. `"Home/Hero/Title"`.

MOTION
- Motion is plain CSS, so it ships as written. Use a transition between states for anything a user causes (hover, press, open, select). Use keyframes for loops and for entrances that play on load.
- States: `state: "closed"` renders as `data-state="closed"`. Style each state with Tailwind: `opacity-0 transition duration-200 data-[state=open]:opacity-100`. To style children from a parent's state, put `group` on the parent and `group-data-[state=open]:…` on the child. `hover:`, `active:`, `focus:` and `group-hover:` work as usual.
- Triggers: `on: {click: {target: "Dialog", state: "open"}}`. Events are `click`, `enter`, `leave`. An action has `state` (set it; "" clears it) or `toggle` (switch between that state and the designed one), and an optional `target` (id or name of the nearest such node; omit for the node itself). Pass a list to run several actions. Triggers run in the viewer's Play mode and never change the design.
- Keyframes are project-wide: `SetKeyframes({pop: {from: {opacity: 0, scale: 0.9}, to: {opacity: 1, scale: 1}}})`. Stops are `from`, `to`, or a number for a percentage. `null` deletes a rule. Use one by name: `style: {animation: "pop 300ms ease-out both"}` or `animate-[pop_300ms_ease-out_both]`.
- Keep timing in variables so motion stays consistent: `SetVariables({fast: "150ms", spring: Spring(0.3)})`, then `duration-(--fast) ease-(--spring)`. `Spring(bounce)` returns a CSS `linear()` easing; bounce runs from 0 to 0.8, and a spring needs a longer duration (400 to 700 ms).
- `Motion(path, opts?)` reports, after the call, the value of each animated property at evenly spaced moments. It is cheap; use it to check timing and to catch motion that does not run.
- `Filmstrip(path, opts?)` does the same and returns one image with a frame per moment, cropped to the node.
- `opts` says what starts the motion: `state: "open"` for the node itself or `state: {Dialog: "open"}` for others, and `hover`, `active`, `focus`: `true` or a path. With none of these, it samples what plays on load. Other options: `from` (states to start from), `frames` (default 5, at most 12), `times: [0, 80, 200]` in ms, `duration` in ms (for loops), `scale`.
- Animate `opacity`, `translate`, `scale`, `rotate` and colors. Animating size or position properties re-lays out the page on every frame.

RULES
- Each call is atomic: on error nothing changes. Fix a failed call with `editId` and `edits` (find/replace on the failed snippet) instead of resending it.
- Calls run one at a time, and each must finish within 60 s. Values of the wrong kind (e.g. `class` as an array) fail the call.
- Name nodes you will reference later. The result lists `name=id` for every named node you created.
- Globals assigned without let/const persist between calls, e.g. `home = Insert(...)`.
- Read before editing an existing design: `Print(Tree())`.
- Give screens an explicit width (1440 desktop, 390 mobile) and let height grow.
- Verify with `Check`, and take one `Screenshot` per finished section, in the same call that builds it.
- Verify motion with `Motion`, and take one `Filmstrip` per finished interaction.

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
