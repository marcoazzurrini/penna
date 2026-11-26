import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { DocModel } from "../src/client/model.ts";
import { Executor } from "../src/server/execute.ts";
import { Headless } from "../src/server/headless.ts";
import { resolveDep } from "../src/server/paths.ts";
import { Store } from "../src/server/store.ts";
import { Tailwind } from "../src/server/tailwind.ts";
import { Wire } from "../src/server/wire.ts";
import { indexDoc, renderSubset } from "../src/shared/tree.ts";
import type { PennaNode } from "../src/shared/types.ts";

let tailwind: Tailwind;
before(async () => {
  tailwind = await Tailwind.create();
});

/** A server-side store wired to a viewer model, as the WebSocket would wire them. */
function setup() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "penna-model-")));
  const exec = new Executor(store, new Headless(() => ""), path.join(resolveDep("lucide-static"), "icons"), () => "");
  const wire = new Wire("test", tailwind);
  wire.update(store.get(), store.rev);
  const model = new DocModel();
  model.apply(wire.full(store.get(), store.rev));
  let changed = new Set<string>();
  store.on("change", (files: Set<string>) => (changed = model.apply(wire.update(store.get(), store.rev, files))));
  const run = async (code: string) => {
    const r = await exec.run({ code });
    assert.equal(r.ok, true, r.text);
    // The model must always match the server's document and a fresh index of it.
    assert.deepEqual(JSON.parse(JSON.stringify(model.doc)), JSON.parse(JSON.stringify(store.get())));
    const fresh = indexDoc(model.doc!);
    assert.deepEqual([...model.index.keys()].sort(), [...fresh.keys()].sort());
    for (const [id, loc] of fresh) {
      const have = model.index.get(id)!;
      assert.ok(have.node === loc.node && have.parent === loc.parent && have.page === loc.page && have.top === loc.top, `index entry for ${id}`);
    }
    return changed;
  };
  return { store, model, wire, run };
}

test("the model follows every kind of change and keeps its index right", async () => {
  const { run, model } = setup();
  await run(`a = Insert(page, {name: "A", children: [{name: "Kid", text: "1"}]}); b = Insert(page, {name: "B"})`);
  await run(`Update("Kid", {text: "2"})`);
  await run(`Move("Kid", "B")`);
  await run(`Page("Two"); c = Insert(page, {name: "C", children: [{name: "Deep", children: [{name: "Deeper"}]}]})`);
  await run(`Move("Deep", "A")`);
  await run(`Move(b, undefined, 0); Delete("Deeper")`);
  await run(`Replace(a, {name: "A2"})`);
  await run(`SetVariables({ink: "#000"}); SetVariables({ink: "#fff"}, "dark")`);
  assert.equal(model.themesKey, '{"dark":{"ink":"#fff"}}');
  await run(`DeletePage("Two")`);
  assert.deepEqual(model.doc!.pages.map((p) => p.children.map((n) => n.name)), [["B", "A2"]]);
});

test("unchanged frames and pages keep their objects, and only changed pages are reported", async () => {
  const { run, model } = setup();
  await run(`Insert(page, {name: "A"}); Insert(page, {name: "B"}); Page("Two"); Insert(page, {name: "C"})`);
  const [one, two] = model.doc!.pages;
  const [a, b] = one.children;
  const changed = await run(`Update("B", {style: {width: 5}})`);
  assert.deepEqual([...changed], ["page-1"]);
  assert.equal(model.doc!.pages[0], one);
  assert.equal(model.doc!.pages[1], two);
  assert.equal(one.children[0], a);
  assert.notEqual(one.children[1], b);
  assert.equal(model.index.get(a.id)!.page, one);

  assert.deepEqual([...(await run(`Update("two", {name: "Second"})`))], ["two"]);
  assert.deepEqual([...(await run(`SetVariables({x: "1"})`))], []);
  assert.deepEqual([...(await run(`Move("B", undefined, 0)`))], ["page-1"]);
});

test("a full message replaces what the model had", async () => {
  const { run, model, wire, store } = setup();
  await run(`Insert(page, {name: "A", children: [{name: "Kid"}]})`);
  const stale: PennaNode = { id: "stale", type: "frame" };
  model.index.set("stale", { node: stale, parent: model.doc!.pages[0], page: model.doc!.pages[0], top: stale });
  model.apply(wire.full(store.get(), store.rev));
  assert.equal(model.index.has("stale"), false);
  assert.equal(model.index.size, 2);
  assert.ok(model.hashOf("page-1", model.doc!.pages[0].children[0].id));
});

test("renderSubset keeps what a render needs and nothing else", async () => {
  const { run, store } = setup();
  await run(`
    Update(page, {name: "Foundations"})
    Insert(page, {name: "Button", component: true, children: [{name: "Label", text: "Go"}]})
    Insert(page, {name: "Card", component: true, children: [{name: "Action", ref: "Button"}]})
    Insert(page, {name: "Unused", component: true})
    Page("Screens")
    Insert(page, {name: "Home", children: [{name: "Hero", children: [{ref: "Card"}]}]})
    Insert(page, {name: "Other"})
    Insert(page, {name: "Swap", children: [{ref: "Unused", overrides: {x: {ref: "Button"}}}]})`);
  const doc = store.get();
  const index = indexDoc(doc);
  const names = (id: string) => renderSubset(doc, index, id).pages.map((p) => [p.id, p.children.map((n) => n.name)]);
  const idOf = (name: string) => [...index.values()].find((l) => l.node.name === name)!.node.id;

  // A nested node: its screen, plus the components it reaches, also through other components.
  assert.deepEqual(names(idOf("Hero")), [["page-1", ["Button", "Card"]], ["screens", ["Home"]]]);
  assert.deepEqual(names(idOf("Other")), [["screens", ["Other"]]]);
  // A ref set by an override counts too.
  assert.deepEqual(names(idOf("Swap")), [["page-1", ["Button", "Unused"]], ["screens", ["Swap"]]]);
  // A page: every screen on it.
  assert.deepEqual(names("screens"), [["page-1", ["Button", "Card", "Unused"]], ["screens", ["Home", "Other", "Swap"]]]);
  assert.deepEqual(names("missing"), []);
});
