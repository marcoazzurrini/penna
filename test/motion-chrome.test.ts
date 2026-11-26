import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { pkgPath } from "../src/server/paths.ts";
import { startServer, type PennaServer } from "../src/server/http.ts";

// Motion is sampled in a real browser, and play mode runs in the real viewer, so these
// tests need Chrome. They are skipped where there is none.

let server: PennaServer;
let chrome: Browser | null = null;
const NO_CHROME = "Chrome is not installed";

before(async () => {
  if (!fs.existsSync(pkgPath("dist", "client", "index.html"))) {
    const { build } = await import("vite");
    await build({ configFile: pkgPath("vite.config.ts"), logLevel: "silent" });
  }
  server = await startServer(fs.mkdtempSync(path.join(os.tmpdir(), "penna-motion-")), 0);
  try {
    const { chromium } = await import("playwright-core");
    chrome = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
  } catch {}
});
after(async () => {
  await chrome?.close();
  await server.close();
});

let pages = 0;
/** Run a snippet on a new page, so tests do not see each other's nodes. */
async function run(code: string) {
  const r = await server.exec({ code: `Page("T${++pages}")\n${code}` });
  assert.equal(r.ok, true, r.text);
  return r;
}

/** The values of one line of a motion report, e.g. `track(text, "Box", "opacity")`. */
function track(text: string, name: string, property: string): string[] | null {
  const line = text.split("\n").find((l) => l.trim().startsWith(`${name} (`) && l.includes(`) ${property}: `));
  return line ? line.split(`${property}: `)[1].split(" → ") : null;
}

const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

// Linear easing makes the value at each moment exact, so the tests can name it.
const BOX = `class: "w-20 h-10 bg-black opacity-0 transition-opacity duration-200 ease-linear data-[state=open]:opacity-100"`;

test("a state change is sampled at exact moments", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await run(`Insert(page, {name: "Home", style: {width: 300, height: 200}, children: [{name: "Box", ${BOX}}]})
    Motion("Box", {state: "open"})`);
  assert.match(r.text, /Motion Box \(state none → open\): 200 ms, sampled at 0, 50, 100, 150, 200 ms/);
  assert.deepEqual(track(r.text, "Box", "opacity"), ["0", "0.25", "0.5", "0.75", "1"]);
  assert.equal(r.shots.length, 0);
});

test("the same design always gives the same report", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const code = `Insert(page, {name: "Home", style: {width: 300}, children: [
      {name: "Box", class: "w-20 h-10 bg-black transition duration-300 ease-out data-[state=open]:translate-x-10 data-[state=open]:rotate-45"}]})
    Motion("Box", {state: "open", frames: 7})`;
  const a = await run(code);
  const b = await run(code);
  const lines = (text: string) => text.split("\n").filter((l) => l.includes("→")).map((l) => l.replace(/\(\w+\)/, ""));
  assert.equal(lines(a.text).length, 3, a.text);
  assert.deepEqual(lines(a.text), lines(b.text));
});

test("a filmstrip is one image with a frame per moment, cropped to the node", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await run(`Insert(page, {name: "Home", style: {width: 1200, height: 800, background: "#fff"}, children: [{name: "Box", ${BOX}}]})
    Filmstrip("Box", {state: "open", frames: 4})
    Filmstrip("Home", {state: {Box: "open"}, frames: 4})`);
  assert.equal(r.shots.length, 2);
  const box = pngSize(r.shots[0].png);
  // Four frames of an 80×40 box with 12px around it, in one row.
  assert.ok(box.width > 4 * 100 && box.width < 4 * 130, `width ${box.width}`);
  assert.ok(box.height > 60 && box.height < 110, `height ${box.height}`);
  const home = pngSize(r.shots[1].png);
  assert.ok(Math.max(home.width, home.height) <= 1600, "a whole screen is scaled to fit the size limit");
  assert.ok(home.width > 1000 && home.height > 1000, "the frames wrap into a grid to stay large");
});

