import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeProblem, pageFileProblem, projectFileProblem, propProblem } from "../src/shared/schema.ts";

test("valid nodes pass, including unknown properties", () => {
  const node = {
    id: "a", type: "frame", name: "A", x: 0, y: 10, class: "flex", style: { width: 10, color: "red" }, component: true, futureKey: { any: 1 },
    children: [
      { id: "b", type: "text", spans: [{ text: "hi", style: { color: "red" }, class: "x" }] },
      { id: "c", type: "ref", ref: "a", overrides: { Title: { text: "T", style: { color: null }, hidden: null, children: [{ id: "d", type: "frame" }] } } },
    ],
  };
  assert.equal(nodeProblem(node, new Set()), null);
});

test("each kind of bad value is named", () => {
  const cases: [unknown, RegExp][] = [
    [{ type: "frame" }, /id must be a non-empty string/],
    [{ id: "a", type: "box" }, /unknown node type "box"/],
    [{ id: "a", type: "frame", class: ["x"] }, /node a: class must be a string/],
    [{ id: "a", type: "frame", x: "1" }, /x must be a number/],
    [{ id: "a", type: "frame", hidden: 1 }, /hidden must be true or false/],
    [{ id: "a", type: "frame", style: { width: {} } }, /style\.width must be a string or number/],
    [{ id: "a", type: "frame", style: { width: null } }, /style\.width/],
    [{ id: "a", type: "text", spans: [{ style: {} }] }, /each span needs a text string/],
    [{ id: "a", type: "ref", overrides: { T: { class: 5 } } }, /override "T": class must be a string/],
    [{ id: "a", type: "frame", children: [{ id: "b", type: "frame", children: [{ id: "a", type: "frame" }] }] }, /node a: the id is used twice/],
    [{ id: "a", type: "frame", children: {} }, /children must be an array/],
    ["text", /expected a node object/],
  ];
  for (const [node, want] of cases) assert.match(nodeProblem(node, new Set()) ?? "", want, JSON.stringify(node));
});

test("patches may delete with null, nodes may not hold bad values", () => {
  assert.equal(propProblem("class", null, true), null);
  assert.equal(propProblem("style", { color: null }, true), null);
  assert.match(propProblem("style", { color: null }) ?? "", /style\.color/);
});

test("page and project files", () => {
  assert.equal(pageFileProblem({ version: 2, name: "A", children: [] }), null);
  assert.equal(pageFileProblem({}), null);
  assert.match(pageFileProblem([]) ?? "", /expected an object/);
  assert.match(pageFileProblem({ name: 5 }) ?? "", /name must be a string/);
  assert.equal(projectFileProblem({ version: 2, pages: ["a"], variables: { a: "1" }, themes: { dark: { a: "2" } } }), null);
  assert.match(projectFileProblem({ pages: [1] }) ?? "", /pages must be an array of page ids/);
  assert.match(projectFileProblem({ variables: { a: 1 } }) ?? "", /variables\.a must be a string/);
  assert.match(projectFileProblem({ themes: { dark: { a: [] } } }) ?? "", /themes\.dark\.a must be a string/);
});
