import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The module caches font metadata on disk. Point it at a folder of our own first.
process.env.PENNA_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "penna-fonts-"));
const { fontsCss } = await import("../src/server/fonts.ts");

const metadata = ")]}'" + JSON.stringify({ familyMetadataList: [{ family: "Inter", fonts: { "400": {}, "700": {} }, axes: [{ tag: "wght", min: 100, max: 900 }] }] });

function google(css: "ok" | "offline" | "refused") {
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    if (url.includes("metadata")) return new Response(metadata);
    if (css === "offline") throw new Error("offline");
    if (css === "refused") return new Response("bad request", { status: 400 });
    return new Response("@font-face{font-family:Inter}");
  };
  return { fetcher, urls };
}

test("a failed answer is marked incomplete and tried again", async () => {
  const offline = await fontsCss(["Inter"], google("offline").fetcher);
  assert.deepEqual(offline, { css: "", complete: false });
  const refused = await fontsCss(["Inter"], google("refused").fetcher);
  assert.deepEqual(refused, { css: "", complete: false });

  const up = google("ok");
  assert.deepEqual(await fontsCss(["Inter"], up.fetcher), { css: "@font-face{font-family:Inter}", complete: true });
  assert.match(up.urls.at(-1)!, /family=Inter:wght@100\.\.900/);

  // A good answer is cached, so Google is not asked again.
  const again = google("offline");
  assert.equal((await fontsCss(["Inter"], again.fetcher)).complete, true);
  assert.deepEqual(again.urls, []);
});

test("families Google does not have need no request", async () => {
  const g = google("offline");
  assert.deepEqual(await fontsCss(["Not A Font"], g.fetcher), { css: "", complete: true });
  assert.equal(g.urls.some((u) => u.includes("css2")), false);
});