test("hover, active and focus are sampled too", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await run(`Insert(page, {name: "Home", class: "group", style: {width: 300}, children: [
      {name: "Btn", class: "w-20 h-10 bg-black transition duration-100 ease-linear hover:opacity-50 active:scale-90 focus:translate-y-2"},
      {name: "Tip", class: "opacity-0 transition duration-100 ease-linear group-hover:opacity-100", text: "tip"},
    ]})
    Motion("Btn", {hover: true, frames: 3})
    Motion("Btn", {active: true, frames: 3})
    Motion("Btn", {focus: true, frames: 3})
    Motion("Tip", {hover: "Home", frames: 3})`);
  const reports = r.text.split(/^(?=Motion )/m);
  assert.deepEqual(track(reports[0], "Btn", "opacity"), ["1", "0.75", "0.5"]);
  assert.equal(track(reports[0], "Btn", "scale"), null, "hover alone does not press");
  assert.deepEqual(track(reports[1], "Btn", "scale"), ["1", "0.95", "0.9"]);
  assert.deepEqual(track(reports[2], "Btn", "translate"), ["0px", "0px 4px", "0px 8px"]);
  assert.deepEqual(track(reports[3], "Tip", "opacity"), ["0", "0.5", "1"]);
});

test("keyframes play on load, and loops are sampled over one turn", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await run(`SetKeyframes({slide: {from: {translate: "0 20px", opacity: 0}, to: {translate: "0 0", opacity: 1}}, blink: {0: {opacity: 1}, 50: {opacity: 0}, 100: {opacity: 1}}})
    Insert(page, {name: "Home", style: {width: 300}, children: [
      {name: "Toast", text: "Saved", style: {animation: "slide 400ms linear both"}},
      {name: "Dot", class: "w-2 h-2 bg-black animate-[blink_1s_linear_infinite]"},
    ]})
    Motion("Toast"); Motion("Dot", {frames: 3}); Motion("Dot", {duration: 250, frames: 2}); Motion("Dot", {times: [750]})`);
  const reports = r.text.split(/^(?=Motion )/m);
  assert.match(reports[0], /Motion Toast \(on load\): 400 ms/);
  assert.deepEqual(track(reports[0], "Toast", "opacity"), ["0", "0.25", "0.5", "0.75", "1"]);
  assert.deepEqual(track(reports[0], "Toast", "translate"), ["0px 20px", "0px 15px", "0px 10px", "0px 5px", "0px"]);
  assert.deepEqual(track(reports[1], "Dot", "opacity"), ["1", "0", "1"]);
  assert.deepEqual(track(reports[2], "Dot", "opacity"), ["1", "0.5"]);
  assert.match(reports[3], /sampled at 750 ms/);
});

test("what played on load is at rest before a change, and loops elsewhere do not stretch it", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await run(`SetKeyframes({rise: {from: {translate: "0 20px"}, to: {translate: "0 0"}}})
    Insert(page, {name: "Home", style: {width: 300}, children: [
      {name: "Box", ${BOX}, style: {animation: "rise 900ms linear both"}},
      {name: "Spinner", class: "w-4 h-4 bg-black animate-spin"},
    ]})
    Motion("Box", {state: "open", frames: 3})
    Motion("Home", {state: {Box: "open"}, frames: 3})`);
  const reports = r.text.split(/^(?=Motion )/m);
  assert.match(reports[0], /: 200 ms, sampled at 0, 100, 200 ms/);
  assert.deepEqual(track(reports[0], "Box", "opacity"), ["0", "0.5", "1"]);
  assert.equal(track(reports[0], "Box", "translate"), null, "the load animation has finished");
  assert.doesNotMatch(reports[0], /outside/);
  assert.match(reports[1], /: 200 ms/, "the spinner's 1 s loop does not set the length");
  assert.ok(track(reports[1], "Spinner", "transform"), "but it is reported, since it is inside the watched node");
});

