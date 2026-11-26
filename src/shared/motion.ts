// Sampling motion: what the server asks the headless page for, and what comes back.

/** Pseudo-classes a film can force on a node, as an agent names them. */
export const PSEUDO: Record<string, string[]> = {
  hover: ["hover"],
  active: ["hover", "active"],
  focus: ["focus", "focus-visible"],
};

export const MAX_FRAMES = 12;

export interface FilmRequest {
  /** The top-level node to render. Motion needs the real ancestors, so the whole screen is drawn. */
  top: string;
  /** DOM id of the node to watch: frames are cropped to it and its animations are reported. */
  target: string;
  /** How many moments to sample, evenly spread over the motion. Ignored when `times` is set. */
  frames: number;
  /** Exact moments to sample, in ms after the change. */
  times?: number[];
  /** Sample up to this many ms, for motion that loops or runs long. */
  duration?: number;
  /** States to start from, by DOM id. `null` removes the state. */
  from: Record<string, string | null>;
  /** States to change to, by DOM id. The change is what starts the transitions. */
  to: Record<string, string | null>;
  /** Pseudo-classes to force, by DOM id. Forcing them also starts transitions. */
  pseudo: Record<string, string[]>;
  scale?: number;
}

/** One animated property of one element, with its computed value at each sampled moment. */
export interface FilmTrack {
  id: string;
  name: string;
  property: string;
  values: string[];
}

export interface FilmReport {
  /** The sampled moments, in ms. */
  times: number[];
  /** When the last animation ends, in ms. Loops count once. */
  duration: number;
  tracks: FilmTrack[];
  /** Animations that changed nothing visible, or were left out to keep the report short. */
  hidden: number;
  /** Animations that ran on the screen outside the watched node. */
  outside: number;
  problems: string[];
  /** Size of the image, when one was made. */
  width: number;
  height: number;
}

/** The request for the page that the film is forcing pseudo-classes on: a selector for each set. */
export interface FilmPseudo {
  selector: string;
  classes: string[];
}

const round = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * A spring as a CSS `linear()` easing, so it works in plain transitions and can be
 * paused and sampled like any other. `bounce` runs from 0 (no overshoot) to 0.8 (very
 * springy). The curve ends when the spring has settled, so the transition's duration is
 * the whole motion.
 */
export function springEasing(bounce = 0.25): string {
  if (typeof bounce !== "number" || !Number.isFinite(bounce)) throw new Error(`Spring(bounce) needs a number from 0 to 0.8, got ${JSON.stringify(bounce)}.`);
  const zeta = Math.min(1, Math.max(0.2, 1 - bounce));
  const wd = Math.sqrt(Math.max(0, 1 - zeta * zeta));
  // Position of a spring released at 0 that rests at 1, with a natural frequency of 1.
  const at = (t: number) => (wd < 1e-6 ? 1 - Math.exp(-t) * (1 + t) : 1 - Math.exp(-zeta * t) * (Math.cos(wd * t) + (zeta / wd) * Math.sin(wd * t)));
  // Settled: the last moment the spring is more than 0.2% away from rest.
  let end = 80;
  for (let t = 80; t > 0; t -= 0.05) {
    if (Math.abs(1 - at(t)) > 0.002) break;
    end = t;
  }
  // Enough points to draw each swing smoothly.
  const swings = (wd * end) / Math.PI;
  const points = Math.round(Math.min(100, Math.max(20, swings * 10)));
  const out: string[] = [];
  for (let i = 0; i <= points; i++) out.push(i === points ? "1" : round(at((i / points) * end)));
  return `linear(${out.join(", ")})`;
}
