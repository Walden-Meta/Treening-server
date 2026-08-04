const test = require("node:test");
const assert = require("node:assert/strict");
const { groupSessions, createUndoStack } = require("../src/treening/static/js/history-state.js");

const now = new Date("2026-08-04T12:00:00+08:00");

test("history separates active learning trajectories from empty drafts", () => {
  const groups = groupSessions([
    { id: "active", node_count: 5, updated_at: "2026-08-04T09:00:00+08:00" },
    { id: "draft", node_count: 0, updated_at: "2026-08-04T10:00:00+08:00" },
  ], now);
  assert.deepEqual(groups.today.map((item) => item.id), ["active"]);
  assert.deepEqual(groups.drafts.map((item) => item.id), ["draft"]);
});

test("history groups recent and earlier trajectories by local calendar distance", () => {
  const groups = groupSessions([
    { id: "recent", node_count: 2, updated_at: "2026-08-01T09:00:00+08:00" },
    { id: "old", node_count: 9, updated_at: "2026-07-20T09:00:00+08:00" },
  ], now);
  assert.deepEqual(groups.recent.map((item) => item.id), ["recent"]);
  assert.deepEqual(groups.earlier.map((item) => item.id), ["old"]);
});

test("malformed history records cannot break grouping", () => {
  const groups = groupSessions([{ id: "unknown", node_count: 1, updated_at: "bad" }, null], now);
  assert.deepEqual(groups.earlier.map((item) => item.id), ["unknown"]);
});

test("canvas undo stack restores actions in reverse order", () => {
  const history = createUndoStack(3);
  history.push({ action: "move" });
  history.push({ action: "fold" });
  assert.equal(history.size, 2);
  assert.deepEqual(history.pop(), { action: "fold" });
  assert.deepEqual(history.pop(), { action: "move" });
  assert.equal(history.pop(), null);
});

test("canvas undo stack keeps only its newest entries and can be cleared", () => {
  const history = createUndoStack(2);
  history.push("first");
  history.push("second");
  history.push("third");
  assert.equal(history.size, 2);
  assert.equal(history.pop(), "third");
  assert.equal(history.pop(), "second");
  history.push("new");
  history.clear();
  assert.equal(history.size, 0);
});
