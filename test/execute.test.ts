import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { Executor } from "../src/server/execute.ts";
import { Headless, type LayoutReport, type Renderer } from "../src/server/headless.ts";
import { resolveDep } from "../src/server/paths.ts";
import { Store } from "../src/server/store.ts";
import type { PennaDoc, PennaNode } from "../src/shared/types.ts";

// Every run checks that the working copy's indexes still match its document.
process.env.PENNA_VERIFY_INDEX = "1";

const iconDir = path.join(resolveDep("lucide-static"), "icons");

/** A renderer that answers after `delay` ms and records the documents it was given. */
function fakeRenderer(delay = 0) {
  const seen: PennaDoc[] = [];
  const report: LayoutReport = { width: 1, height: 1, nodes: [], problems: [] };
  const renderer: Renderer = {
    screenshot: async () => Buffer.alloc(0),
    layout: async (doc) => {
      seen.push(structuredClone(doc));
      await new Promise((r) => setTimeout(r, delay));
      return report;
    },
  };
  return { renderer, seen };
}

const withRenderer = (renderer: Renderer) => (exec = new Executor(store, renderer, iconDir, () => "http://localhost:0"));
let store: Store;
let exec: Executor;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penna-test-"));
  store = new Store(root);
  exec = new Executor(store, new Headless(() => ""), iconDir, () => "http://localhost:0");
});

const run = (code: string) => exec.run({ code });
const doc = () => store.get();

test("Insert builds a nested tree and infers node types", async () => {
  const r = await run(`home = Insert(page, {name: "Home", style: {width: 1440}, children: [
    {name: "Title", text: "Hi"}, {icon: "house"}, {src: "a.png"}, "plain string"
  ]})`);
  assert.equal(r.ok, true, r.text);
  const home = doc().pages[0].children[0];
  assert.deepEqual(home.children!.map((c) => c.type), ["text", "icon", "image", "text"]);
  assert.match(r.text, /Title=\w+/);
  assert.match(r.text, /Home=\w+/);
  assert.equal(home.x, 0);
});

test("a failed call changes nothing and can be fixed with edits", async () => {
  await run(`Insert(page, {name: "A"})`);
  const before = JSON.stringify(doc());
  const bad = await run(`Insert(page, {name: "B"}); Update("missing", {})`);
  assert.equal(bad.ok, false);
  assert.equal(JSON.stringify(doc()), before);
  const fixed = await exec.run({ editId: bad.editId, edits: [{ find: `Update("missing", {})`, replace: `Print("ok")` }] });
  assert.equal(fixed.ok, true, fixed.text);
  assert.deepEqual(doc().pages[0].children.map((n) => n.name), ["A", "B"]);
});

test("Update merges style and null deletes a key", async () => {
  await run(`Insert(page, {name: "Box", style: {width: 10, color: "red"}})`);
  await run(`Update("Box", {style: {color: null, background: "blue"}})`);
  assert.deepEqual(doc().pages[0].children[0].style, { width: 10, background: "blue" });
});

test("instance paths write overrides", async () => {
  const r = await run(`
    card = Insert(page, {name: "Card", component: true, children: [{name: "Title", text: "Title"}]})
    inst = Insert(page, {ref: card})
    Update(inst + "/Title", {text: "Changed"})
    Print(Get(inst + "/Title").text)`);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^Changed/);
  const inst = doc().pages[0].children[1] as PennaNode;
  assert.deepEqual(inst.overrides, { Title: { text: "Changed" } });
});

test("names may contain slashes and win over page names", async () => {
  const r = await run(`
    Update(page, {name: "Screens"})
    Insert(page, {name: "Screens"})
    Insert(page, {name: "Row / Course", children: [{name: "Title", text: "x"}]})
    Update("Row / Course", {style: {width: 5}})
    Update("Row / Course/Title", {text: "y"})
    Update("Screens", {style: {width: 7}})`);
  assert.equal(r.ok, true, r.text);
  const [screens, row] = doc().pages[0].children;
  assert.equal(screens.style?.width, 7);
  assert.equal(row.style?.width, 5);
  assert.equal(row.children![0].text, "y");
});

test("Page() switches the live page global", async () => {
  const r = await run(`const first = page; Page("Second"); Print(page !== first); Insert(page, {name: "On second"})`);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^true/);
  assert.equal(doc().pages[1].children[0].name, "On second");
});

test("text spans are kept", async () => {
  await run(`Insert(page, {name: "Code", spans: [{text: "const", style: {color: "#f0f"}}, " x"]})`);
  const n = doc().pages[0].children[0];
  assert.equal(n.type, "text");
  assert.deepEqual(n.spans, [{ text: "const", style: { color: "#f0f" } }, { text: " x" }]);
});

