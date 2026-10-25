import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { Executor } from "../src/server/execute.ts";
import { Headless } from "../src/server/headless.ts";
import { resolveDep } from "../src/server/paths.ts";
import { Store } from "../src/server/store.ts";
import { Tailwind } from "../src/server/tailwind.ts";
import { Wire } from "../src/server/wire.ts";
import type { DocMessage } from "../src/shared/wire.ts";

let tailwind: Tailwind;
before(async () => {
  tailwind = await Tailwind.create();
});

/** A store and executor whose change events are turned into wire messages. */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penna-wire-"));
  const store = new Store(root);
  const exec = new Executor(store, new Headless(() => ""), path.join(resolveDep("lucide-static"), "icons"), () => "http://localhost:0");
  const wire = new Wire("test", tailwind);
  wire.update(store.get(), store.rev);
  const sent: DocMessage[] = [];
  store.on("change", (files: Set<string>) => sent.push(wire.update(store.get(), store.rev, files)));
  const run = async (code: string) => {
    const r = await exec.run({ code });
    assert.equal(r.ok, true, r.text);
    return sent.at(-1)!;
  };
  return { store, wire, run, last: () => sent.at(-1)! };
}

const names = (msg: DocMessage) => msg.nodes.map((n) => n.node.name);

test("updates carry only the top-level nodes that changed", async () => {
  const { run } = setup();
  await run(`Insert(page, {name: "A", class: "p-4"}); Insert(page, {name: "B"})`);
  const msg = await run(`Update("B", {text: "x"})`);
  assert.equal(msg.full, false);
  assert.deepEqual(names(msg), ["B"]);
  assert.deepEqual(msg.pages[0].nodes.length, 2);
});

test("a change inside a frame resends that frame only", async () => {
  const { run } = setup();
  await run(`Insert(page, {name: "A", children: [{name: "Inner", text: "1"}]}); Insert(page, {name: "B"})`);
  const msg = await run(`Update("Inner", {text: "2"})`);
  assert.deepEqual(names(msg), ["A"]);
});

test("pages whose files did not change send no nodes", async () => {
  const { run } = setup();
  await run(`Insert(page, {name: "A"}); other = Page("Other"); Insert(other, {name: "B"})`);
  const msg = await run(`Update("B", {text: "x"})`);
  assert.deepEqual(names(msg), ["B"]);
  assert.deepEqual(msg.pages.map((p) => p.nodes.length), [1, 1]);
});

test("css is sent only when new classes appear", async () => {
  const { run } = setup();
  const first = await run(`Insert(page, {name: "A", class: "p-4 w-[123px]"})`);
  assert.match(first.css ?? "", /\.p-4/);
  assert.match(first.css ?? "", /width: 123px/);
  const same = await run(`Update("A", {text: "x"})`);
  assert.equal(same.css, undefined);
  const added = await run(`Update("A", {class: "p-4 w-[123px] text-[#abcdef]"})`);
  assert.match(added.css ?? "", /#abcdef/);
});

test("undo sends the restored frame", async () => {
  const { store, run, last } = setup();
  await run(`Insert(page, {name: "A", text: "1"})`);
  await run(`Update("A", {text: "2"})`);
  store.undo();
  assert.equal(last().nodes.length, 1);
  assert.equal(last().nodes[0].node.text, "1");
});

test("a full message has every node and the stylesheet", async () => {
  const { store, wire, run } = setup();
  await run(`Insert(page, {name: "A", class: "flex"}); Insert(page, {name: "B"})`);
  const msg = wire.full(store.get(), store.rev);
  assert.equal(msg.full, true);
  assert.deepEqual(names(msg), ["A", "B"]);
  assert.match(msg.css ?? "", /\.flex/);
});
