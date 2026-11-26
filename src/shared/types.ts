// The design format. Everything is plain JSON so files diff well in git.

export type NodeType = "frame" | "text" | "image" | "icon" | "svg" | "ref";

export type StyleValue = string | number;
export type Style = Record<string, StyleValue>;

export interface TextSpan {
  text: string;
  style?: Style;
  class?: string;
}

/** What a trigger does: set or toggle the `state` of a node. */
export interface Action {
  /** Id or name of the node to change. Omit to change the node that has the trigger. */
  target?: string;
  /** Set the target's state to this. An empty string clears it. */
  state?: string;
  /** Switch the target between this state and the state stored in the design. */
  toggle?: string;
}

export type TriggerEvent = "click" | "enter" | "leave";

/** Actions to run in the viewer's play mode, by event. */
export type Triggers = Partial<Record<TriggerEvent, Action[]>>;

/** `@keyframes` rules by name. Each maps a stop ("from", "to", "50%") to CSS, camelCase keys. */
export type Keyframes = Record<string, Record<string, Style>>;

export interface PennaNode {
  id: string;
  type: NodeType;
  name?: string;
  /** Canvas position. Only used on nodes placed directly on a page. */
  x?: number;
  y?: number;
  /** Tailwind classes. */
  class?: string;
  /** Inline CSS, camelCase keys. Numbers become px where CSS expects a length. */
  style?: Style;
  /** text: the text content. */
  text?: string;
  /** text: inline runs with their own styles, used instead of `text`. */
  spans?: TextSpan[];
  /** image: URL, or a path relative to the .penna folder. */
  src?: string;
  /** icon: a Lucide icon name, e.g. "house". */
  icon?: string;
  /** svg: raw SVG markup. */
  svg?: string;
  /** ref: id of the component node this instance renders. It may live on any page. */
  ref?: string;
  /** ref: per-descendant patches, keyed by descendant id or name. */
  overrides?: Record<string, NodePatch>;
  /** Marks a node as a reusable component. */
  component?: boolean;
  /** Applies a named theme's variables to this subtree. */
  theme?: string;
  hidden?: boolean;
  /** A named state, rendered as `data-state`, for CSS to style: `data-[state=open]:opacity-100`. */
  state?: string;
  /** Triggers that change states in the viewer's play mode. */
  on?: Triggers;
  children?: PennaNode[];
}

/** A partial node used for updates and overrides. `null` style values delete keys. */
export type NodePatch = Partial<Omit<PennaNode, "style" | "children">> & {
  style?: Record<string, StyleValue | null>;
  children?: PennaNode[];
};

export interface PennaPage {
  id: string;
  name: string;
  children: PennaNode[];
}

/** The whole project as agents and the viewer see it. */
export interface PennaDoc {
  version: 2;
  /** CSS custom properties, without the leading `--`. */
  variables?: Record<string, string>;
  /** Named variable sets that override `variables` inside nodes with a matching `theme`. */
  themes?: Record<string, Record<string, string>>;
  /** Project-wide `@keyframes`, used by name in `animation`. */
  keyframes?: Keyframes;
  pages: PennaPage[];
}

/** `.penna/project.json`: variables, themes, and page order. */
export interface ProjectFile {
  version: 2;
  /** Page ids in display order. Page files missing here are shown after these. */
  pages: string[];
  variables?: Record<string, string>;
  themes?: Record<string, Record<string, string>>;
  keyframes?: Keyframes;
}

/** `.penna/pages/<id>.json`: one page. The file name is the page id. */
export interface PageFile {
  version: 2;
  name: string;
  children: PennaNode[];
}

export function emptyDoc(): PennaDoc {
  return { version: 2, variables: {}, pages: [{ id: "page-1", name: "Page 1", children: [] }] };
}
