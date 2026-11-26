// Pan and zoom: the camera, and the wheel, pinch, and drag input that moves it.

export interface Camera {
  x: number;
  y: number;
  z: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CameraOptions {
  viewport: HTMLElement;
  world: HTMLElement;
  /** Shows the zoom level. */
  zoomLabel: HTMLElement;
  /** Called once per frame in which the camera moved. */
  onMove(): void;
  /** Called shortly after the camera stops moving. */
  onRest(): void;
  /** A click that was not a drag, in screen coordinates. */
  onClick(x: number, y: number): void;
  /** The pointer moved over the canvas without dragging. */
  onHover(x: number, y: number): void;
  /** The pointer left the canvas, or a drag began. */
  onHoverEnd(): void;
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;

export function createCamera(opts: CameraOptions) {
  const { viewport, world } = opts;
  let cam: Camera = { x: 0, y: 0, z: 1 };
  let restTimer: number | undefined;
  let frameQueued = false;

  function apply() {
    if (!frameQueued) {
      frameQueued = true;
      requestAnimationFrame(() => {
        frameQueued = false;
        world.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.z})`;
        opts.zoomLabel.textContent = Math.round(cam.z * 100) + "%";
        opts.onMove();
      });
    }
    // Promote the world to its own GPU layer while moving, then let it re-raster crisply.
    world.classList.add("moving");
    clearTimeout(restTimer);
    restTimer = window.setTimeout(() => {
      world.classList.remove("moving");
      opts.onRest();
    }, 180);
  }

  /** Show `b` (in canvas coordinates) centred, as large as fits, up to `maxZoom`. */
  function fitRect(b: Rect, maxZoom = 1) {
    const vw = viewport.clientWidth, vh = viewport.clientHeight, pad = 64;
    const z = Math.min((vw - pad * 2) / Math.max(b.w, 1), (vh - pad * 2) / Math.max(b.h, 1), maxZoom);
    cam = { z, x: (vw - b.w * z) / 2 - b.x * z, y: (vh - b.h * z) / 2 - b.y * z };
    apply();
  }

  /** Zoom by `factor`, keeping the screen point (sx, sy) still. */
  function zoomAt(factor: number, sx: number, sy: number) {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.z * factor));
    const k = z / cam.z;
    cam = { z, x: sx - (sx - cam.x) * k, y: sy - (sy - cam.y) * k };
    apply();
  }

  function zoomCentre(factor: number) {
    zoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  }

  /** Use a saved camera. Returns false, and changes nothing, if it is not a usable one. */
  function restore(saved: unknown): boolean {
    const c = saved as Partial<Camera> | null;
    if (!c || ![c.x, c.y, c.z].every((n) => typeof n === "number" && Number.isFinite(n)) || c.z! <= 0) return false;
    cam = { x: c.x!, y: c.y!, z: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.z!)) };
    apply();
    return true;
  }

  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const v = viewport.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const dy = Math.max(-30, Math.min(30, e.deltaMode ? e.deltaY * 16 : e.deltaY));
        zoomAt(Math.exp(-dy / 120), e.clientX - v.left, e.clientY - v.top);
      } else {
        const k = e.deltaMode ? 16 : 1;
        cam.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
        cam.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
        apply();
      }
    },
    { passive: false },
  );

  // Safari pinch gestures.
  let gestureZ = 1;
  viewport.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gestureZ = cam.z;
  });
  viewport.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    const g = e as unknown as { scale: number; clientX: number; clientY: number };
    const v = viewport.getBoundingClientRect();
    zoomAt((gestureZ * g.scale) / cam.z, g.clientX - v.left, g.clientY - v.top);
  });

  // Drag pans, click selects.
  const onHud = (target: EventTarget | null) => target instanceof Element && !!target.closest("#hud, #problems");
  let drag: { x: number; y: number; cx: number; cy: number; moved: boolean; id: number } | null = null;
  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (onHud(e.target)) return;
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, id: e.pointerId };
  });
  window.addEventListener("pointermove", (e) => {
    if (drag && drag.id === e.pointerId) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 3) {
        drag.moved = true;
        viewport.classList.add("panning");
        viewport.setPointerCapture(e.pointerId);
        opts.onHoverEnd();
      }
      if (drag.moved) {
        cam.x = drag.cx + dx;
        cam.y = drag.cy + dy;
        apply();
      }
      return;
    }
    if (e.target instanceof Node && viewport.contains(e.target)) opts.onHover(e.clientX, e.clientY);
  });
  window.addEventListener("pointerup", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const wasClick = !drag.moved;
    drag = null;
    viewport.classList.remove("panning");
    if (wasClick && e.button === 0 && !onHud(e.target)) opts.onClick(e.clientX, e.clientY);
  });
  viewport.addEventListener("pointerleave", () => opts.onHoverEnd());

  return {
    /** The current camera. Treat it as read-only. */
    get current(): Camera {
      return cam;
    },
    fitRect,
    zoomAt,
    zoomCentre,
    restore,
  };
}
