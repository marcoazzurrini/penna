import type { PennaNode } from "./types.ts";

// Messages from the server to the viewer.

/**
 * The document, sent whole when a viewer connects and as a diff after each change.
 * Pages list the ids of their top-level nodes; the nodes themselves are sent only when
 * the viewer does not have them yet or they changed.
 */
export interface DocMessage {
  t: "doc";
  project: string;
  rev: number;
  /** `nodes` holds every top-level node, so the viewer should drop the ones it has. */
  full: boolean;
  /** Page to show, when following the agent. */
  focus?: string;
  variables: Record<string, string>;
  themes?: Record<string, Record<string, string>>;
  pages: { id: string; name: string; nodes: string[] }[];
  nodes: { page: string; hash: string; node: PennaNode }[];
  /** The compiled Tailwind stylesheet. Only sent when it changed. */
  css?: string;
}

/** Key for a top-level node. Ids are unique per page; page ids cannot contain spaces. */
export function frameKey(page: string, id: string): string {
  return page + " " + id;
}