test("each page is its own file, and project.json keeps order and variables", async () => {
  const r = await run(`
    SetVariables({accent: "#f00"})
    Update(page, {name: "Foundations"})
    Insert(page, {name: "Card", component: true, children: [{name: "Title", text: "T"}]})
    Page("Sign in")
    Insert(page, {name: "Screen", children: [{ref: "Card", overrides: {Title: {text: "Hi"}}}]})
    Print(Get("Screen/Card/Title").text)`);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^Hi/);
  const dir = path.join(store.root, ".penna");
  assert.deepEqual(fs.readdirSync(path.join(dir, "pages")).sort(), ["page-1.json", "sign-in.json"]);
  const project = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  assert.deepEqual(project.pages, ["page-1", "sign-in"]);
  assert.equal(project.variables.accent, "#f00");
  const signIn = JSON.parse(fs.readFileSync(path.join(dir, "pages", "sign-in.json"), "utf8"));
  assert.equal(signIn.name, "Sign in");

  // A component on one page can be used on another, by name.
  const inst = doc().pages[1].children[0].children![0];
  assert.equal(inst.ref, doc().pages[0].children[0].id);
  assert.equal(inst.name, "Card");
  assert.doesNotMatch(r.text, /Warnings/);

  // An edit rewrites only the page it touches.
  const before = fs.statSync(path.join(dir, "pages", "page-1.json")).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await run(`Page("Sign in"); Update("Screen", {style: {width: 390}})`);
  assert.equal(fs.statSync(path.join(dir, "pages", "page-1.json")).mtimeMs, before);

  await run(`DeletePage("Sign in")`);
  assert.deepEqual(fs.readdirSync(path.join(dir, "pages")), ["page-1.json"]);
  assert.equal(store.undo(), true);
  assert.deepEqual(fs.readdirSync(path.join(dir, "pages")).sort(), ["page-1.json", "sign-in.json"]);
  assert.equal(doc().pages[1].name, "Sign in");
});

test("penna 0.1 files are merged into pages once, with a backup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penna-v1-"));
  const dir = path.join(root, ".penna");
  fs.mkdirSync(dir);
  const v1 = (pages: string[], variables = {}) =>
    JSON.stringify({ version: 1, variables, pages: pages.map((name, i) => ({ id: "p" + i, name, children: [{ id: name + "n", type: "frame", name }] })) });
  fs.writeFileSync(path.join(dir, "app.json"), v1(["Home", "Settings"], { a: "1" }));
  fs.writeFileSync(path.join(dir, "ds.json"), v1(["Home"], { b: "2" }));
  const d = new Store(root).get();
  assert.deepEqual(d.pages.map((p) => [p.id, p.name]), [["home", "Home"], ["settings", "Settings"], ["home-2", "Home"]]);
  assert.deepEqual(d.variables, { a: "1", b: "2" });
  assert.deepEqual(fs.readdirSync(path.join(dir, ".v1-backup")).sort(), ["app.json", "ds.json"]);
  assert.ok(!fs.existsSync(path.join(dir, "app.json")));
});

test("Icons finds names by word and tag, and unknown icons suggest matches", async () => {
  // "home" is an old alias of "house".
  const r = await run(`Print(Icons("home")[0], Icons("credit card")[0])`);
  assert.match(r.text, /^house credit-card/);
  const w = await run(`Insert(page, {icon: "logout"})`);
  assert.match(w.text, /Unknown Lucide icon "logout"\. Close matches: log-out/);
});

test("values of the wrong kind fail the call and are never saved", async () => {
  const bad = await run(`Insert(page, {name: "X", class: ["flex", "gap-2"]})`);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /Class must be a string/);
  assert.equal(doc().pages[0].children.length, 0);

  await run(`Insert(page, {name: "X"})`);
  for (const patch of [`{hidden: "yes"}`, `{x: "left"}`, `{children: "none"}`, `{overrides: {A: 1}}`]) {
    const r = await run(`Update("X", ${patch})`);
    assert.equal(r.ok, false, patch);
  }
  const typed = await run(`Insert(page, {type: "button"})`);
  assert.match(typed.text, /Unknown node type "button"/);

  // Numbers for text and names are a harmless slip, and bad style values are dropped with a warning.
  const ok = await run(`Insert(page, {name: 7, text: 42, style: {width: NaN, color: "red"}})`);
  assert.equal(ok.ok, true, ok.text);
  assert.match(ok.text, /Ignored style\.width/);
  const n = doc().pages[0].children[1];
  assert.deepEqual([n.name, n.text, n.style], ["7", "42", { color: "red" }]);
});

test("calls that overlap run in order and keep each other's work", async () => {
  withRenderer(fakeRenderer(40).renderer);
  await run(`Insert(page, {name: "First"})`);
  const [slow, fast] = await Promise.all([run(`await Layout("First"); Insert(page, {name: "Slow"})`), run(`Insert(page, {name: "Fast"}); Print(Tree())`)]);
  assert.equal(slow.ok && fast.ok, true);
  assert.deepEqual(doc().pages[0].children.map((n) => n.name), ["First", "Slow", "Fast"]);
  // The second call saw what the first one saved.
  assert.match(fast.text, /Slow/);
});

