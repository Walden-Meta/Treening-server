const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveViewState } = require("../src/treening/static/js/view-state.js");

const nodes = [
  { id: "root", parent_id: null },
  { id: "answer", parent_id: "root" },
  { id: "left", parent_id: "answer" },
  { id: "right", parent_id: "answer" },
  { id: "leaf", parent_id: "left" },
  { id: "next", parent_id: "leaf" },
  { id: "deep-side", parent_id: "right" },
];

test("tree mode preserves the complete node collection", () => {
  const result = resolveViewState(nodes, "leaf", "tree");
  assert.deepEqual(result.nodes.map((node) => node.id), nodes.map((node) => node.id));
  assert.equal(result.visibleIds.size, nodes.length);
  assert.deepEqual(result.pathIds, ["root", "answer", "left", "leaf"]);
});

test("path mode returns one ordered ancestor chain", () => {
  const result = resolveViewState(nodes, "leaf", "path");
  assert.deepEqual(result.pathIds, ["root", "answer", "left", "leaf"]);
  assert.equal(result.visibleIds.has("right"), false);
});

test("nearby mode adds one layer of siblings and immediate child branches", () => {
  const result = resolveViewState(nodes, "leaf", "nearby");
  assert.deepEqual(result.pathIds, ["root", "answer", "left", "leaf"]);
  assert.equal(result.visibleIds.has("right"), true);
  assert.equal(result.visibleIds.has("next"), true);
  assert.equal(result.visibleIds.has("deep-side"), false);
  assert.deepEqual([...result.nearbyIds].sort(), ["next", "right"]);
});

test("path mode falls back to the complete tree without a valid selection", () => {
  const result = resolveViewState(nodes, "missing", "path");
  assert.equal(result.nodes.length, nodes.length);
  assert.deepEqual(result.warnings, []);
});

test("path resolver terminates and reports malformed cycles", () => {
  const cyclic = [{ id: "a", parent_id: "b" }, { id: "b", parent_id: "a" }];
  const result = resolveViewState(cyclic, "a", "path");
  assert.equal(result.visibleIds.size, 2);
  assert.equal(result.warnings[0].type, "cycle");
});
