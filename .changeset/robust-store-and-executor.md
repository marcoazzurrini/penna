---
"@marcoazzurrini/penna": minor
---

Designs survive broken files and overlapping calls, and large projects are much faster to edit.

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
