(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TreeningViewState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function resolveViewState(nodes, currentNodeId, mode) {
    const source = Array.isArray(nodes) ? nodes.filter((node) => node && node.id) : [];
    const nodeMap = new Map(source.map((node) => [node.id, node]));
    const warnings = [];

    if (!nodeMap.has(currentNodeId)) {
      return { nodes: source, visibleIds: new Set(nodeMap.keys()), pathIds: [], nearbyIds: new Set(), warnings };
    }

    const reversedPath = [];
    const visited = new Set();
    let cursor = nodeMap.get(currentNodeId);
    while (cursor) {
      if (visited.has(cursor.id)) {
        warnings.push({ type: "cycle", nodeId: cursor.id });
        break;
      }
      visited.add(cursor.id);
      reversedPath.push(cursor.id);
      if (!cursor.parent_id) break;
      const parent = nodeMap.get(cursor.parent_id);
      if (!parent) {
        warnings.push({ type: "missing-parent", nodeId: cursor.id, parentId: cursor.parent_id });
        break;
      }
      cursor = parent;
    }

    const pathIds = reversedPath.reverse();
    const children = new Map(source.map((node) => [node.id, []]));
    for (const node of source) {
      if (node.parent_id && children.has(node.parent_id)) children.get(node.parent_id).push(node.id);
    }
    const nearbyIds = new Set();
    for (const id of pathIds) {
      const node = nodeMap.get(id);
      for (const childId of children.get(id) || []) nearbyIds.add(childId);
      if (node?.parent_id) {
        for (const siblingId of children.get(node.parent_id) || []) nearbyIds.add(siblingId);
      }
    }
    for (const id of pathIds) nearbyIds.delete(id);
    const focusedIds = new Set([...pathIds, ...nearbyIds]);
    const visibleIds = mode === "path"
      ? new Set(pathIds)
      : mode === "nearby"
        ? focusedIds
        : new Set(nodeMap.keys());
    return {
      nodes: mode === "path"
        ? pathIds.map((id) => nodeMap.get(id))
        : mode === "nearby"
          ? source.filter((node) => visibleIds.has(node.id))
          : source,
      visibleIds,
      pathIds,
      nearbyIds,
      warnings,
    };
  }

  return { resolveViewState };
});
