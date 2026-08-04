const test = require("node:test");
const assert = require("node:assert/strict");
const { createHorizontalGeometry, resolveOverlaps } = require("../src/treening/static/js/layout-state.js");

function node(id) { return { id }; }

test("three-way layout aligns the parent with the middle branch without equal-width slots", () => {
  const children = new Map([
    ["root", [node("left"), node("middle"), node("right")]],
    ["left", []], ["middle", []], ["right", []],
  ]);
  const widths = new Map([["root", 300], ["left", 900], ["middle", 300], ["right", 300]]);
  const geometry = createHorizontalGeometry(children, (id) => widths.get(id), { siblingGap: 68 });
  const root = geometry.measure("root");
  const middleRoot = geometry.measure("left").width + 68 + geometry.measure("middle").rootOffset + root.childInset;
  assert.equal(root.rootOffset, middleRoot);
  assert.ok(root.width < 1800, `expected compact width, received ${root.width}`);
});

test("single-child chains keep identical horizontal roots", () => {
  const children = new Map([["a", [node("b")]], ["b", [node("c")]], ["c", []]]);
  const geometry = createHorizontalGeometry(children, () => 300);
  assert.equal(geometry.measure("a").rootOffset, geometry.measure("b").rootOffset);
  assert.equal(geometry.measure("b").rootOffset, geometry.measure("c").rootOffset);
});

test("adjacent subtree bounds retain the requested gap", () => {
  const children = new Map([["root", [node("a"), node("b")]], ["a", []], ["b", []]]);
  const geometry = createHorizontalGeometry(children, (id) => id === "a" ? 460 : 300, { siblingGap: 68 });
  const a = geometry.measure("a");
  const bStart = geometry.measure("root").childInset + a.width + 68;
  assert.equal(bStart - (geometry.measure("root").childInset + a.width), 68);
});

test("resize avoidance leaves a non-overlapping layout untouched", () => {
  const result = resolveOverlaps([
    { id: "anchor", x: 200, y: 200, width: 300, height: 180 },
    { id: "other", x: 700, y: 200, width: 300, height: 180 },
  ], "anchor", { gap: 40 });
  assert.deepEqual(result.movedIds, []);
  assert.equal(result.unresolved, 0);
});

test("resize avoidance pins the resized node and pushes a covered child downward", () => {
  const result = resolveOverlaps([
    { id: "anchor", x: 300, y: 300, width: 340, height: 620 },
    { id: "child", x: 300, y: 560, width: 300, height: 180 },
  ], "anchor", { gap: 40 });
  assert.deepEqual(result.positions.get("anchor"), { x: 300, y: 300 });
  assert.ok(result.positions.get("child").y > 720);
  assert.deepEqual(result.movedIds, ["child"]);
  assert.equal(result.unresolved, 0);
});

test("resize avoidance separates same-level cards horizontally", () => {
  const result = resolveOverlaps([
    { id: "anchor", x: 400, y: 300, width: 500, height: 180 },
    { id: "sibling", x: 620, y: 300, width: 300, height: 180 },
  ], "anchor", { gap: 40 });
  assert.ok(result.positions.get("sibling").x >= 840);
  assert.equal(result.unresolved, 0);
});
