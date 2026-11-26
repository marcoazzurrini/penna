import type { NodeType } from "./types.ts";

// The one definition of what a valid design is. Agent input and files read from disk
// both pass through these checks, so nothing malformed reaches the renderer.

export const NODE_TYPES: ReadonlySet<string> = new Set<NodeType>(["frame", "text", "image", "icon", "svg", "ref"]);

export const NODE_KEYS: ReadonlySet<string> = new Set([
  "type", "name", "x", "y", "class", "style", "text", "spans", "src", "icon", "svg", "ref",
  "overrides", "component", "theme", "hidden", "state", "on", "children",
]);

export const TRIGGER_EVENTS: ReadonlySet<string> = new Set(["click", "enter", "leave"]);
const ACTION_KEYS = new Set(["target", "state", "toggle"]);

/** A keyframes name must be safe to write into a stylesheet as it is. */
export const KEYFRAMES_NAME = /^[A-Za-z_][\w-]*$/;
const STOP = "(?:from|to|\\d+(?:\\.\\d+)?%)";
export const KEYFRAME_STOP = new RegExp(`^${STOP}(?:\\s*,\\s*${STOP})*$`);

const STRINGS = new Set(["name", "class", "text", "src", "icon", "svg", "ref", "theme", "state"]);
const NUMBERS = new Set(["x", "y"]);
const BOOLEANS = new Set(["component", "hidden"]);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A short, printable form of a value for error messages. */
export function show(v: unknown): string {
  let s: string | undefined;
  try {
    s = JSON.stringify(v);
  } catch {}
  return (s ?? String(v)).slice(0, 60);
}

/** What is wrong with one CSS value, or null. Patches may use null to delete a key. */
export function styleValueProblem(v: unknown, patch = false): string | null {
  if (v === null && patch) return null;
  if (typeof v === "string") return null;
  if (typeof v === "number") return Number.isFinite(v) ? null : `is ${v}`;
  return `must be a string or number, got ${show(v)}`;
}

function styleProblem(v: unknown, patch: boolean): string | null {
  if (!isObject(v)) return `style must be an object of CSS properties, got ${show(v)}`;
  for (const k in v) {
    const p = styleValueProblem(v[k], patch);
    if (p) return `style.${k} ${p}`;
  }
  return null;
}

/**
 * What is wrong with the value of one node property, or null when it is fine. Unknown
 * properties pass, so files written by a newer penna still load. With `patch`, null is
 * allowed anywhere, because a patch uses null to delete. `children` is only checked to
 * be an array; callers check the nodes inside.
 */
export function propProblem(key: string, v: unknown, patch = false): string | null {
  if (v === null && patch) return null;
  if (key === "id") return typeof v === "string" && v ? null : `id must be a non-empty string, got ${show(v)}`;
  if (key === "type") return typeof v === "string" && NODE_TYPES.has(v) ? null : `unknown node type ${show(v)}; use frame, text, image, icon, svg, or ref`;
  if (STRINGS.has(key)) return typeof v === "string" ? null : `${key} must be a string, got ${show(v)}`;
  if (NUMBERS.has(key)) return typeof v === "number" && Number.isFinite(v) ? null : `${key} must be a number, got ${show(v)}`;
  if (BOOLEANS.has(key)) return typeof v === "boolean" ? null : `${key} must be true or false, got ${show(v)}`;
  if (key === "style") return styleProblem(v, patch);
  if (key === "children") return Array.isArray(v) ? null : `children must be an array, got ${show(v)}`;
  if (key === "spans") {
    if (!Array.isArray(v)) return `spans must be an array of {text, style?, class?}, got ${show(v)}`;
    for (const s of v) {
      if (!isObject(s) || typeof s.text !== "string") return `each span needs a text string, got ${show(s)}`;
      if (s.class !== undefined && typeof s.class !== "string") return `a span's class must be a string, got ${show(s.class)}`;
      if (s.style !== undefined) {
        const p = styleProblem(s.style, false);
        if (p) return "span " + p;
      }
    }
    return null;
  }
  if (key === "on") return triggersProblem(v);
  if (key === "overrides") {
    if (!isObject(v)) return `overrides must be an object of patches, got ${show(v)}`;
    for (const name in v) {
      const patchValue = v[name];
      if (!isObject(patchValue)) return `override "${name}" must be a patch object, got ${show(patchValue)}`;
      for (const k in patchValue) {
        const p = k === "children" ? childrenProblem(patchValue[k], new Set()) : propProblem(k, patchValue[k], true);
        if (p) return `override "${name}": ${p}`;
      }
    }
    return null;
  }
  return null;
}

