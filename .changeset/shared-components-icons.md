---
"@marcoazzurrini/penna": minor
---

Share components across files and search icons.

- Instances can use a component from another file in `.penna/` with `ref: "file#Name"`. The library's variables and themes come with it, and the viewer updates every file that uses it when the library changes.
- `ref` also accepts a component name, not only an id.
- New `Components(file?)` lists components with the ref to use.
- New `Icons("words")` searches Lucide icons by name and tag, including old names such as "home". Unknown icon warnings now suggest close matches.
- The agent guide is now an Agent Skill (`skill/SKILL.md`) that loads on demand. `execute` has a short description, a new `read_skill` MCP tool returns the skill, and server instructions tell agents when to use penna. `penna guide` is now `penna skill`. This saves about 1,000 tokens in every session.
