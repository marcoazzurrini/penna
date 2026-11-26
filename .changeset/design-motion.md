---
"@marcoazzurrini/penna": minor
---

Design animations in the same screens as the rest of the design, as real CSS.

- **States.** A node has a `state`, rendered as `data-state`, so CSS can style each one: `opacity-0 transition data-[state=open]:opacity-100`.
- **Triggers.** A node has `on: {click: {target: "Dialog", state: "open"}}`, with `click`, `enter`, and `leave` events and `state` or `toggle` actions. Triggers run in the viewer's new Play mode (P) and never change the design files. Inside a component, a trigger changes its own instance.
- **Keyframes.** `SetKeyframes()` and `GetKeyframes()` keep project-wide `@keyframes` in `project.json`, next to variables and themes. `Spring(bounce)` returns a spring as a CSS `linear()` easing.
- **Filmstrips.** An agent could not see motion: screenshots only showed the end state. `Filmstrip(path, opts)` returns one image with a frame per moment, and `Motion(path, opts)` reports the computed value of each animated property at those moments. Both can start from a state change, hover, press, or focus, and both say so when nothing animates. Animations are paused and moved to exact times, so the same design always gives the same frames.
- `Check`, `Layout`, and `Screenshot` now measure the design at rest. Before, a node with an entrance animation was measured at the start of that animation.
