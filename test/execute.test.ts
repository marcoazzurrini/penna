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

const run = (code: string, file = "design") => exec.run({ code, file });
const doc = () => store.get("design")!;

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
  const fixed = await exec.run({ file: "design", editId: bad.editId, edits: [{ find: `Update("missing", {})`, replace: `Print("ok")` }] });
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

test("invalid file names are rejected", async () => {
  const r = await run(`Print(1)`, "../escape");
  assert.equal(r.ok, false);
  assert.equal(store.get("../escape"), undefined);
});

test("instances can use components from another file", async () => {
  const lib = await run(`
    SetVariables({accent: "#f00"})
    Insert(page, {name: "Badge", component: true, children: [{name: "Label", text: "New"}]})
    Insert(page, {name: "Card", component: true, children: [{name: "Title", text: "T"}, {ref: "Badge"}]})`, "ds");
  assert.equal(lib.ok, true, lib.text);
  const card = store.get("ds")!.pages[0].children[1];
  assert.equal(card.children![1].ref, store.get("ds")!.pages[0].children[0].id);

  const r = await run(`
    inst = Insert(page, {ref: "ds#Card", overrides: {Title: {text: "Hello"}}})
    Print(Get(inst + "/Title").text)
    Print(JSON.stringify(Components().map((c) => c.ref)))
    Print(Tree())`);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^Hello/);
  assert.match(r.text, /"ds#\w+"/);
  assert.match(r.text, /→ds#Card/);
  assert.equal(doc().pages[0].children[0].ref, `ds#${card.id}`);
  assert.equal(doc().pages[0].children[0].name, "Card");
  assert.doesNotMatch(r.text, /Warnings/);

  // The render document carries the library components, with nested refs made absolute,
  // and the library's variables.
  const { withLibraries } = await import("../src/server/libs.ts");
  const { doc: rd, files } = withLibraries(store, "design", doc());
  assert.deepEqual([...files], ["ds"]);
  assert.equal(rd.variables?.accent, "#f00");
  assert.equal(rd.libs![`ds#${card.id}`].children![1].ref, `ds#${store.get("ds")!.pages[0].children[0].id}`);
  assert.ok(rd.libs![rd.libs![`ds#${card.id}`].children![1].ref!]);
});

test("refs to missing files or components fail with a hint", async () => {
  const noFile = await run(`Insert(page, {ref: "nope#Card"})`);
  assert.equal(noFile.ok, false);
  assert.match(noFile.text, /No design file "nope"/);
  await run(`Insert(page, {name: "X"})`, "ds");
  const noComp = await run(`Insert(page, {ref: "ds#Card"})`);
  assert.match(noComp.text, /No component "Card" in "ds"/);
});

test("Icons finds names by word and tag, and unknown icons suggest matches", async () => {
  // "home" is an old alias of "house".
  const r = await run(`Print(Icons("home")[0], Icons("credit card")[0])`);
  assert.match(r.text, /^house credit-card/);
  const w = await run(`Insert(page, {icon: "logout"})`);
  assert.match(w.text, /Unknown Lucide icon "logout"\. Close matches: log-out/);
});
