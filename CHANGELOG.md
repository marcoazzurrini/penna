# @marcoazzurrini/penna

## 0.3.0

### Minor Changes

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
