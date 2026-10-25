---
"@marcoazzurrini/penna": patch
---

The viewer is much faster on large projects.

- Tailwind CSS is now compiled on the server with the `tailwindcss` compiler, instead of in the browser with `@tailwindcss/browser`. The viewer inserts only the CSS rules that are new, so adding a class no longer restyles every element.
- After a change, the server sends only the top-level frames that changed, with a hash for each, instead of the whole document. The viewer compares hashes instead of serializing every frame, and only moves frames in the DOM when their order changed.
- `npm run bench` measures load and edit times on a generated 20,000-node project.
