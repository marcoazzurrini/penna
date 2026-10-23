import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Builds Google Fonts CSS for the families a document uses. Google rejects requests for
// weights a family lacks, so we read the font metadata to ask for exactly what exists.

const CACHE_DIR = path.join(os.homedir(), ".cache", "penna");
const META_FILE = path.join(CACHE_DIR, "google-fonts.json");
const META_MAX_AGE = 7 * 24 * 3600 * 1000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

interface FamilyMeta {
  family: string;
  fonts: Record<string, unknown>;
  axes?: { tag: string; min: number; max: number }[];
}

let meta: Promise<Map<string, FamilyMeta>> | null = null;
const cssCache = new Map<string, string>();

async function loadMeta(): Promise<Map<string, FamilyMeta>> {
  let list: FamilyMeta[] | null = null;
  try {
    const stat = fs.statSync(META_FILE);
    if (Date.now() - stat.mtimeMs < META_MAX_AGE) list = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  } catch {}
  if (!list) {
    const res = await fetch("https://fonts.google.com/metadata/fonts");
    const text = (await res.text()).replace(/^\)\]\}'/, "");
    const raw = JSON.parse(text) as { familyMetadataList: FamilyMeta[] };
    list = raw.familyMetadataList.map(({ family, fonts, axes }) => ({ family, fonts, axes }));
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(META_FILE, JSON.stringify(list));
  }
  return new Map(list.map((f) => [f.family.toLowerCase(), f]));
}

function familyQuery(f: FamilyMeta): string {
  const name = f.family.replace(/ /g, "+");
  const keys = Object.keys(f.fonts);
  const hasItalic = keys.some((k) => k.endsWith("i"));
  const wght = f.axes?.find((a) => a.tag === "wght");
  if (wght) {
    const range = `${wght.min}..${wght.max}`;
    return hasItalic ? `${name}:ital,wght@0,${range};1,${range}` : `${name}:wght@${range}`;
  }
  const weights = (italic: boolean) =>
    keys
      .filter((k) => k.endsWith("i") === italic)
      .map((k) => parseInt(k, 10))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
  const normal = weights(false);
  const italic = weights(true);
  if (!hasItalic) return `${name}:wght@${normal.join(";")}`;
  return `${name}:ital,wght@${[...normal.map((w) => `0,${w}`), ...italic.map((w) => `1,${w}`)].join(";")}`;
}

export async function fontsCss(families: string[]): Promise<string> {
  const key = families.join("|");
  const hit = cssCache.get(key);
  if (hit !== undefined) return hit;
  let css = "";
  try {
    meta ??= loadMeta();
    const m = await meta;
    const queries = families.map((f) => m.get(f.toLowerCase())).filter((f): f is FamilyMeta => !!f).map(familyQuery);
    if (queries.length) {
      const url = "https://fonts.googleapis.com/css2?" + queries.map((q) => "family=" + q).join("&") + "&display=swap";
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) css = await res.text();
    }
  } catch {
    meta = null; // Offline. Try again next time.
    return "";
  }
  cssCache.set(key, css);
  return css;
}