test("an endless loop before the first await is stopped", async () => {
  exec.limits.sync = 150;
  const r = await run(`Insert(page, {name: "A"}); for (;;) {}`);
  assert.equal(r.ok, false);
  assert.match(r.text, /too long/);
  assert.equal(doc().pages[0].children.length, 0);
  assert.equal((await run(`Print("still alive")`)).ok, true);
});

test("a snippet that waits forever fails when its time is up", async () => {
  exec.limits.total = 100;
  const r = await run(`Insert(page, {name: "A"}); await new Promise(() => {})`);
  assert.equal(r.ok, false);
  assert.match(r.text, /did not finish within 0\.1 s/);
  assert.equal(doc().pages[0].children.length, 0);
  assert.equal((await run(`Print("still alive")`)).ok, true);
});

test("a snippet that outlives its run cannot change a later one", async () => {
  withRenderer(fakeRenderer(200).renderer);
  await run(`Insert(page, {name: "A"})`);
  exec.limits.total = 50;
  const late = await run(`await Layout("A"); Insert(page, {name: "Zombie"})`);
  assert.equal(late.ok, false);
  assert.match(late.text, /did not finish/);
  exec.limits.total = 5000;
  // This run is still going when the first snippet wakes up.
  const next = await run(`await Layout("A"); await Layout("A"); Insert(page, {name: "Next"})`);
  assert.equal(next.ok, true, next.text);
  assert.deepEqual(doc().pages[0].children.map((n) => n.name), ["A", "Next"]);
});

test("Layout renders the snippet's own changes", async () => {
  const fake = fakeRenderer();
  withRenderer(fake.renderer);
  const r = await run(`const id = Insert(page, {name: "New", class: "w-[321px]"}); await Layout(id)`);
  assert.equal(r.ok, true, r.text);
  assert.equal(fake.seen[0].pages[0].children[0].class, "w-[321px]");
});

test("a call copies only the pages it changes, and reads copy nothing", async () => {
  await run(`Insert(page, {name: "One"}); Page("Second"); Insert(page, {name: "Two"})`);
  const [first, second] = doc().pages;
  const rev = store.rev;
  const read = await run(`Print(Tree()); Print(Get("Two").name); Find(n => n.name === "One")`);
  assert.equal(read.ok, true, read.text);
  assert.equal(store.rev, rev);
  assert.equal(doc().pages[0], first);

  await run(`Update("Two", {style: {width: 5}})`);
  assert.equal(doc().pages[0], first, "the untouched page keeps its object");
  assert.notEqual(doc().pages[1], second);
  assert.equal(doc().pages[1].children[0].style?.width, 5);
  // The stored document cannot be changed by accident.
  assert.throws(() => (doc().pages[0].children[0].name = "x"), TypeError);
});

test("ids and names resolve through every kind of change", async () => {
  const r = await run(`
    a = Insert(page, {name: "A", children: [{name: "Row", children: [{name: "Cell", text: "1"}]}, {name: "Row2"}]})
    Page("Other")
    b = Insert(page, {name: "B", children: [{name: "Slot"}]})
    Move("Row", "Slot")                       // across pages, by name
    Print(Get("B/Slot/Row/Cell").text)
    copy = Copy("Row", "A", {name: "RowCopy"})  // back to the first page
    Update("RowCopy/Cell", {name: "Renamed", text: "2"})
    Print(Get("Renamed").text)
    Replace("Row2", {name: "Row3", children: [{name: "Deep"}]})
    Update("Row3", {children: [{name: "Deeper"}]})
    Delete("Slot")
    Print(["Cell", "Row2", "Deep", "Slot", "Row"].map(n => { try { Get(n); return "found" } catch { return "gone" } }).join(","))
    Print(Get("Deeper").name, Get(copy).name)
    Page("Third"); Insert(page, {name: "C"}); DeletePage("Third")
    Print(Find(n => n.name === "C").length)`);
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(r.text.split("\n").slice(0, 5), ["1", "2", "gone,gone,gone,gone,gone", "Deeper RowCopy", "0"]);
  assert.deepEqual(doc().pages.map((p) => p.id), ["page-1", "other"]);
});

test("a broken page file is kept, reported, and never overwritten", async () => {
  await run(`Update(page, {name: "Alpha"}); Insert(page, {name: "A"}); Page("Beta"); Insert(page, {name: "B"})`);
  const file = path.join(store.root, ".penna", "pages", "beta.json");
  const conflicted = "<<<<<<< HEAD\n" + fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, conflicted);
  store = new Store(store.root);
  withRenderer(new Headless(() => ""));
  assert.deepEqual(doc().pages.map((p) => p.id), ["page-1"]);

  const r = await run(`Insert(page, {name: "C"}); Print(Page("Beta"))`);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^beta-2/, "the broken file's id is not reused");
  assert.match(r.text, /pages\/beta\.json is ignored: it has git conflict markers/);
  assert.equal(fs.readFileSync(file, "utf8"), conflicted);
});
