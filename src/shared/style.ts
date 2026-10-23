import type { Style } from "./types.ts";

// Properties that take bare numbers. Same idea as React's list.
const UNITLESS = new Set([
  "animationIterationCount", "aspectRatio", "columnCount", "columns", "fillOpacity", "flex",
  "flexGrow", "flexShrink", "fontWeight", "gridArea", "gridColumn", "gridColumnEnd",
  "gridColumnStart", "gridRow", "gridRowEnd", "gridRowStart", "lineClamp", "lineHeight",
  "opacity", "order", "orphans", "scale", "strokeOpacity", "strokeWidth", "tabSize", "widows",
  "zIndex", "zoom",
]);

export function kebab(key: string): string {
  if (key.startsWith("--")) return key;
  return key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

export function camel(key: string): string {
  if (key.startsWith("--")) return key;
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function cssValue(key: string, value: string | number): string {
  if (typeof value === "number" && value !== 0 && !UNITLESS.has(key) && !key.startsWith("--")) {
    return value + "px";
  }
  return String(value);
}

export function styleToCss(style: Style | undefined): string {
  if (!style) return "";
  let out = "";
  for (const key in style) {
    const v = style[key];
    if (v === null || v === undefined || v === "") continue;
    out += kebab(key) + ":" + cssValue(key, v) + ";";
  }
  return out;
}

export function variablesToCss(vars: Record<string, string> | undefined): string {
  if (!vars) return "";
  let out = "";
  for (const k in vars) out += "--" + k.replace(/^--/, "") + ":" + vars[k] + ";";
  return out;
}
