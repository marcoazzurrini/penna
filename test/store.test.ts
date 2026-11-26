import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/server/store.ts";
import type { PennaDoc, PennaNode } from "../src/shared/types.ts";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penna-store-"));
  const store = new Store(root);
  store.ensureDir();
  const dir = path.join(root, ".penna");
  const file = (rel: string) => path.join(dir, rel);
  const write = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), typeof data === "string" ? data : JSON.stringify(data));
  };
  return { root, store, file, write };
}

const frame = (id: string, extra: Partial<PennaNode> = {}): PennaNode => ({ id, type: "frame", name: id, ...extra });
const docOf = (pages: Record<string, PennaNode[]>, variables: Record<string, string> = {}): PennaDoc => ({
  version: 2,
  variables,
  pages: Object.entries(pages).map(([id, children]) => ({ id, name: id, children })),
});

test("commit writes only the pages named as touched", () => {
  const { store, file } = setup();
  store.commit(docOf({ a: [frame("a1")], b: [frame("b1")] }));
  const before = fs.readFileSync(file("pages/a.json"), "utf8");
  // Page "a" differs here, but the caller says only "b" changed.
  store.commit(docOf({ a: [frame("ignored")], b: [frame("b2")] }), new Set(["b"]));
  assert.equal(fs.readFileSync(file("pages/a.json"), "utf8"), before);
  assert.deepEqual(store.get().pages.map((p) => p.children[0].id), ["a1", "b2"]);
});

test("pages keep their objects until their file changes", () => {
  const { store } = setup();
  store.commit(docOf({ a: [frame("a1")], b: [frame("b1")] }));
  const [a, b] = store.get().pages;
  store.commit(docOf({ a: [frame("a1")], b: [frame("b2")] }));
  assert.equal(store.get().pages[0], a);
  assert.notEqual(store.get().pages[1], b);
  assert.ok(Object.isFrozen(a.children[0]));
});

test("a page with git conflict markers is not deleted by the next commit", () => {
  const { root, file, write } = setup();
  new Store(root).commit(docOf({ a: [frame("a1")], b: [frame("b1")] }));
  const conflicted = "<<<<<<< HEAD\n" + fs.readFileSync(file("pages/a.json"), "utf8") + "=======\n>>>>>>> theirs\n";
  write("pages/a.json", conflicted);

  const store = new Store(root);
  assert.deepEqual(store.get().pages.map((p) => p.id), ["b"]);
  assert.match(store.problems()[0], /pages\/a\.json is ignored: it has git conflict markers/);
  assert.deepEqual(store.reservedPageIds(), ["a"]);

  store.commit(docOf({ b: [frame("b2")] }));
  assert.equal(fs.readFileSync(file("pages/a.json"), "utf8"), conflicted);
  // A commit that would replace the broken file is refused, and writes nothing.
  assert.throws(() => store.commit(docOf({ a: [frame("new")], b: [frame("b3")] })), /pages\/a\.json is broken/);
  assert.equal(store.get().pages[0].children[0].id, "b2");
});

test("a broken project.json blocks commits instead of losing variables", () => {
  const { root, file, write } = setup();
  new Store(root).commit(docOf({ a: [frame("a1")] }, { accent: "#f00" }));
  write("project.json", '{"version": 2, "pages": ["a"], "variables": {"accent": ');
  const store = new Store(root);
  assert.deepEqual(store.get().pages.map((p) => p.id), ["a"]);
  assert.throws(() => store.commit(docOf({ a: [frame("a2")] })), /project\.json is broken/);
  assert.match(fs.readFileSync(file("project.json"), "utf8"), /"accent": $/);
  assert.equal(JSON.parse(fs.readFileSync(file("pages/a.json"), "utf8")).children[0].id, "a1");
});

