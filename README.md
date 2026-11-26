<img src="src/client/favicon.svg" width="56" height="56" alt="">

# penna

An agent-first design canvas that lives in your repo, like Storybook does.

- Designs live in `.penna/` at your project root, one JSON file per page, so they diff and merge in git.
- Agents edit them through one tool, `execute`, that runs a JavaScript snippet. One call can build a whole screen.
- Designs render as real HTML and CSS (flexbox, grid, Tailwind v4, Google Fonts, Lucide icons), so agents use what they already know.
- A component on any page can be used on every page, so a design-system page feeds all your screens.
- Motion is designed in the same screens, as real CSS: states, transitions, and keyframes. Agents see it as a filmstrip, and you play it in the viewer.
- `penna` opens a light, view-only canvas on localhost: pan, zoom, pages, layers, and live updates while the agent works.

## Quick start

Requires Node 22.18 or later. Screenshots use your installed Google Chrome.

```sh
npm i -g @marcoazzurrini/penna                        # installs the penna command
cd your-project
penna init                                            # creates .penna/
claude mcp add --scope project penna -- penna mcp     # gives Claude Code the tools; commit .mcp.json
penna --open                                          # opens the viewer
```

A global install starts in a fraction of a second. `npx -y @marcoazzurrini/penna mcp` also works, but npx checks the registry each time it starts.

Other MCP clients: run `penna mcp` from the project folder over stdio. Agents without MCP can use the CLI: `penna exec 'Print(Tree())'`.

## Worktrees and ports

Every folder with its own `.penna/`, such as each git worktree of a repo, gets its own server and viewer.

- The port comes from the folder path, in the range 6100–6999, so a worktree keeps the same URL across restarts. `--port N` overrides it.
- `penna url` prints this folder's URL and starts the viewer in the background if needed. `penna ls` lists the viewers of every worktree.
- The viewer's title shows the repo and branch, such as `penna · app · feat/login`.
- Agents call the `status` MCP tool for the URL, and every `execute` result ends with it. The MCP starts the viewer when the session starts, so the first call is fast.
- The `.penna/` search stops at the git root, so a worktree nested inside another checkout never edits that checkout's designs.
- A second session in the same folder reuses the running server, found through `.penna/.server.json`.

## Viewer

- Drag or scroll to pan. Pinch, or Cmd/Ctrl + scroll, to zoom.
- Click to select a node. The agent can read it with `Selection()`. Esc selects the parent.
- Shift+1 fits everything. Shift+2 zooms to the selection.
- Cmd/Ctrl+Z undoes the agent's last change. Shift+Cmd/Ctrl+Z redoes it.
- "Follow agent" jumps to the page the agent is editing.
- Play (P) makes the design interactive: a click runs the node's triggers instead of selecting it. R replays. Esc, or Play again, puts everything back.

## Motion

Animations live in the screens they belong to, and they are plain CSS, so what you review is what ships.

- A node has a `state`, such as `closed`. CSS styles each state (`data-[state=open]:opacity-100`), and a `transition` animates the change.
- A node has triggers, such as `on: {click: {target: "Dialog", state: "open"}}`. They run in Play mode and never change the design files.
- Keyframes for loops and entrances are project-wide, like variables. Durations and easings are variables too, and `Spring()` gives a spring as a CSS `linear()` easing.
- An agent cannot watch an animation, so `Filmstrip` shows it one: the browser pauses every animation and moves each to an exact moment, then returns the frames side by side with the computed values. The same design always gives the same frames.

## Agent API

See [skill/SKILL.md](skill/SKILL.md), an [Agent Skill](https://agentskills.io). Agents read it through the `read_skill` MCP tool, or with `penna skill`.

## How it works

- `penna dev` runs a small Node server, one per project folder. It owns the documents, writes `.penna/*.json`, and pushes changes to the viewer over a WebSocket.
- `execute` snippets run against a copy of the document. A failed call changes nothing and can be fixed with small find/replace edits instead of resending it.
- Calls run one at a time, and a call copies only the pages it changes, so its cost follows the size of the edit, not of the project.
- A file that is not a valid design, such as one with git conflict markers, is never overwritten or deleted. The viewer and every `execute` result say what is wrong with it until it is fixed.
- Filmstrips draw the screen once per frame, then pause and seek each copy's animations through the Web Animations API. Hover, press and focus are forced through the DevTools protocol.
- Screenshots and layout checks use a headless Chrome (via `playwright-core`) that runs the same renderer as the viewer.
- The viewer moves the whole canvas with one CSS transform, skips off-screen screens with `content-visibility`, and only re-renders screens whose JSON changed.

## Security

Snippets run with your user's permissions, so only connect agents you would trust with a shell. The local server is protected against websites and DNS rebinding. See [SECURITY.md](SECURITY.md).

## Development

```sh
npm install
npm run build        # client bundle and CLI
npm test             # node:test suite
npm run dev          # run the CLI from source (node src/cli.ts dev)
npm link             # use your local build as `penna` everywhere
```

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets) and npm trusted publishing.

1. Add a changeset to each pull request: `npx changeset`.
2. When it merges, the Release workflow opens a "chore: version packages" pull request with the version bump and `CHANGELOG.md`.
3. Merging that pull request publishes to npm with provenance.

## License

[MIT](LICENSE)
