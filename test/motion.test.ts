import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, beforeEach, test } from "node:test";
import { DocModel } from "../src/client/model.ts";
import { Executor } from "../src/server/execute.ts";
import type { Renderer } from "../src/server/headless.ts";
import { resolveDep } from "../src/server/paths.ts";
import { Store } from "../src/server/store.ts";
import { Tailwind } from "../src/server/tailwind.ts";
import { Wire } from "../src/server/wire.ts";
import { springEasing, type FilmReport, type FilmRequest } from "../src/shared/motion.ts";
import { keyframesProblem, nodeProblem, projectFileProblem } from "../src/shared/schema.ts";
import { expandRef, indexDoc, renderSubset } from "../src/shared/tree.ts";

process.env.PENNA_VERIFY_INDEX = "1";

const iconDir = path.join(resolveDep("lucide-static"), "icons");

let store: Store;
let exec: Executor;
/** The films the snippet asked for, and what the fake renderer answers. */
let films: { req: FilmRequest; image: boolean }[];
let report: FilmReport;

beforeEach(() => {
  store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "penna-motion-")));
  films = [];
  report = { times: [0, 100, 200], duration: 200, tracks: [{ id: "abc", name: "Panel", property: "opacity", values: ["0", "0.5", "1"] }], hidden: 0, outside: 0, problems: [], width: 10, height: 10 };
  const renderer: Renderer = {
    screenshot: async () => Buffer.alloc(0),
    layout: async () => ({ width: 1, height: 1, nodes: [], problems: [] }),
    film: async (_doc, _index, req, image) => {
      films.push({ req, image });
      return { report, png: image ? Buffer.from("png") : undefined };
    },
  };
  exec = new Executor(store, renderer, iconDir, () => "http://localhost:0");
});

const run = (code: string) => exec.run({ code });
const ok = async (code: string) => {
  const r = await run(code);
  assert.equal(r.ok, true, r.text);
  return r;
};
const doc = () => store.get();
const node = (name: string) => [...indexDoc(doc()).values()].find((l) => l.node.name === name)!.node;

// ---------- States and triggers ----------

test("state and triggers are stored, with one action or a list", async () => {
  await ok(`Insert(page, {name: "Home", children: [
    {name: "Menu", state: "closed"},
    {name: "Open", text: "Open", on: {click: {target: "Menu", state: "open"}, enter: [{toggle: "hot"}, {target: "Menu", state: ""}]}},
  ]})`);
  assert.equal(node("Menu").state, "closed");
  assert.deepEqual(node("Open").on, {
    click: [{ target: "Menu", state: "open" }],
    enter: [{ toggle: "hot" }, { target: "Menu", state: "" }],
  });
  assert.equal(nodeProblem(doc().pages[0].children[0], new Set()), null);
});

test("a trigger that is not valid fails the call", async () => {
  for (const [bad, message] of [
    [`{tap: {state: "a"}}`, /unknown trigger "tap"; use click, enter, or leave/i],
    [`{click: {target: "x"}}`, /needs either state or toggle/i],
    [`{click: {state: "a", toggle: "b"}}`, /needs either state or toggle/],
    [`{click: {state: 1}}`, /state must be a string/],
    [`{click: {state: "a", delay: 3}}`, /unknown action property "delay"/],
    [`{click: "open"}`, /an action must be an object/],
    [`"click"`, /on must be an object/],
  ] as const) {
    const r = await run(`Insert(page, {name: "A", on: ${bad}})`);
    assert.equal(r.ok, false, bad);
    assert.match(r.text, new RegExp(message.source, "i"));
  }
  assert.equal(doc().pages[0].children.length, 0);
});

test("a trigger whose target is not a node gets a warning", async () => {
  const fine = await ok(`Insert(page, {name: "Home", children: [
    {name: "Open", on: {click: {target: "Menu", state: "open"}}}, {name: "Menu"},
  ]})`);
  assert.doesNotMatch(fine.text, /Warnings/, "a target made in the same call is found");
  const byId = await ok(`Update("Open", {on: {click: {target: "${node("Menu").id}", toggle: "open"}}})`);
  assert.doesNotMatch(byId.text, /Warnings/);
  const typo = await ok(`Update("Open", {on: {click: {target: "Mneu", state: "open"}}})`);
  assert.match(typo.text, /on\.click of "Open" targets "Mneu", which is not the id or name of a node/);
});

