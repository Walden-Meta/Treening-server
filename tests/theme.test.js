const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveTheme } = require("../src/treening/static/js/theme.js");

test("stored theme overrides the system preference", () => {
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
});

test("theme follows the system when no explicit preference exists", () => {
  assert.equal(resolveTheme(null, true), "dark");
  assert.equal(resolveTheme(undefined, false), "light");
});
