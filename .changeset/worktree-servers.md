---
"@marcoazzurrini/penna": minor
---

Every git worktree gets its own viewer, and agents no longer have to guess its URL.

- Each project folder gets a stable port derived from its path, in the range 6100–6999, instead of 6060 plus the next free port. `--port N` still overrides it.
- New `status` MCP tool returns the viewer URL, project folder, and git branch, plus the viewers of the repo's other worktrees. Every `execute` result ends with the viewer URL, and the server instructions name the session's folder and branch.
- The MCP starts the viewer when the session starts, so the first call is fast. It does this only when `.penna/` exists.
- New `penna url` prints this folder's viewer URL, starting it in the background if needed. New `penna ls` lists the viewers of every worktree.
- The viewer's title and sidebar show the repo and branch, such as `app · feat/login`, instead of the worktree's folder name.
- The `.penna/` search stops at the git root, so a worktree nested inside another checkout no longer edits that checkout's designs.
- `penna --help` prints help and exits. It used to start a server. Unknown flags now fail instead of being ignored, and `penna --version` prints the version.
- `penna init` recommends a global install and a project-scoped MCP entry, which works in every worktree and avoids the npx registry check on each start.