test("Update changes and removes a state and triggers", async () => {
  await ok(`Insert(page, {name: "A", state: "on", on: {click: {toggle: "on"}}})`);
  await ok(`Update("A", {state: "off"})`);
  assert.equal(node("A").state, "off");
  await ok(`Update("A", {state: null, on: null})`);
  assert.equal("state" in node("A"), false);
  assert.equal("on" in node("A"), false);
});

test("Tree shows states and triggers", async () => {
  const r = await ok(`Insert(page, {name: "A", state: "open", on: {click: {toggle: "open"}, leave: {state: ""}}}); Print(Tree())`);
  assert.match(r.text, /^A \w+ frame @0,0 state=open on:click,leave$/m);
});

test("an instance carries the component's triggers and can set its own state", async () => {
  await ok(`Insert(page, {name: "Card", component: true, state: "idle", children: [{name: "More", on: {click: {target: "Card", toggle: "open"}}}]})
    Insert(page, {name: "One", ref: "Card", state: "open"}); Insert(page, {name: "Two", ref: "Card"})`);
  const index = indexDoc(doc());
  const one = expandRef(node("One"), index)!;
  const two = expandRef(node("Two"), index)!;
  assert.equal(one.state, "open");
  assert.equal(two.state, "idle");
  assert.deepEqual(one.children![0].on, { click: [{ target: "Card", toggle: "open" }] });
  await ok(`Update("Two/More", {on: {click: {state: "pressed"}}})`);
  assert.deepEqual(expandRef(node("Two"), indexDoc(doc()))!.children![0].on, { click: [{ state: "pressed" }] });
});

// ---------- Keyframes ----------

const projectFile = () => JSON.parse(fs.readFileSync(path.join(store.root, ".penna", "project.json"), "utf8"));

test("SetKeyframes stores rules in project.json", async () => {
  const r = await ok(`SetKeyframes({
    "fade-up": {from: {opacity: 0, "translate": "0 8px"}, to: {opacity: 1, translate: "0 0"}},
    pulse2: {0: {opacity: .4}, 50: {"background-color": "red"}, "100%": {opacity: .4}},
  })
  Print(JSON.stringify(GetKeyframes().pulse2), State().keyframes)`);
  assert.deepEqual(projectFile().keyframes, {
    "fade-up": { from: { opacity: 0, translate: "0 8px" }, to: { opacity: 1, translate: "0 0" } },
    pulse2: { "0%": { opacity: 0.4 }, "50%": { backgroundColor: "red" }, "100%": { opacity: 0.4 } },
  });
  assert.match(r.text, /"50%":\{"backgroundColor":"red"\}/);
  assert.match(r.text, /\["fade-up","pulse2"\]/);
});

test("SetKeyframes merges by name, and null deletes", async () => {
  await ok(`SetKeyframes({a: {to: {opacity: 0}}, b: {to: {opacity: 1}}})`);
  await ok(`SetKeyframes({a: null, c: {to: {scale: 2}}})`);
  assert.deepEqual(Object.keys(projectFile().keyframes), ["b", "c"]);
  await ok(`SetKeyframes({b: null, c: null})`);
  assert.equal("keyframes" in projectFile(), false);
});

test("keyframes survive a restart and an undo", async () => {
  await ok(`SetKeyframes({a: {to: {opacity: 0}}})`);
  await ok(`SetKeyframes({a: {to: {opacity: 1}}})`);
  assert.equal(new Store(store.root).get().keyframes!.a.to.opacity, 1);
  assert.equal(store.undo(), true);
  assert.equal(doc().keyframes!.a.to.opacity, 0);
});

