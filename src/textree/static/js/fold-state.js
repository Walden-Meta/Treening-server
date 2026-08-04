(function (global) {
  "use strict";

  function resolveFoldState(nodes, foldIntents) {
    const orderedNodes = Array.isArray(nodes) ? nodes.filter((node) => node && node.id) : [];
    const nodeMap = new Map(orderedNodes.map((node) => [node.id, node]));
    const children = new Map(orderedNodes.map((node) => [node.id, []]));
    for (const node of orderedNodes) {
      if (node.parent_id && children.has(node.parent_id)) children.get(node.parent_id).push(node);
    }

    // An intent is meaningful only while the node exists and still owns a subtree.
    const intents = new Set(
      [...(foldIntents || [])].filter((id) => nodeMap.has(id) && (children.get(id) || []).length > 0)
    );

    const hasIntentAncestor = (id) => {
      const trail = new Set([id]);
      let node = nodeMap.get(id);
      while (node && node.parent_id) {
        if (trail.has(node.parent_id)) return false;
        trail.add(node.parent_id);
        if (intents.has(node.parent_id)) return true;
        node = nodeMap.get(node.parent_id);
      }
      return false;
    };

    const activeRoots = new Set();
    const latentRoots = new Set();
    for (const node of orderedNodes) {
      if (!intents.has(node.id)) continue;
      (hasIntentAncestor(node.id) ? latentRoots : activeRoots).add(node.id);
    }

    const foldedAway = new Set();
    const deckOwner = new Map();
    const deckMembers = new Map();
    for (const rootId of activeRoots) {
      const members = [];
      const visited = new Set([rootId]);
      const stack = [...(children.get(rootId) || [])].reverse();
      while (stack.length) {
        const node = stack.pop();
        if (!node || visited.has(node.id)) continue;
        visited.add(node.id);
        foldedAway.add(node.id);
        deckOwner.set(node.id, rootId);
        members.push(node.id);
        const descendants = children.get(node.id) || [];
        for (let index = descendants.length - 1; index >= 0; index -= 1) stack.push(descendants[index]);
      }
      deckMembers.set(rootId, members);
    }

    return { intents, activeRoots, latentRoots, foldedAway, deckOwner, deckMembers, children };
  }

  const api = { resolveFoldState };
  global.TextreeFoldState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
