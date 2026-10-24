---
"@marcoazzurrini/penna": minor
---

One project, many pages. Plus icon search and an on-demand agent skill.

- A penna project is now pages only. Each page is its own file in `.penna/pages/`, and `.penna/project.json` holds variables, themes, and page order. Edits rewrite only the pages they touch.
- The viewer no longer shows a file menu. It shows the project name and its pages.
- penna 0.1 designs migrate automatically on first run. The old files move to `.penna/.v1-backup/`.
- The `execute` tool and `penna exec` no longer take a file. Components on any page can be used on every page, and `ref` accepts a component name as well as an id.
- New `Components()` lists every component in the project.
- New `Icons("words")` searches Lucide icons by name and tag, including old names such as "home". Unknown icon warnings now suggest close matches.
- The agent guide is now an Agent Skill (`skill/SKILL.md`) that loads on demand. `execute` has a short description, a new `read_skill` MCP tool returns the skill, and server instructions tell agents when to use penna. `penna guide` is now `penna skill`.