test("keyframes that are not valid fail the call", async () => {
  for (const [bad, message] of [
    [`{"a b": {to: {opacity: 0}}}`, /name "a b" must be letters/],
    [`{"x}body{": {to: {opacity: 0}}}`, /must be letters/],
    [`{a: {middle: {opacity: 0}}}`, /bad stop "middle"/],
    [`{a: {"50%}": {opacity: 0}}}`, /bad stop/],
    [`{a: {to: "opacity: 0"}}`, /must be an object of CSS properties/],
    [`{a: {to: {opacity: [1]}}}`, /opacity must be a string or number/],
    [`{a: {}}`, /has no stops/],
    [`{a: 5}`, /must be an object of stops/],
  ] as const) {
    const r = await run(`SetKeyframes(${bad})`);
    assert.equal(r.ok, false, bad);
    assert.match(r.text, message);
  }
  assert.equal(doc().keyframes, undefined);
});

test("a project file with bad keyframes is rejected", () => {
  assert.equal(keyframesProblem({ ok: { "0%, 50%": { opacity: 1 }, to: { scale: 2 } } }), null);
  assert.match(keyframesProblem({ "a{}": { to: {} } })!, /must be letters/);
  assert.match(keyframesProblem({ a: { "to{": {} } })!, /bad stop/);
  assert.match(projectFileProblem({ version: 2, pages: [], keyframes: { a: { to: { opacity: {} } } } })!, /keyframes\.a\["to"\]: style\.opacity/);
  assert.equal(projectFileProblem({ version: 2, pages: [], keyframes: { a: { to: { opacity: 1 } } } }), null);
});