test("a film can start from another state", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await run(`Insert(page, {name: "Home", style: {width: 300}, children: [{name: "Box", state: "open", ${BOX}}]})
    Motion("Box", {state: null, frames: 3})
    Motion("Box", {from: "", state: "open", frames: 3})`);
  const reports = r.text.split(/^(?=Motion )/m);
  assert.match(reports[0], /state open → none/);
  assert.deepEqual(track(reports[0], "Box", "opacity"), ["1", "0.5", "0"]);
  assert.deepEqual(track(reports[1], "Box", "opacity"), ["0", "0.5", "1"]);
});

test("motion inside a component instance is sampled", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await run(`Insert(page, {name: "Card", component: true, class: "group", style: {width: 200}, children: [
      {name: "Body", class: "h-10 bg-black opacity-0 transition-opacity duration-200 ease-linear group-data-[state=open]:opacity-100"}]})
    Insert(page, {name: "Home", style: {width: 300}, children: [{name: "Mine", ref: "Card"}]})
    Motion("Mine/Body", {state: {Mine: "open"}, frames: 3})`);
  assert.deepEqual(track(r.text, "Body", "opacity"), ["0", "0.5", "1"]);
});

test("the report says what is wrong when nothing moves", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await run(`Insert(page, {name: "Home", style: {width: 300, height: 100, background: "#fff"}, children: [
      {name: "Still", class: "w-20 h-10 bg-black data-[state=open]:opacity-50"},
      {name: "Grow", class: "w-20 h-10 bg-black transition-all duration-200 data-[state=open]:h-40"},
      {name: "Spinner", class: "w-4 h-4 bg-black animate-spin"},
    ]})
    Filmstrip("Still", {state: "open"}); Motion("Still"); Motion("Grow", {state: "open"})`);
  const reports = r.text.split(/^(?=Motion )/m);
  assert.match(reports[0], /Motion Still \(state none → open\): nothing animates\n  1 animation\(s\) ran outside Still\.\n  Problem: Nothing inside Still animated\. The node that changes needs a transition/);
  assert.match(reports[1], /Problem: Nothing inside Still animates on load\. To sample a transition, pass what starts it/);
  assert.match(reports[2], /Problem: Animating height lays the page out again on every frame/);
  // With nothing in motion the filmstrip is a single frame, not five copies.
  const still = pngSize(r.shots[0].png);
  assert.ok(still.width < 150, `width ${still.width}`);
});

test("Check and Screenshot see the design at rest, not a moment of an entrance", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await run(`SetKeyframes({rise: {from: {translate: "0 200px"}, to: {translate: "0 0"}}})
    home = Insert(page, {name: "Home", class: "overflow-hidden", style: {width: 100, height: 100}, children: [
      {name: "Card", class: "w-10 h-10 bg-black", style: {animation: "rise 60s linear both"}},
      {name: "Spin", class: "w-10 h-10 bg-black animate-spin"}]})
    const l = await Layout(home); Print(JSON.stringify(l.nodes.find(n => n[1] === "Card").slice(2))); Check(home); Screenshot(home)`);
  assert.match(r.text, /\[0,0,40,40\]/);
  assert.match(r.text, /no layout problems/);
  assert.equal(r.shots.length, 1);
});

test("a hidden node cannot be filmed, and says so", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const r = await run(`Insert(page, {name: "Home", style: {width: 300}, children: [{name: "Gone", hidden: true}]}); Motion("Gone", {state: "open"})`);
  assert.match(r.text, /Rendering failed: .*The node to watch is hidden/);
});

