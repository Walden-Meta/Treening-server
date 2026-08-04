"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveFoldState } = require("../src/treening/static/js/fold-state.js");

const nodes = [
  { id: "root", parent_id: null },
  { id: "a", parent_id: "root" },
  { id: "a1", parent_id: "a" },
  { id: "a2", parent_id: "a" },
  { id: "b", parent_id: "root" },
  { id: "b1", parent_id: "b" },
];

test("an ancestor fold makes a descendant fold latent and owns every card once", () => {
  const state = resolveFoldState(nodes, new Set(["a", "root"]));

  assert.deepEqual([...state.activeRoots], ["root"]);
  assert.deepEqual([...state.latentRoots], ["a"]);
  assert.deepEqual([...state.foldedAway], ["a", "a1", "a2", "b", "b1"]);
  for (const id of state.foldedAway) assert.equal(state.deckOwner.get(id), "root");
  assert.equal(state.deckOwner.size, state.foldedAway.size);
});

test("removing the ancestor intent reactivates the preserved descendant fold", () => {
  const state = resolveFoldState(nodes, new Set(["a"]));

  assert.deepEqual([...state.activeRoots], ["a"]);
  assert.deepEqual([...state.latentRoots], []);
  assert.deepEqual([...state.deckMembers.get("a")], ["a1", "a2"]);
  assert.equal(state.foldedAway.has("a"), false);
});

test("disjoint roots own disjoint decks", () => {
  const state = resolveFoldState(nodes, new Set(["a", "b"]));

  assert.deepEqual([...state.activeRoots], ["a", "b"]);
  assert.deepEqual([...state.deckMembers.get("a")], ["a1", "a2"]);
  assert.deepEqual([...state.deckMembers.get("b")], ["b1"]);
  assert.equal(state.deckOwner.get("a1"), "a");
  assert.equal(state.deckOwner.get("b1"), "b");
});

test("missing nodes and leaves cannot become fold roots", () => {
  const state = resolveFoldState(nodes, new Set(["missing", "a1"]));

  assert.deepEqual([...state.intents], []);
  assert.deepEqual([...state.activeRoots], []);
  assert.deepEqual([...state.foldedAway], []);
});