test("replacing one of Tailwind's keyframes gets a warning", async () => {
  const r = await ok(`SetKeyframes({spin: {to: {rotate: "180deg"}}})`);
  assert.match(r.text, /replace the ones behind Tailwind's animate-spin/);
});

test("keyframes reach the viewer and the renderer", async () => {
  const wire = new Wire("test", await Tailwind.create());
  wire.update(doc(), store.rev);
  await ok(`SetKeyframes({a: {to: {opacity: 0}}}); Insert(page, {name: "Home"})`);
  const model = new DocModel();
  model.apply(wire.full(doc(), store.rev));
  assert.deepEqual(model.doc!.keyframes, { a: { to: { opacity: 0 } } });
  assert.deepEqual(renderSubset(doc(), indexDoc(doc()), node("Home").id).keyframes, { a: { to: { opacity: 0 } } });
});

// ---------- Spring ----------

const points = (easing: string) => easing.slice(7, -1).split(", ").map(Number);

test("Spring gives a linear() easing that starts at 0 and settles at 1", async () => {
  for (const bounce of [0, 0.25, 0.6, 1]) {
    const p = points(springEasing(bounce));
    assert.match(springEasing(bounce), /^linear\(0, [\d., -]+, 1\)$/);
    assert.equal(p[0], 0);
    assert.equal(p.at(-1), 1);
    assert.ok(p.length >= 20 && p.length <= 101, `${p.length} points`);
    assert.ok(Math.abs(1 - p.at(-2)!) < 0.02, "it has settled by the end");
  }
  assert.ok(Math.max(...points(springEasing(0))) <= 1, "no bounce never overshoots");
  assert.ok(Math.max(...points(springEasing(0.5))) > 1.1, "bounce overshoots");
  assert.ok(Math.max(...points(springEasing(0.8))) > Math.max(...points(springEasing(0.3))));
  const r = await ok(`SetVariables({spring: Spring(0.3)}); Print(GetVariables().variables.spring.slice(0, 9))`);
  assert.match(r.text, /^linear\(0,/);
  assert.equal((await run(`Spring("soft")`)).ok, false);
});

// ---------- Filmstrip and Motion ----------

const SCREEN = `home = Insert(page, {name: "Home", children: [
  {name: "Open", text: "Open"},
  {name: "Menu", state: "closed", children: [{name: "Item", text: "One"}]},
]})
other = Insert(page, {name: "Other"})\n`;

test("Filmstrip returns an image and Motion only text", async () => {
  const r = await ok(SCREEN + `Filmstrip("Menu", {state: "open"}); Motion("Open", {hover: true})`);
  assert.deepEqual(films.map((f) => f.image), [true, false]);
  assert.equal(r.shots.length, 1);
  assert.equal(r.shots[0].name, "filmstrip of Menu");
  assert.equal(r.shots[0].id, node("Menu").id);
  assert.match(r.text, /Motion Menu \(state closed → open\): 200 ms, sampled at 0, 100, 200 ms\n  Panel \(abc\) opacity: 0 → 0\.5 → 1/);
  assert.match(r.text, /Motion Open \(hover\): 200 ms/);
});

test("a film renders the whole screen and watches the named node", async () => {
  await ok(SCREEN + `Motion("Item", {state: {Menu: "open"}, from: {Menu: null}, hover: "Open", focus: true, active: "Open", frames: 8, duration: 900, scale: 2})`);
  const { req } = films[0];
  const id = (name: string) => node(name).id;
  assert.deepEqual(req, {
    top: id("Home"),
    target: id("Item"),
    frames: 8,
    duration: 900,
    scale: 2,
    from: { [id("Menu")]: null },
    to: { [id("Menu")]: "open" },
    pseudo: { [id("Open")]: ["hover", "active"], [id("Item")]: ["focus", "focus-visible"] },
  });
});

test("a film takes exact times, sorted", async () => {
  await ok(SCREEN + `Motion("Menu", {state: "open", times: [300, 0, 120]})`);
  assert.deepEqual(films[0].req.times, [0, 120, 300]);
});

test("a film reaches into a component instance", async () => {
  await ok(`Insert(page, {name: "Card", component: true, children: [{name: "Body"}]}); Insert(page, {name: "Home", children: [{name: "Mine", ref: "Card"}]})
    Motion("Mine/Body", {state: {Mine: "open"}})`);
  const mine = node("Mine").id;
  assert.equal(films[0].req.target, `${mine}/${node("Body").id}`);
  assert.equal(films[0].req.top, node("Home").id);
  assert.deepEqual(films[0].req.to, { [mine]: "open" });
});

test("film arguments that make no sense fail the call", async () => {
  for (const [args, message] of [
    [`"Menu", {to: "open"}`, /unknown option "to"\. Options: state, from, hover/],
    [`"Menu", {frames: 1}`, /frames must be a whole number from 2 to 12/],
    [`"Menu", {frames: 40}`, /frames must be a whole number/],
    [`"Menu", {times: []}`, /times must be a list of 1 to 12 times/],
    [`"Menu", {times: [0, -5]}`, /each time must be a time in ms/],
    [`"Menu", {duration: "1s"}`, /duration must be a time in ms/],
    [`"Menu", {state: 3}`, /state must be a state name, or \{path: state\}/],
    [`"Menu", {state: {Other: "open"}}`, /"Other" is on another screen than "Menu"/],
    [`"Menu", {hover: "Nope"}`, /No node "Nope"/],
    [`"Menu", {hover: 1}`, /hover must be true or a path/],
    [`"Menu", "open"`, /takes an options object/],
    [`page`, /is a page\. Pass a node/],
  ] as const) {
    const r = await run(SCREEN + `Motion(${args})`);
    assert.equal(r.ok, false, args);
    assert.match(r.text, message);
  }
  assert.equal(films.length, 0);
});

test("the report says when nothing animates, and why", async () => {
  report = { times: [0], duration: 0, tracks: [], hidden: 0, outside: 2, problems: ["Nothing inside Menu animated."], width: 1, height: 1 };
  const r = await ok(SCREEN + `Motion("Menu", {state: "open"})`);
  assert.match(r.text, /Motion Menu \(state closed → open\): nothing animates\n  2 animation\(s\) ran outside Menu\.\n  Problem: Nothing inside Menu animated\./);
});

test("a film sees what the snippet just built, and a failed render is a warning", async () => {
  const seen: string[] = [];
  exec = new Executor(
    store,
    {
      screenshot: async () => Buffer.alloc(0),
      layout: async () => ({ width: 1, height: 1, nodes: [], problems: [] }),
      film: async (d) => {
        seen.push(d.pages[0].children[0].name!);
        throw new Error("no browser");
      },
    },
    iconDir,
    () => "",
  );
  const r = await ok(`Insert(page, {name: "Fresh"}); Motion("Fresh")`);
  assert.deepEqual(seen, ["Fresh"]);
  assert.match(r.text, /Rendering failed: no browser/);
  assert.equal(doc().pages[0].children.length, 1, "the design is saved even so");
});
