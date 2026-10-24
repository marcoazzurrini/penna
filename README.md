# penna

An agent-first design canvas that lives in your repo, like Storybook does.

- Designs live in `.penna/` at your project root, one JSON file per page, so they diff and merge in git.
- Agents edit them through one tool, `execute`, that runs a JavaScript snippet. One call can build a whole screen.
- Designs render as real HTML and CSS (flexbox, grid, Tailwind v4, Google Fonts, Lucide icons), so agents use what they already know.
- A component on any page can be used on every page, so a design-system page feeds all your screens.
- `penna` opens a light, view-only canvas on localhost: pan, zoom, pages, layers, and live updates while the agent works.

## Quick start

Requires Node 22.18 or later. Screenshots use your installed Google Chrome.

```sh
cd your-project
npx @marcoazzurrini/penna init                                   # creates .penna/
claude mcp add penna -- npx -y @marcoazzurrini/penna mcp         # gives Claude Code the execute tool
npx @marcoazzurrini/penna                                        # opens the viewer at http://localhost:6060
```

Install it globally if you prefer a short command: `npm i -g @marcoazzurrini/penna`, then run `penna`.

Other MCP clients: run `npx -y @marcoazzurrini/penna mcp` from the project folder over stdio. Agents without MCP can use the CLI: `penna exec -f design 'Print(Tree())'`.

## Viewer

- Drag or scroll to pan. Pinch, or Cmd/Ctrl + scroll, to zoom.
- Click to select a node. The agent can read it with `Selection()`. Esc selects the parent.
- Shift+1 fits everything. Shift+2 zooms to the selection.
- Cmd/Ctrl+Z undoes the agent's last change. Shift+Cmd/Ctrl+Z redoes it.
- "Follow agent" jumps to the page the agent is editing.

## Agent API

See [skill/SKILL.md](skill/SKILL.md), an [Agent Skill](https://agentskills.io). Agents read it through the `read_skill` MCP tool, or with `penna skill`.

## How it works

- `penna dev` runs a small Node server. It owns the documents, writes `.penna/*.json`, and pushes changes to the viewer over a WebSocket.
- `execute` snippets run against a copy of the document. A failed call changes nothing and can be fixed with small find/replace edits instead of resending it.
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
