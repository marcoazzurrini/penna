import type { Action, TriggerEvent, Triggers } from "../shared/types.ts";

/**
 * Play mode: runs the triggers stored on nodes, so a click opens the menu instead of
 * selecting a layer. States change only on the page being viewed. The design files are
 * never touched, and leaving play mode puts every node back.
 */
export function createPlay(world: HTMLElement) {
  /** Nodes whose state was changed, with the state the design gives them. */
  const changed = new Map<HTMLElement, string | undefined>();
  let on = false;

  const setState = (el: HTMLElement, state: string | undefined) => {
    if (state) el.dataset.state = state;
    else delete el.dataset.state;
  };

  /**
   * The node an action names, by id or name. The search starts at the trigger and widens
   * one ancestor at a time, so a trigger inside a component instance finds the part of
   * its own instance before a node with the same name elsewhere. Inside an instance, ids
   * are `instance/part`, and the root answers to the component's id and name.
   */
  function findTarget(from: HTMLElement, key: string): HTMLElement | null {
    const k = CSS.escape(key);
    const selector = `[data-id="${k}"],[data-id$="/${k}"],[data-name="${k}"],[data-ref="${k}"],[data-ref-name="${k}"]`;
    for (let el: HTMLElement | null = from; el && world.contains(el); el = el.parentElement) {
      if (el !== world && el.matches(selector)) return el;
      const hit = el.querySelector<HTMLElement>(selector);
      if (hit) return hit;
    }
    return null;
  }

  function apply(target: HTMLElement, action: Action) {
    if (!changed.has(target)) changed.set(target, target.dataset.state);
    const base = changed.get(target);
    if (action.toggle !== undefined) {
      const isOn = target.dataset.state === action.toggle;
      setState(target, isOn ? (base === action.toggle ? undefined : base) : action.toggle);
    } else setState(target, action.state);
  }

  /** Run the actions `el` has for `event`. Returns whether it had any. */
  function run(el: HTMLElement, event: TriggerEvent): boolean {
    let triggers: Triggers;
    try {
      triggers = JSON.parse(el.dataset.on ?? "{}") as Triggers;
    } catch {
      return false;
    }
    const actions = triggers[event];
    if (!Array.isArray(actions) || !actions.length) return false;
    for (const action of actions) {
      const target = action.target === undefined ? el : findTarget(el, action.target);
      if (target) apply(target, action);
    }
    return true;
  }

  const triggerAbove = (el: Element | null) => el?.closest<HTMLElement>("[data-on]") ?? null;

  // Enter and leave do not bubble in the DOM, so work them out from over and out: the
  // pointer entered a node when it came from outside that node.
  function crossing(event: TriggerEvent) {
    return (e: MouseEvent) => {
      if (!on || !(e.target instanceof Element)) return;
      const other = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      for (let el = triggerAbove(e.target); el && world.contains(el); el = triggerAbove(el.parentElement)) {
        if (!other || !el.contains(other)) run(el, event);
      }
    };
  }
  world.addEventListener("mouseover", crossing("enter"));
  world.addEventListener("mouseout", crossing("leave"));

  function reset() {
    for (const [el, state] of changed) if (el.isConnected) setState(el, state);
    changed.clear();
  }

  return {
    get on() {
      return on;
    },
    set(value: boolean) {
      on = value;
      if (!on) reset();
    },
    /** A click at a point on the screen. Runs the nearest click trigger at or above it. */
    click(x: number, y: number) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !world.contains(hit)) return;
      for (let el = triggerAbove(hit); el && world.contains(el); el = triggerAbove(el.parentElement)) {
        if (run(el, "click")) return;
      }
    },
    /** Put every state back and start the animations that play on load again. */
    replay() {
      reset();
      for (const a of world.getAnimations({ subtree: true })) {
        if (!(a instanceof CSSAnimation)) continue;
        a.cancel();
        a.play();
      }
    },
  };
}