test("keyframes from a design file cannot add other CSS rules", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const page = await chrome!.newPage();
  try {
    await page.goto(server.info.url + "/?headless=1");
    await page.waitForFunction(() => "__penna" in window);
    const doc = {
      version: 2,
      keyframes: {
        ok: { from: { opacity: 0 }, "50%": { color: "red } } body { display: none } @keyframes x { to { color: red", backgroundColor: "blue" }, to: { opacity: 1 } },
        "bad } body { display: none } @keyframes y": { to: { opacity: 0 } },
        stops: { "to { } } body { display: none } @keyframes z { to": { opacity: 0 }, to: { marginTop: 4 } },
      },
      pages: [{ id: "p", name: "P", children: [{ id: "a", type: "frame", style: { width: 10, height: 10 } }] }],
    };
    const rules = await page.evaluate(async (d) => {
      await (window as unknown as { __penna: { render(d: unknown, css: string, id: string): Promise<unknown> } }).__penna.render(d, "", "a");
      const sheet = document.adoptedStyleSheets.at(-1)!;
      return { text: [...sheet.cssRules].map((r) => r.cssText.replace(/\s+/g, " ")), body: getComputedStyle(document.body).display };
    }, doc);
    assert.equal(rules.body, "block");
    assert.deepEqual(rules.text, [
      "@keyframes ok { 0% { opacity: 0; } 50% { background-color: blue; } 100% { opacity: 1; } }",
      "@keyframes stops { 100% { margin-top: 4px; } }",
    ]);
  } finally {
    await page.close();
  }
});

// ---------- Play mode in the viewer ----------

async function openViewer(code: string): Promise<Page> {
  await run(code);
  const page = await chrome!.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(server.info.url);
  await page.locator("#pages button").getByText(`T${pages}`, { exact: true }).click();
  await page.locator('#world [data-name="Home"]').waitFor();
  // The viewer measures the screens and then moves the camera to fit them. Wait for
  // that, so positions read by a test are the final ones.
  await page.locator("#world .pn-top.cv").first().waitFor();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page;
}

const stateOf = (page: Page, name: string) => page.locator(`#world [data-name="${name}"]`).first().getAttribute("data-state");
/** Wait for a node to reach a state. Pointer events arrive a moment after the pointer moves. */
const waitState = (page: Page, name: string, state: string) =>
  page.waitForFunction(([n, s]) => document.querySelector(`#world [data-name="${n}"]`)?.getAttribute("data-state") === s, [name, state] as const, { timeout: 5000 });
const tap = (page: Page, name: string, nth = 0) => page.locator(`#world [data-name="${name}"]`).nth(nth).click();

const DIALOG = `Insert(page, {name: "Home", style: {width: 400, height: 300, background: "#fff"}, class: "p-4 flex flex-col gap-4 items-start", children: [
  {name: "Open", text: "Open", class: "p-2 bg-black text-white", on: {click: {target: "Dialog", state: "open"}}},
  {name: "Flip", text: "Flip", class: "p-2 bg-black text-white", on: {click: [{target: "Dialog", toggle: "open"}, {toggle: "on"}]}},
  {name: "Hot", text: "Hot", class: "p-2 bg-black text-white", on: {enter: {target: "Dialog", state: "peek"}, leave: {target: "Dialog", state: "closed"}}},
  {name: "Dialog", state: "closed", class: "p-4 bg-neutral-200 opacity-30 data-[state=open]:opacity-100", children: [
    {name: "Close", text: "Close", on: {click: {target: "Dialog", state: "closed"}}}]},
]})`;

