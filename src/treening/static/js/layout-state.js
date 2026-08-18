(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TreeningLayoutState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createHorizontalGeometry(children, widthOf, options = {}) {
    const siblingGap = Number.isFinite(options.siblingGap) ? options.siblingGap : 68;
    const memo = new Map();

    function measure(id, trail = new Set()) {
      if (memo.has(id)) return memo.get(id);
      const ownWidth = Math.max(1, Number(widthOf(id)) || 300);
      if (trail.has(id)) {
        if (typeof options.onCycle === "function") options.onCycle(id);
        return { width: ownWidth, rootOffset: ownWidth / 2, childInset: 0 };
      }

      const branchChildren = children.get(id) || [];
      if (!branchChildren.length) {
        const leaf = { width: ownWidth, rootOffset: ownWidth / 2, childInset: 0 };
        memo.set(id, leaf);
        return leaf;
      }

      const nextTrail = new Set([...trail, id]);
      const childGeometry = branchChildren.map((child) => measure(child.id, nextTrail));
      const childSpan = childGeometry.reduce((sum, item) => sum + item.width, 0)
        + siblingGap * Math.max(0, childGeometry.length - 1);
      const childRoots = [];
      let cursor = 0;
      for (const item of childGeometry) {
        childRoots.push(cursor + item.rootOffset);
        cursor += item.width + siblingGap;
      }

      // One child continues vertically. With the complete three-way branch,
      // the parent follows the middle (followup) branch. Other divergences use
      // the outer-child midpoint. Unlike equal slots, a wide side subtree no
      // longer multiplies its width across every sibling.
      let rootOffset = childRoots.length === 1
        ? childRoots[0]
        : childRoots.length === 3
          ? childRoots[1]
          : (childRoots[0] + childRoots[childRoots.length - 1]) / 2;
      const childInset = Math.max(0, ownWidth / 2 - rootOffset);
      rootOffset += childInset;
      const width = Math.max(childSpan + childInset, rootOffset + ownWidth / 2);
      const result = { width, rootOffset, childInset };
      memo.set(id, result);
      return result;
    }

    return { measure };
  }

  function resolveOverlaps(nodes, anchorId, options = {}) {
    const gap = Number.isFinite(options.gap) ? Math.max(0, options.gap) : 38;
    const maxPasses = Number.isFinite(options.maxPasses) ? Math.max(1, options.maxPasses) : 24;
    const minX = Number.isFinite(options.minX) ? options.minX : 140;
    const minY = Number.isFinite(options.minY) ? options.minY : 90;
    const items = (Array.isArray(nodes) ? nodes : []).filter((item) => item && item.id).map((item) => ({
      id: item.id,
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      width: Math.max(1, Number(item.width) || 1),
      height: Math.max(1, Number(item.height) || 1),
    }));
    const moved = new Set();

    function overlap(a, b) {
      return {
        x: (a.width + b.width) / 2 + gap - Math.abs(a.x - b.x),
        y: (a.height + b.height) / 2 + gap - Math.abs(a.y - b.y),
      };
    }

    for (let pass = 0; pass < maxPasses; pass += 1) {
      let changed = false;
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          const first = items[i];
          const second = items[j];
          const amount = overlap(first, second);
          if (amount.x <= 0 || amount.y <= 0) continue;

          let fixed = first;
          let moving = second;
          if (second.id === anchorId) { fixed = second; moving = first; }
          else if (first.id !== anchorId && first.y > second.y) { fixed = second; moving = first; }

          const dx = moving.x - fixed.x;
          const dy = moving.y - fixed.y;
          const moveVertically = Math.abs(dy) >= Math.abs(dx) * 0.65;
          if (moveVertically) {
            const direction = dy === 0 ? 1 : Math.sign(dy);
            const nextY = moving.y + direction * amount.y;
            moving.y = nextY < minY ? fixed.y + amount.y + (fixed.height + moving.height) / 2 + gap : nextY;
          } else {
            const direction = dx === 0 ? (String(moving.id) > String(fixed.id) ? 1 : -1) : Math.sign(dx);
            const nextX = moving.x + direction * amount.x;
            moving.x = nextX < minX ? fixed.x + amount.x + (fixed.width + moving.width) / 2 + gap : nextX;
          }
          moved.add(moving.id);
          changed = true;
        }
      }
      if (!changed) break;
    }

    let unresolved = 0;
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const amount = overlap(items[i], items[j]);
        if (amount.x > 0 && amount.y > 0) unresolved += 1;
      }
    }
    return {
      positions: new Map(items.map((item) => [item.id, { x: item.x, y: item.y }])),
      movedIds: [...moved].filter((id) => id !== anchorId),
      unresolved,
    };
  }

  function createVerticalGeometry(children, heightOf, options = {}) {
    // createHorizontalGeometry 的镜像：用「高度」度量子树，供横向河流布局使用。
    // 每次调用 measure(qId) 返回该问答对子树的 { height, rootOffset, childInset }，
    // rootOffset 是「分支子树堆叠带」中心相对子树顶部的高度偏移。
    const siblingGap = Number.isFinite(options.siblingGap) ? options.siblingGap : 68;
    const memo = new Map();

    function measure(id, trail = new Set()) {
      if (memo.has(id)) return memo.get(id);
      const ownHeight = Math.max(1, Number(heightOf(id)) || 180);
      if (trail.has(id)) {
        if (typeof options.onCycle === "function") options.onCycle(id);
        return { height: ownHeight, rootOffset: ownHeight / 2, childInset: 0 };
      }

      const branchChildren = children.get(id) || [];
      if (!branchChildren.length) {
        const leaf = { height: ownHeight, rootOffset: ownHeight / 2, childInset: 0 };
        memo.set(id, leaf);
        return leaf;
      }

      const nextTrail = new Set([...trail, id]);
      const childGeometry = branchChildren.map((child) => measure(child.id, nextTrail));
      const childSpan = childGeometry.reduce((sum, item) => sum + item.height, 0)
        + siblingGap * Math.max(0, childGeometry.length - 1);
      const childRoots = [];
      let cursor = 0;
      for (const item of childGeometry) {
        childRoots.push(cursor + item.rootOffset);
        cursor += item.height + siblingGap;
      }

      // 与横向版同规则：单分支跟随该分支；三分支跟随中间；其他取首尾中点。
      let rootOffset = childRoots.length === 1
        ? childRoots[0]
        : childRoots.length === 3
          ? childRoots[1]
          : (childRoots[0] + childRoots[childRoots.length - 1]) / 2;
      const childInset = Math.max(0, ownHeight / 2 - rootOffset);
      rootOffset += childInset;
      const height = Math.max(childSpan + childInset, rootOffset + ownHeight / 2);
      const result = { height, rootOffset, childInset };
      memo.set(id, result);
      return result;
    }

    return { measure };
  }

  return { createHorizontalGeometry, createVerticalGeometry, resolveOverlaps };
});