test("files with values of the wrong kind are reported, not rendered", () => {
  const { store, write } = setup();
  write("pages/a.json", { version: 2, name: "A", children: [{ id: "n1", type: "frame", class: ["flex"] }] });
  write("pages/b.json", { version: 2, name: "B", children: [frame("dup"), frame("dup")] });
  write("pages/c.json", { version: 2, name: "C", children: [frame("ok", { children: [{ id: "t", type: "text", text: "hi" }] })] });
  assert.deepEqual(store.get().pages.map((p) => p.id), ["c"]);
  const problems = store.problems().join("\n");
  assert.match(problems, /pages\/a\.json is ignored: node n1: class must be a string/);
  assert.match(problems, /pages\/b\.json is ignored: node dup: the id is used twice/);
});

test("sync picks up outside edits, and keeps the last good version of a file that breaks", () => {
  const { store, write, file } = setup();
  store.commit(docOf({ a: [frame("a1")] }));
  const changes: Set<string>[] = [];
  store.on("change", (files: Set<string>) => changes.push(files));

  write("pages/a.json", { version: 2, name: "A", children: [frame("outside")] });
  write("pages/new.json", { version: 2, name: "New", children: [] });
  store.sync(["pages/a.json", "pages/new.json"]);
  assert.deepEqual(store.get().pages.map((p) => [p.id, p.children[0]?.id]), [["a", "outside"], ["new", undefined]]);
  assert.deepEqual([...changes[0]].sort(), ["pages/a.json", "pages/new.json"]);

  // A half-written or conflicted file: keep showing the last good version, and say so.
  write("pages/a.json", "{ not json");
  store.sync();
  assert.equal(store.get().pages[0].children[0].id, "outside");
  assert.equal(store.problems().length, 1);
  assert.equal(changes.length, 2, "viewers are told about the problem");
  store.sync();
  assert.equal(changes.length, 2, "an unchanged broken file is not reported again");

  write("pages/a.json", { version: 2, name: "A", children: [frame("fixed")] });
  store.sync(["pages/a.json"]);
  assert.equal(store.get().pages[0].children[0].id, "fixed");
  assert.deepEqual(store.problems(), []);

  fs.rmSync(file("pages/new.json"));
  store.sync(["pages/new.json"]);
  assert.deepEqual(store.get().pages.map((p) => p.id), ["a"]);
});

test("an outside edit clears redo, and can itself be undone", () => {
  const { store, write } = setup();
  store.commit(docOf({ p: [frame("one")] }));
  store.commit(docOf({ p: [frame("two")] }));
  store.undo();
  write("pages/p.json", { version: 2, name: "p", children: [frame("outside")] });
  store.sync();
  assert.equal(store.redo(), false);
  assert.equal(store.get().pages[0].children[0].id, "outside");
  assert.equal(store.undo(), true);
  assert.equal(store.get().pages[0].children[0].id, "one");
});

test("undo that would overwrite a broken file does nothing and keeps its history", () => {
  const { store, write, file } = setup();
  store.commit(docOf({ p: [frame("one")] }));
  store.commit(docOf({ p: [frame("two")] }));
  const good = fs.readFileSync(file("pages/p.json"), "utf8");
  write("pages/p.json", "<<<<<<< HEAD\n" + good);
  store.sync();
  assert.equal(store.undo(), false);
  assert.equal(fs.readFileSync(file("pages/p.json"), "utf8"), "<<<<<<< HEAD\n" + good);
  // Once the file is whole again, the same undo step works.
  write("pages/p.json", good);
  store.sync();
  assert.equal(store.undo(), true);
  assert.equal(store.get().pages[0].children[0].id, "one");
});

test("the watcher syncs outside edits on its own", async () => {
  const { store, write } = setup();
  store.commit(docOf({ a: [frame("a1")] }));
  store.watch();
  try {
    const changed = new Promise((resolve) => store.once("change", resolve));
    write("pages/a.json", { version: 2, name: "A", children: [frame("watched")] });
    await changed;
    assert.equal(store.get().pages[0].children[0].id, "watched");
  } finally {
    store.unwatch();
  }
});