/** What is wrong with one action of a trigger, or null. */
export function actionProblem(a: unknown): string | null {
  if (!isObject(a)) return `an action must be an object like {target, state}, got ${show(a)}`;
  for (const k in a) {
    if (!ACTION_KEYS.has(k)) return `unknown action property "${k}"; use target, state, or toggle`;
    if (typeof a[k] !== "string") return `an action's ${k} must be a string, got ${show(a[k])}`;
  }
  if ((a.state === undefined) === (a.toggle === undefined)) return `an action needs either state or toggle, got ${show(a)}`;
  if (a.toggle === "") return "an action's toggle must name a state";
  return null;
}

function triggersProblem(v: unknown): string | null {
  if (!isObject(v)) return `on must be an object like {click: {target, state}}, got ${show(v)}`;
  for (const event in v) {
    if (!TRIGGER_EVENTS.has(event)) return `unknown trigger "${event}"; use click, enter, or leave`;
    const actions = v[event];
    if (!Array.isArray(actions)) return `on.${event} must be an array of actions, got ${show(actions)}`;
    for (const a of actions) {
      const p = actionProblem(a);
      if (p) return `on.${event}: ${p}`;
    }
  }
  return null;
}

/** The first problem in a set of keyframes rules, or null. */
export function keyframesProblem(v: unknown): string | null {
  if (!isObject(v)) return `keyframes must be an object, got ${show(v)}`;
  for (const name in v) {
    if (!KEYFRAMES_NAME.test(name)) return `keyframes name ${show(name)} must be letters, digits, - and _, starting with a letter`;
    const stops = v[name];
    if (!isObject(stops)) return `keyframes.${name} must be an object of stops, got ${show(stops)}`;
    for (const stop in stops) {
      if (!KEYFRAME_STOP.test(stop)) return `keyframes.${name} has a bad stop ${show(stop)}; use from, to, or a percentage`;
      const p = styleProblem(stops[stop], false);
      if (p) return `keyframes.${name}["${stop}"]: ${p}`;
    }
  }
  return null;
}

function childrenProblem(v: unknown, ids: Set<string>): string | null {
  if (v === null) return null;
  if (!Array.isArray(v)) return `children must be an array, got ${show(v)}`;
  for (const c of v) {
    const p = nodeProblem(c, ids);
    if (p) return p;
  }
  return null;
}

/**
 * The first problem in a stored node or its descendants, or null. `ids` collects every
 * id seen, to catch duplicates.
 */
export function nodeProblem(v: unknown, ids: Set<string>): string | null {
  if (!isObject(v)) return `expected a node object, got ${show(v)}`;
  const label = `node ${typeof v.id === "string" ? v.id : show(v.id)}`;
  for (const key of ["id", "type"]) {
    const p = propProblem(key, v[key]);
    if (p) return `${label}: ${p}`;
  }
  const id = v.id as string;
  if (ids.has(id)) return `${label}: the id is used twice`;
  ids.add(id);
  for (const key in v) {
    if (key === "id" || key === "type" || v[key] === undefined) continue;
    const p = key === "children" ? childrenProblem(v[key], ids) : propProblem(key, v[key]);
    // Problems found deeper already name their own node.
    if (p) return key === "children" && Array.isArray(v[key]) ? p : `${label}: ${p}`;
  }
  return null;
}

function variablesProblem(v: unknown, what: string): string | null {
  if (!isObject(v)) return `${what} must be an object, got ${show(v)}`;
  for (const k in v) if (typeof v[k] !== "string") return `${what}.${k} must be a string, got ${show(v[k])}`;
  return null;
}

/** The first problem in the parsed contents of `pages/<id>.json`, or null. */
export function pageFileProblem(v: unknown): string | null {
  if (!isObject(v)) return `expected an object, got ${show(v)}`;
  if (v.name !== undefined && typeof v.name !== "string") return `name must be a string, got ${show(v.name)}`;
  if (v.children === undefined) return null;
  return childrenProblem(v.children, new Set());
}

/** The first problem in the parsed contents of `project.json`, or null. */
export function projectFileProblem(v: unknown): string | null {
  if (!isObject(v)) return `expected an object, got ${show(v)}`;
  if (v.pages !== undefined && !(Array.isArray(v.pages) && v.pages.every((p) => typeof p === "string"))) {
    return `pages must be an array of page ids, got ${show(v.pages)}`;
  }
  if (v.variables !== undefined) {
    const p = variablesProblem(v.variables, "variables");
    if (p) return p;
  }
  if (v.keyframes !== undefined) {
    const p = keyframesProblem(v.keyframes);
    if (p) return p;
  }
  if (v.themes !== undefined) {
    if (!isObject(v.themes)) return `themes must be an object, got ${show(v.themes)}`;
    for (const t in v.themes) {
      const p = variablesProblem(v.themes[t], `themes.${t}`);
      if (p) return p;
    }
  }
  return null;
}
