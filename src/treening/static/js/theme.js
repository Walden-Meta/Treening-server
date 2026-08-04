(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TreeningTheme = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const STORAGE_KEY = "treening-theme";
  const DARK_QUERY = "(prefers-color-scheme: dark)";

  function resolveTheme(storedTheme, prefersDark) {
    if (storedTheme === "dark" || storedTheme === "light") return storedTheme;
    return prefersDark ? "dark" : "light";
  }

  function updateButtons(theme) {
    if (!root?.document) return;
    root.document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      const dark = theme === "dark";
      button.textContent = dark ? "日间" : "深夜";
      button.setAttribute("aria-label", dark ? "切换到日间模式" : "切换到深夜模式");
      button.setAttribute("aria-pressed", String(dark));
    });
  }

  function applyTheme(theme, persist = false) {
    if (!root?.document) return theme;
    root.document.documentElement.dataset.theme = theme;
    root.document.documentElement.style.colorScheme = theme;
    if (persist) root.localStorage?.setItem(STORAGE_KEY, theme);
    updateButtons(theme);
    return theme;
  }

  function currentTheme() {
    return root?.document?.documentElement?.dataset?.theme || "light";
  }

  function toggleTheme() {
    return applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
  }

  function init() {
    if (!root?.document) return "light";
    const media = root.matchMedia?.(DARK_QUERY);
    const stored = root.localStorage?.getItem(STORAGE_KEY);
    const theme = applyTheme(resolveTheme(stored, Boolean(media?.matches)));
    const wire = () => {
      updateButtons(currentTheme());
      root.document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
        if (button.dataset.themeWired === "true") return;
        button.dataset.themeWired = "true";
        button.addEventListener("click", toggleTheme);
      });
    };
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", wire, { once: true });
    else wire();
    media?.addEventListener?.("change", (event) => {
      if (!root.localStorage?.getItem(STORAGE_KEY)) applyTheme(event.matches ? "dark" : "light");
    });
    return theme;
  }

  if (root?.document) init();
  return { STORAGE_KEY, resolveTheme, applyTheme, currentTheme, toggleTheme, init };
});
