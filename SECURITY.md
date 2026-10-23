# Security

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/marcoazzurrini/penna/security/advisories/new). Do not open a public issue. I aim to reply within a week.

## Security model

penna is a local development tool. Know these points before you use it:

- **`execute` snippets run with your user's permissions.** They run in a Node `vm` context, which is not a security sandbox. Give penna's MCP tool only to agents you would also trust with a shell.
- **The local server only accepts snippets from local processes that can read `.penna/.server.json`.** Each server start writes a random token there, readable only by your user. `/api/exec` requires that token. The server also rejects requests with a foreign `Host` header (DNS rebinding) and cross-site WebSocket connections, so websites you visit cannot reach it.
- **Design files are treated as untrusted.** They may come from pull requests or downloads. The viewer renders text as text and strips script, event handlers, and `javascript:` links from SVG.
- **The viewer makes network requests** for Google Fonts used by a design and for any remote image URLs in it.
