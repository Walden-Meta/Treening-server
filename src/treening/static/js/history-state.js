(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TreeningHistoryState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function groupSessions(sessions, now = new Date()) {
    const groups = { today: [], recent: [], earlier: [], drafts: [] };
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const recentStart = todayStart - 6 * 24 * 60 * 60 * 1000;
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session || !session.id) continue;
      if (Number(session.node_count) <= 0) {
        groups.drafts.push(session);
        continue;
      }
      const timestamp = new Date(session.updated_at).getTime();
      if (!Number.isFinite(timestamp) || timestamp < recentStart) groups.earlier.push(session);
      else if (timestamp >= todayStart) groups.today.push(session);
      else groups.recent.push(session);
    }
    return groups;
  }

  function createUndoStack(limit = 30) {
    const capacity = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 30;
    const entries = [];
    return {
      push(entry) {
        if (entry == null) return entries.length;
        entries.push(entry);
        if (entries.length > capacity) entries.splice(0, entries.length - capacity);
        return entries.length;
      },
      pop() { return entries.pop() || null; },
      clear() { entries.length = 0; },
      get size() { return entries.length; },
    };
  }

  return { groupSessions, createUndoStack };
});
