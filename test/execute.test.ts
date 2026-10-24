import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { Executor } from "../src/server/execute.ts";
import { Headless } from "../src/server/headless.ts";
import { resolveDep } from "../src/server/paths.ts";
import { Store } from "../src/server/store.ts";
import type { PennaNode } from "../src/shared/types.ts";

const iconDir = path.join(resolveDep("lucide-static"), "icons");
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
