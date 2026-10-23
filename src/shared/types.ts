// The on-disk document format. Everything is plain JSON so files diff well in git.

export type NodeType = "frame" | "text" | "image" | "icon" | "svg" | "ref";

export type StyleValue = string | number;
export type Style = Record<string, StyleValue>;

export interface TextSpan {
  text: string;
  style?: Style;
  class?: string;
}

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
  /** ref: id of the component node this instance renders. */
  ref?: string;
  /** ref: per-descendant patches, keyed by descendant id or name. */
  overrides?: Record<string, NodePatch>;
  /** Marks a node as a reusable component. */
  component?: boolean;
  /** Applies a named theme's variables to this subtree. */
  theme?: string;
  hidden?: boolean;
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

export interface PennaDoc {
  version: 1;
  /** CSS custom properties, without the leading `--`. */
  variables?: Record<string, string>;
  /** Named variable sets that override `variables` inside nodes with a matching `theme`. */
  themes?: Record<string, Record<string, string>>;
  pages: PennaPage[];
}

export function emptyDoc(): PennaDoc {
  return { version: 1, variables: {}, pages: [{ id: "page1", name: "Page 1", children: [] }] };
}