test("outside play mode a click selects; in play mode it runs the trigger", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const page = await openViewer(DIALOG);
  try {
    await tap(page, "Open");
    assert.equal(await stateOf(page, "Dialog"), "closed");
    assert.equal(await page.locator("#select-box").isVisible(), true);
    assert.match((await page.locator("#info").textContent())!, /Open/);

    await page.locator("#play").click();
    assert.equal(await page.locator("#play").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#select-box").isVisible(), false);
    await tap(page, "Open");
    assert.equal(await stateOf(page, "Dialog"), "open");
    await tap(page, "Close");
    assert.equal(await stateOf(page, "Dialog"), "closed");

    // Toggle switches between the state and the one in the design; several actions run in order.
    await tap(page, "Flip");
    assert.equal(await stateOf(page, "Dialog"), "open");
    assert.equal(await stateOf(page, "Flip"), "on");
    await tap(page, "Flip");
    assert.equal(await stateOf(page, "Dialog"), "closed");
    assert.equal(await stateOf(page, "Flip"), null);

    // Leaving play mode puts every node back as designed, and the file is untouched.
    await tap(page, "Open");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#play").getAttribute("aria-pressed"), "false");
    assert.equal(await stateOf(page, "Dialog"), "closed");
    const saved = fs.readFileSync(path.join(server.info.root, ".penna", "pages", `t${pages}.json`), "utf8");
    assert.equal(JSON.parse(saved).children[0].children[3].state, "closed");
  } finally {
    await page.close();
  }
});

test("enter and leave triggers follow the pointer, and P toggles play mode", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const page = await openViewer(DIALOG);
  try {
    const hot = (await page.locator('#world [data-name="Hot"]').boundingBox())!;
    await page.mouse.move(hot.x + hot.width / 2, hot.y + hot.height / 2);
    assert.equal(await stateOf(page, "Dialog"), "closed", "nothing runs outside play mode");
    await page.mouse.move(5, 400);
    await page.keyboard.press("p");
    await page.mouse.move(hot.x + hot.width / 2, hot.y + hot.height / 2);
    await waitState(page, "Dialog", "peek");
    await page.mouse.move(5, 400);
    await waitState(page, "Dialog", "closed");
    await page.keyboard.press("p");
    assert.equal(await page.locator("#play").getAttribute("aria-pressed"), "false");
  } finally {
    await page.close();
  }
});

test("a trigger inside a component instance changes its own instance", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const page = await openViewer(`Insert(page, {name: "Tile", component: true, class: "p-2 bg-neutral-200", style: {width: 200}, children: [
      {name: "More", text: "More", on: {click: {target: "Tile", toggle: "open"}}},
      {name: "Body", text: "Body", class: "hidden", on: {click: {state: "seen"}}}]})
    Insert(page, {name: "Home", style: {width: 400, background: "#fff"}, class: "p-4 flex flex-col gap-4", children: [{name: "A", ref: "Tile"}, {name: "B", ref: "Tile"}]})`);
  try {
    await page.locator("#play").click();
    await page.locator('#world [data-name="B"] [data-name="More"]').click();
    assert.equal(await stateOf(page, "B"), "open");
    assert.equal(await stateOf(page, "A"), null);
    await page.locator('#world [data-name="A"] [data-name="More"]').click();
    assert.equal(await stateOf(page, "A"), "open");
  } finally {
    await page.close();
  }
});

test("replay restarts the animations that play on load", async (t) => {
  if (!chrome) return t.skip(NO_CHROME);
  const page = await openViewer(`SetKeyframes({slow: {from: {opacity: 0}, to: {opacity: 1}}})
    Insert(page, {name: "Home", style: {width: 400, height: 100, background: "#fff"}, children: [{name: "Fade", text: "Hi", style: {animation: "slow 60s linear both"}}]})`);
  try {
    const time = () => page.evaluate(() => Number(document.querySelector('#world [data-name="Fade"]')!.getAnimations()[0].currentTime));
    await page.waitForFunction(() => Number(document.querySelector('#world [data-name="Fade"]')?.getAnimations()[0]?.currentTime) > 300);
    await page.keyboard.press("p");
    assert.ok((await time()) < 300, "entering play mode starts them again");
    await page.waitForFunction(() => Number(document.querySelector('#world [data-name="Fade"]')?.getAnimations()[0]?.currentTime) > 300);
    await page.keyboard.press("r");
    assert.ok((await time()) < 300, "and so does R");
  } finally {
    await page.close();
  }
});
