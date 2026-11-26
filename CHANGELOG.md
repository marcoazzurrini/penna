# @marcoazzurrini/penna

## 0.4.0

### Minor Changes

- dfc923f: Design animations in the same screens as the rest of the design, as real CSS.
  
  - **States.** A node has a `state`, rendered as `data-state`, so CSS can style each one: `opacity-0 transition data-[state=open]:opacity-100`.
  - **Triggers.** A node has `on: {click: {target: "Dialog", state: "open"}}`, with `click`, `enter`, and `leave` events and `state` or `toggle` actions. Triggers run in the viewer's new Play mode (P) and never change the design files. Inside a component, a trigger changes its own instance.
  - **Keyframes.** `SetKeyframes()` and `GetKeyframes()` keep project-wide `@keyframes` in `project.json`, next to variables and themes. `Spring(bounce)` returns a spring as a CSS `linear()` easing.
  - **Filmstrips.** An agent could not see motion: screenshots only showed the end state. `Filmstrip(path, opts)` returns one image with a frame per moment, and `Motion(path, opts)` reports the computed value of each animated property at those moments. Both can start from a state change, hover, press, or focus, and both say so when nothing animates. Animations are paused and moved to exact times, so the same design always gives the same frames.
  - `Check`, `Layout`, and `Screenshot` now measure the design at rest. Before, a node with an entrance animation was measured at the start of that animation.

## 0.3.0

### Minor Changes

- 94d5a0d: Designs survive broken files and overlapping calls, and large projects are much faster to edit.
  
  Fixes:
  
  - A page file that is not valid JSON, such as one with git conflict markers, was skipped on load and then deleted by the next change. Broken files are now never overwritten or deleted. The viewer shows a notice, and every `execute` result names the file and what is wrong with it. A broken `project.json` blocks changes instead of losing variables and themes.
  - A value of the wrong kind, such as `class` given as an array, was saved and then stopped the server from starting. Agent input and files read from disk are now checked against one schema. Bad input fails the call; bad files are reported.
  - Two `execute` calls that overlapped could lose one call's edits. Calls now run one at a time, in order.
  - `await Layout()` inside a snippet measured without the Tailwind classes added by that same snippet.
  - A snippet that waited on a promise that never settled blocked forever. A call now fails after 60 s. An endless loop after an `await` still cannot be stopped.
  - Two sessions that started at the same moment each started a server for the same project. The second now uses the first.
  - After one offline moment the browser cached an empty font stylesheet for an hour. Requests to Google Fonts now time out after 5 s.
  - A render that hung blocked every later screenshot and layout check. It is now stopped after 30 s and Chrome restarts.
  - A change made outside penna left a stale redo step that could overwrite it.
  - SVG nodes could carry a `<style>` element that restyled the viewer.
  - Keyboard shortcuts did nothing while the "Follow agent" checkbox had focus.
  
  Performance, measured on a 3.5 MB project with 20 pages:
  
  - A call copies, saves, and re-reads only the pages it changes. A one-node update went from 34 ms to 4 ms, and a read-only call from 15 ms to 0.1 ms.
  - Lookups by id and by name use indexes that are kept up to date. 300 updates by name in one call went from 726 ms to 6 ms.
  - Screenshots and layout checks send Chrome only the screen being rendered and the components it uses, and the stylesheet only when it changed. A layout check went from 677 ms to 33 ms.
  - The viewer updates its node index and font list for changed screens only, and leaves the layer tree alone when the open page did not change.
- 228d83d: Every git worktree gets its own viewer, and agents no longer have to guess its URL.
  
  - Each project folder gets a stable port derived from its path, in the range 6100–6999, instead of 6060 plus the next free port. `--port N` still overrides it.
  - New `status` MCP tool returns the viewer URL, project folder, and git branch, plus the viewers of the repo's other worktrees. Every `execute` result ends with the viewer URL, and the server instructions name the session's folder and branch.
  - The MCP starts the viewer when the session starts, so the first call is fast. It does this only when `.penna/` exists.
  - New `penna url` prints this folder's viewer URL, starting it in the background if needed. New `penna ls` lists the viewers of every worktree.
  - The viewer's title and sidebar show the repo and branch, such as `app · feat/login`, instead of the worktree's folder name.
  - The `.penna/` search stops at the git root, so a worktree nested inside another checkout no longer edits that checkout's designs.
  - `penna --help` prints help and exits. It used to start a server. Unknown flags now fail instead of being ignored, and `penna --version` prints the version.
  - `penna init` recommends a global install and a project-scoped MCP entry, which works in every worktree and avoids the npx registry check on each start.

## 0.2.1

### Patch Changes

- 13687db: The viewer is much faster on large projects.
  
  - Tailwind CSS is now compiled on the server with the `tailwindcss` compiler, instead of in the browser with `@tailwindcss/browser`. The viewer inserts only the CSS rules that are new, so adding a class no longer restyles every element.
  - After a change, the server sends only the top-level frames that changed, with a hash for each, instead of the whole document. The viewer compares hashes instead of serializing every frame, and only moves frames in the DOM when their order changed.
  - `npm run bench` measures load and edit times on a generated 20,000-node project.

## 0.2.0

### Minor Changes

- 1156824: One project, many pages. Plus icon search and an on-demand agent skill.
  
  - A penna project is now pages only. Each page is its own file in `.penna/pages/`, and `.penna/project.json` holds variables, themes, and page order. Edits rewrite only the pages they touch.
  - The viewer no longer shows a file menu. It shows the project name and its pages.
  - penna 0.1 designs migrate automatically on first run. The old files move to `.penna/.v1-backup/`.
  - The `execute` tool and `penna exec` no longer take a file. Components on any page can be used on every page, and `ref` accepts a component name as well as an id.
  - New `Components()` lists every component in the project.
  - New `Icons("words")` searches Lucide icons by name and tag, including old names such as "home". Unknown icon warnings now suggest close matches.
  - The agent guide is now an Agent Skill (`skill/SKILL.md`) that loads on demand. `execute` has a short description, a new `read_skill` MCP tool returns the skill, and server instructions tell agents when to use penna. `penna guide` is now `penna skill`.
  - The viewer has a new logo, a polished sidebar with Lucide layer icons and page screen counts, and a theme switch (System, Light, Dark) at the bottom of the sidebar.
