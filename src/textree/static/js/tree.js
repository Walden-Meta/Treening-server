(() => {
  "use strict";

  const State = {
    sessionId: null,
    sessionTitle: "",
    nodes: [],
    maxBranches: 3,
    currentNodeId: null,
    readerNodeId: null,
    interactionType: "question",
    pendingJobs: new Map(),
    sessionGeneration: 0,
    forcedExpanded: new Set(),
    forcedCollapsed: new Set(),
    foldedBranches: new Set(),  // 当前会话的用户折叠意图；有效/潜伏根由解析层推导
    foldedBranchesBySession: new Map(),
    concealedNodes: new Set(),
    summaryJobs: new Map(),
    layoutSaveTimers: new Map(),
  };

  const MIN_SCALE = 0.32;
  const MAX_SCALE = 1.35;
  const OVERVIEW_SCALE = 0.42;

  const Graph = {
    scale: 1,
    tx: 0,
    ty: 0,
    width: 1,
    height: 1,
    positions: new Map(),
    model: { nodes: [], nodeMap: new Map(), children: new Map(), roots: [], edges: [], warnings: [] },
    elements: new Map(),
    dragging: false,
    pointerId: null,
    lastPointer: null,
    nodeDrag: null,
    nodeResize: null,
    suppressClickNodeId: null,
    overviewMode: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const DOM = {
    studyApp: $("#study-app"), workspaceTitle: $("#workspace-title"), workspaceMeta: $("#workspace-meta"),
    quotaLabel: $("#quota-label"),
    nodeCount: $("#node-count"), depthLabel: $("#depth-label"),
    contextLabel: $("#context-label"), clearContextButton: $("#clear-context-button"),
    viewport: $("#graph-viewport"), world: $("#graph-world"), edges: $("#graph-edges"),
    nodesLayer: $("#graph-nodes"), minimap: $("#minimap"), minimapSvg: $("#minimap-svg"),
    emptyState: $("#empty-state"), messageForm: $("#message-form"),
    messageInput: $("#message-input"), sendButton: $("#send-button"),
    composerHint: $("#composer-hint"), newSessionButton: $("#new-session-button"),
    zoomLabel: $("#zoom-label"),
    sessionList: $("#session-list"), refreshSessionsButton: $("#refresh-sessions-button"),
    concealAllButton: $("#conceal-all-button"), revealAllButton: $("#reveal-all-button"),
    exportScope: $("#export-scope"), exportFormat: $("#export-format"), exportButton: $("#export-button"),
    fitGraphButton: $("#fit-graph-button"), zoomInButton: $("#zoom-in-button"),
    zoomOutButton: $("#zoom-out-button"),
    readerPanel: $("#reader-panel"), readerEmpty: $("#reader-empty"), readerView: $("#reader-view"),
    readerRole: $("#reader-role"), readerBranch: $("#reader-branch"), readerDepth: $("#reader-depth"),
    readerTitle: $("#reader-title"), readerContent: $("#reader-content"), readerConcealed: $("#reader-concealed"),
    readerConcealedSummary: $("#reader-concealed-summary") || $("#reader-concealed-hint"), readerMeta: $("#reader-meta"),
    readerFocusButton: $("#reader-focus-button"), readerRevealButton: $("#reader-reveal-button"),
    sessionRail: $("#session-rail"), historyPanelToggle: $("#history-panel-toggle"),
    readerPanelToggle: $("#reader-panel-toggle"), panelBackdrop: $("#panel-backdrop"),
  };

  const BRANCH_LABELS = {
    question: "起点问题", followup: "追问", check: "验收", custom: "其他",
    correction: "其他",
  };
  const BRANCH_ORDER = ["check", "followup", "custom"];
  const BRANCH_PLACEHOLDERS = {
    followup: "具体想追问哪一个细节？",
    check: "写下你的理解，惠会和你一起检查……",
    custom: "输入这条自定义支线想探索的内容……",
    question: "输入一个真正困扰你的问题……",
  };
  const SVG_NS = "http://www.w3.org/2000/svg";

  const API = {
    async fetchJson(url, options = {}) {
      const response = await fetch(url, options);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.error || "请求失败");
        error.code = body.code; error.status = response.status; error.body = body;
        throw error;
      }
      return body;
    },
    getSession() { return this.fetchJson("/api/quiz/session"); },
    createSession() { return this.fetchJson("/api/quiz/session", { method: "POST" }); },
    listSessions() { return this.fetchJson("/api/quiz/sessions"); },
    getSessionById(sessionId) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}`); },
    updateNodeLayout(sessionId, nodeId, layout) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}/nodes/${encodeURIComponent(nodeId)}/layout`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(layout),
    }); },
    deleteNode(sessionId, nodeId) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" }); },
    ask(payload) { return this.fetchJson("/api/quiz/ask", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }); },
    getJob(jobId) { return this.fetchJson(`/api/quiz/jobs/${encodeURIComponent(jobId)}`); },
    generateNodeSummary(sessionId, nodeId) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}/nodes/${encodeURIComponent(nodeId)}/summary`, { method: "POST" }); },
  };

  function clearTransientOverlays() {
    document.querySelectorAll(".loading-node, .inline-error").forEach((element) => element.remove());
  }

  function clearPendingJobs() {
    State.pendingJobs.clear();
    clearTransientOverlays();
    DOM.sendButton.disabled = false;
  }

  function setQuota(quota) {
    if (!quota) return;
    DOM.quotaLabel.textContent = quota.unlimited
      ? "今日提问不限"
      : `今日剩余 ${quota.remaining} / ${quota.max}`;
  }

  function formatSessionDate(value) {
    if (!value) return "未记录时间";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "未记录时间" : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  function renderSessionList(sessions) {
    DOM.sessionList.replaceChildren();
    if (!sessions.length) {
      const empty = document.createElement("span"); empty.className = "history-empty"; empty.textContent = "暂无历史主题";
      DOM.sessionList.append(empty); return;
    }
    for (const item of sessions) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "session-item";
      button.classList.toggle("is-active", item.id === State.sessionId);
      const title = document.createElement("span"); title.className = "session-item-title";
      title.textContent = item.title || item.root_question || "未命名学习主题";
      const meta = document.createElement("span"); meta.className = "session-item-meta";
      meta.textContent = `${item.node_count || 0} 个节点 · ${formatSessionDate(item.updated_at)}`;
      button.append(title, meta);
      button.addEventListener("click", () => {
        loadSessionById(item.id).catch((error) => {
          appendError(error.message || "历史主题加载失败，请稍后重试。");
        });
      });
      DOM.sessionList.append(button);
    }
  }

  async function loadSessionHistory() {
    try {
      const result = await API.listSessions();
      const sessions = Array.isArray(result.sessions) ? result.sessions : [];
      renderSessionList(sessions);
      // The first request after unlocking can race with the session identity
      // being established. A real current session must be visible in history;
      // retry once instead of leaving the user with a misleading empty list.
      if (!sessions.length && State.sessionId) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        const retry = await API.listSessions();
        renderSessionList(Array.isArray(retry.sessions) ? retry.sessions : []);
      }
    } catch (error) {
      DOM.sessionList.replaceChildren();
      const empty = document.createElement("span"); empty.className = "history-empty"; empty.textContent = "历史主题暂时无法加载";
      DOM.sessionList.append(empty);
    }
  }

  function nodeById(id) { return State.nodes.find((node) => node.id === id) || null; }
  function normalizeBranch(branch) { return branch === "correction" ? "custom" : (branch || "question"); }
  // UI depth is 1-based so the root is the first layer, matching the usual
  // level/height vocabulary used when explaining binary trees.
  function displayDepth(id) { return depthOf(id) + 1; }
  function depthOf(id, memo = new Map(), trail = new Set()) {
    if (!id || trail.has(id)) return 0;
    if (memo.has(id)) return memo.get(id);
    const node = nodeById(id);
    const parent = node && node.parent_id ? nodeById(node.parent_id) : null;
    const depth = parent ? depthOf(parent.id, memo, new Set([...trail, id])) + 1 : 0;
    memo.set(id, depth); return depth;
  }

  function branchParentId() {
    const node = nodeById(State.currentNodeId);
    if (!node) return null;
    if (node.role === "assistant") return node.id;
    const parent = nodeById(node.parent_id);
    return parent && parent.role === "assistant" ? parent.id : null;
  }

  function setCurrentNode(nodeId, options = {}) {
    State.currentNodeId = nodeId || null;
    State.readerNodeId = State.currentNodeId;
    const node = nodeById(State.currentNodeId);
    DOM.contextLabel.textContent = node
      ? `回应「${node.content.slice(0, 42)}${node.content.length > 42 ? "…" : ""}」`
      : "从新的问题开始";
    DOM.clearContextButton.hidden = !node;
    DOM.depthLabel.textContent = `当前深度 ${node ? displayDepth(node.id) : 0}`;
    renderReader();
    // 轻量高亮当前节点，避免整图重建（点击节点才不卡）
    for (const [id, el] of Graph.elements) {
      el.classList.toggle("is-current", id === State.currentNodeId);
    }
    if (options.center !== false && node) centerOnNode(node.id);
  }

  function concealNode(nodeId) {
    const node = nodeById(nodeId);
    if (!node) return;
    State.concealedNodes.add(nodeId);
    renderGraph();
    renderReader();
    if (!nodeSummary(node)) void ensureNodeSummary(node);
  }

  function nodeSummary(node) {
    const summary = node && node.metadata && node.metadata.summary;
    if (typeof summary !== "string") return "";
    const normalized = summary.trim();
    if (!normalized || normalized.length > 50 || /回忆|提示|验收|追问|其他|显示|隐藏/.test(normalized)) return "";
    return normalized;
  }

  async function ensureNodeSummary(node) {
    if (!node || nodeSummary(node)) return nodeSummary(node);
    if (State.summaryJobs.has(node.id)) return State.summaryJobs.get(node.id);
    if (!node.metadata || typeof node.metadata !== "object") node.metadata = {};
    node.metadata.summary = "摘要生成中…";
    renderGraph();
    renderReader();
    const promise = API.generateNodeSummary(State.sessionId, node.id)
      .then((result) => {
        if (nodeById(node.id) !== node) return "";
        node.metadata.summary = typeof result.summary === "string" && result.summary.trim()
          ? result.summary.trim() : "摘要暂缺";
        return node.metadata.summary;
      })
      .catch(() => {
        if (nodeById(node.id) === node) node.metadata.summary = "摘要暂缺";
        return "摘要暂缺";
      })
      .finally(() => State.summaryJobs.delete(node.id));
    State.summaryJobs.set(node.id, promise);
    return promise;
  }

  async function ensureMissingSummaries(nodes) {
    for (const node of nodes) await ensureNodeSummary(node);
  }

  function revealNode(nodeId) {
    State.concealedNodes.delete(nodeId);
    renderGraph();
    renderReader();
  }

  function updateBulkVisibilityControls() {
    if (!DOM.concealAllButton || !DOM.revealAllButton) return;
    const total = State.nodes.length;
    const hidden = State.concealedNodes.size;
    DOM.concealAllButton.disabled = total === 0 || hidden === total;
    DOM.revealAllButton.disabled = total === 0 || hidden === 0;
  }

  function concealAllNodes() {
    State.nodes.forEach((node) => State.concealedNodes.add(node.id));
    renderGraph();
    renderReader();
    void ensureMissingSummaries(State.nodes.filter((node) => !nodeSummary(node)));
  }

  function revealAllNodes() {
    State.concealedNodes.clear();
    renderGraph();
    renderReader();
  }

  function childNodes(parentId) { return State.nodes.filter((node) => node.parent_id === parentId); }

  function activateFoldSession(sessionId) {
    if (!State.foldedBranchesBySession.has(sessionId)) State.foldedBranchesBySession.set(sessionId, new Set());
    State.foldedBranches = State.foldedBranchesBySession.get(sessionId);
  }

  function buildGraphModel() {
    const nodes = State.nodes;
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const children = new Map(nodes.map((node) => [node.id, []]));
    const roots = [];
    const edges = [];
    const warnings = [];

    // Pure resolver separates user intent from the roots that are currently
    // visible. Nested intents remain latent until their ancestor is reopened.
    const foldState = window.TextreeFoldState.resolveFoldState(nodes, State.foldedBranches);
    const { foldedAway } = foldState;

    for (const node of nodes) {
      if (foldedAway.has(node.id)) continue;
      if (!node.parent_id) {
        roots.push(node);
        continue;
      }

      const parent = nodeMap.get(node.parent_id);
      const branch = normalizeBranch(node.branch_type);
      const edge = {
        from: node.parent_id,
        to: node.id,
        relation: node.role === "assistant" ? "answer" : "branch",
        branch: node.role === "assistant" ? "question" : branch,
      };
      edges.push(edge);

      if (!parent) {
        warnings.push({ type: "missing-parent", nodeId: node.id, parentId: node.parent_id });
        // Treat an orphan as a visible root so it does not silently collapse
        // to an unpositioned DOM element.
        roots.push(node);
        continue;
      }
      children.get(parent.id).push(node);
    }

    const visiting = new Set();
    const visited = new Set();
    const detectCycles = (node) => {
      if (visited.has(node.id)) return;
      if (visiting.has(node.id)) {
        warnings.push({ type: "cycle", nodeId: node.id });
        return;
      }
      visiting.add(node.id);
      const parent = node.parent_id ? nodeMap.get(node.parent_id) : null;
      if (parent) detectCycles(parent);
      visiting.delete(node.id); visited.add(node.id);
    };
    nodes.forEach(detectCycles);

    for (const list of children.values()) {
      list.sort((a, b) => {
        const aSlot = BRANCH_ORDER.indexOf(normalizeBranch(a.branch_type));
        const bSlot = BRANCH_ORDER.indexOf(normalizeBranch(b.branch_type));
        return (aSlot < 0 ? 9 : aSlot) - (bSlot < 0 ? 9 : bSlot);
      });
    }

    return { nodes, nodeMap, children, roots, edges, warnings, foldedAway, foldState };
  }

  function compactText(text, limit = 76) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
  }

  function renderReader() {
    const node = nodeById(State.readerNodeId);
    DOM.readerEmpty.hidden = Boolean(node);
    DOM.readerView.hidden = !node;
    if (!node) {
      DOM.readerContent.hidden = false;
      if (DOM.readerConcealed) DOM.readerConcealed.hidden = true;
      return;
    }
    const branch = normalizeBranch(node.branch_type);
    const concealed = State.concealedNodes.has(node.id);
    DOM.readerRole.textContent = node.role === "user" ? "你" : "惠 / textbook-learning";
    DOM.readerBranch.textContent = BRANCH_LABELS[branch] || "学习回应";
    DOM.readerDepth.textContent = `深度 ${displayDepth(node.id)}`;
    DOM.readerTitle.textContent = node.role === "user" ? "你的提问" : "惠的回答";
    DOM.readerContent.textContent = node.content;
    DOM.readerContent.hidden = concealed;
    if (DOM.readerConcealed) DOM.readerConcealed.hidden = !concealed;
    if (DOM.readerConcealedSummary) DOM.readerConcealedSummary.textContent = nodeSummary(node) || "摘要生成中…";
    if (concealed) {
      DOM.readerRole.textContent = "";
      DOM.readerBranch.textContent = "";
      DOM.readerDepth.textContent = "";
      DOM.readerTitle.textContent = "";
      DOM.readerMeta.textContent = "";
    }
    DOM.readerMeta.textContent = concealed ? "" : `${node.content.length} 字 · 完整文本阅读`;
  }

  const NODE_MIN_WIDTH = 220;
  const NODE_MAX_WIDTH = 640;
  const NODE_MIN_HEIGHT = 90;
  const NODE_MAX_HEIGHT = 640;
  const NODE_DEFAULT_HEIGHT = 180;

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function nodeLayout(node) {
    const raw = node && node.metadata && node.metadata.layout;
    if (!raw || typeof raw !== "object") return null;
    const values = [raw.x, raw.y, raw.width, raw.height].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return {
      x: values[0], y: values[1],
      width: clamp(values[2], NODE_MIN_WIDTH, NODE_MAX_WIDTH),
      height: clamp(values[3], NODE_MIN_HEIGHT, NODE_MAX_HEIGHT),
    };
  }

  function layoutSnapshot(node, position = Graph.positions.get(node.id)) {
    const current = nodeLayout(node);
    const card = Graph.elements.get(node.id)?.querySelector(".node-card");
    const fallbackPosition = position || { x: 260, y: 120 };
    return {
      x: current ? current.x : fallbackPosition.x,
      y: current ? current.y : fallbackPosition.y,
      width: current ? current.width : clamp(card?.offsetWidth || 300, NODE_MIN_WIDTH, NODE_MAX_WIDTH),
      height: current ? current.height : clamp(card?.offsetHeight || NODE_DEFAULT_HEIGHT, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT),
    };
  }

  function setNodeLayout(node, layout) {
    if (!node.metadata || typeof node.metadata !== "object") node.metadata = {};
    node.metadata.layout = {
      x: Number(layout.x.toFixed(2)),
      y: Number(layout.y.toFixed(2)),
      width: Number(clamp(layout.width, NODE_MIN_WIDTH, NODE_MAX_WIDTH).toFixed(2)),
      height: Number(clamp(layout.height, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT).toFixed(2)),
    };
    return node.metadata.layout;
  }

  function applyNodeLayoutStyle(node, element) {
    const layout = nodeLayout(node);
    const card = element.querySelector(".node-card");
    element.style.width = `${layout ? layout.width : 300}px`;
    // Keep a stable card frame even before the user manually resizes it.
    // Expanding should only change what is visible inside this frame.
    card.style.height = `${layout ? layout.height : NODE_DEFAULT_HEIGHT}px`;
  }

  let _edgesRenderQueued = false;
  function queueEdgesRender() {
    if (_edgesRenderQueued) return;
    _edgesRenderQueued = true;
    requestAnimationFrame(() => {
      _edgesRenderQueued = false;
      renderEdges();
    });
  }

  function refreshGraphGeometry() {
    renderEdges();
    DOM.world.style.width = `${Graph.width}px`;
    DOM.world.style.height = `${Graph.height}px`;
    applyTransform();
  }

  function scheduleNodeLayoutSave(node) {
    const oldTimer = State.layoutSaveTimers.get(node.id);
    if (oldTimer) window.clearTimeout(oldTimer);
    const timer = window.setTimeout(async () => {
      State.layoutSaveTimers.delete(node.id);
      const layout = nodeLayout(node);
      if (!layout || !State.sessionId || !nodeById(node.id)) return;
      try {
        const result = await API.updateNodeLayout(State.sessionId, node.id, layout);
        if (nodeById(node.id) === node && result.node?.metadata) node.metadata = result.node.metadata;
      } catch (error) {
        appendError(error.message || "节点布局保存失败，请稍后重试。");
      }
    }, 320);
    State.layoutSaveTimers.set(node.id, timer);
  }

  function beginNodeDrag(event, node, card) {
    if (event.button !== 0 || event.target.closest("button, .node-resize-handle")) return;
    const position = Graph.positions.get(node.id);
    if (!position) return;
    const layout = setNodeLayout(node, layoutSnapshot(node, position));
    Graph.nodeDrag = {
      node, card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      originX: layout.x, originY: layout.y, moved: false,
    };
    card.setPointerCapture?.(event.pointerId);
    card.classList.add("is-node-dragging");
    event.preventDefault(); event.stopPropagation();
  }

  function beginNodeResize(event, node, card) {
    if (event.button !== 0) return;
    const layout = setNodeLayout(node, layoutSnapshot(node));
    Graph.nodeResize = {
      node, card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      originWidth: layout.width, originHeight: layout.height, moved: false,
    };
    card.setPointerCapture?.(event.pointerId);
    card.classList.add("is-node-resizing");
    event.preventDefault(); event.stopPropagation();
  }

  function moveNodePointer(event) {
    const drag = Graph.nodeDrag;
    if (drag && drag.pointerId === event.pointerId) {
      const dx = (event.clientX - drag.startX) / Graph.scale;
      const dy = (event.clientY - drag.startY) / Graph.scale;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      Graph.suppressClickNodeId = drag.node.id;
      const layout = nodeLayout(drag.node);
      setNodeLayout(drag.node, { ...layout, x: Math.max(140, drag.originX + dx), y: Math.max(90, drag.originY + dy) });
      const pos = drag.node.metadata.layout;
      Graph.positions.set(drag.node.id, { x: pos.x, y: pos.y });  // 同步连线锚点
      const element = Graph.elements.get(drag.node.id);
      element.style.left = `${pos.x}px`;
      element.style.top = `${pos.y}px`;
      if (Graph.model?.foldState?.activeRoots.has(drag.node.id)) moveOwnedDeck(drag.node.id, pos);
      queueEdgesRender();  // 下一帧才重建连线，拖动不卡
      event.preventDefault();
      return;
    }
    const resize = Graph.nodeResize;
    if (resize && resize.pointerId === event.pointerId) {
      const dx = (event.clientX - resize.startX) / Graph.scale;
      const dy = (event.clientY - resize.startY) / Graph.scale;
      if (!resize.moved && Math.hypot(dx, dy) >= 2) resize.moved = true;
      const layout = nodeLayout(resize.node);
      setNodeLayout(resize.node, {
        ...layout,
        width: resize.originWidth + dx,
        height: resize.originHeight + dy,
      });
      applyNodeLayoutStyle(resize.node, Graph.elements.get(resize.node.id));
      queueEdgesRender();
      event.preventDefault();
    }
  }

  function finishNodePointer(event) {
    const drag = Graph.nodeDrag;
    if (drag && drag.pointerId === event.pointerId) {
      drag.card.releasePointerCapture?.(event.pointerId);
      drag.card.classList.remove("is-node-dragging");
      if (drag.moved) scheduleNodeLayoutSave(drag.node);
      Graph.nodeDrag = null;
      window.setTimeout(() => { if (Graph.suppressClickNodeId === drag.node.id) Graph.suppressClickNodeId = null; }, 0);
      refreshGraphGeometry();
      return;
    }
    const resize = Graph.nodeResize;
    if (resize && resize.pointerId === event.pointerId) {
      resize.card.releasePointerCapture?.(event.pointerId);
      resize.card.classList.remove("is-node-resizing");
      if (resize.moved) scheduleNodeLayoutSave(resize.node);
      Graph.nodeResize = null;
      refreshGraphGeometry();
    }
  }

  function subtreeNodeIds(nodeId) {
    const ids = new Set([nodeId]);
    const visit = (id) => {
      (Graph.model.children.get(id) || []).forEach((child) => {
        if (ids.has(child.id)) return;
        ids.add(child.id); visit(child.id);
      });
    };
    visit(nodeId);
    return ids;
  }

  // Read the raw tree rather than Graph.model, which is intentionally pruned
  // while a branch is folded.
  function directSubtree(nodeId) {
    const children = new Map(State.nodes.map((node) => [node.id, []]));
    for (const node of State.nodes) {
      if (node.parent_id && children.has(node.parent_id)) children.get(node.parent_id).push(node.id);
    }
    const ids = new Set([nodeId]);
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop();
      for (const childId of children.get(id) || []) {
        if (!ids.has(childId)) {
          ids.add(childId);
          stack.push(childId);
        }
      }
    }
    return ids;
  }

  // ── 奏折式折叠 / 扑克牌堆叠 ──
  function foldBranch(nodeId) {
    const subtree = directSubtree(nodeId);
    const selectionWillHide = State.currentNodeId !== nodeId && subtree.has(State.currentNodeId);
    const readerWillHide = State.readerNodeId !== nodeId && subtree.has(State.readerNodeId);
    if (selectionWillHide) setCurrentNode(nodeId, { center: false });
    else if (readerWillHide) { State.readerNodeId = nodeId; renderReader(); }
    State.foldedBranches.add(nodeId);
    // 折叠只叠牌，不重排：其他节点原地不动，视野内外都不受波及
    renderGraph({ reflow: false });
    if (selectionWillHide) Graph.elements.get(nodeId)?.querySelector(".node-card")?.focus({ preventScroll: true });
    // 刻意不重新 fit：保留用户当前的缩放/平移，不打断局部视角
  }

  function unfoldBranch(nodeId) {
    State.foldedBranches.delete(nodeId);
    // 兜底：确保每个要展开的节点都有位置记录（防止折叠期间结构变化把位置冲掉）。
    // 缺失位置的节点先落到其父节点附近，而不是残留在牌堆里。
    for (const node of State.nodes) {
      if (Graph.positions.has(node.id)) continue;
      const parent = nodeById(node.parent_id);
      const base = parent ? Graph.positions.get(parent.id) : null;
      Graph.positions.set(node.id, base
        ? { x: base.x + 40, y: base.y + 60 }
        : { x: 240, y: 180 });
    }
    renderGraph({ reflow: false });  // 卡片从牌堆滑回原位置，其他节点不动
  }

  function toggleFold(nodeId) {
    if (State.foldedBranches.has(nodeId)) unfoldBranch(nodeId);
    else foldBranch(nodeId);
  }

  // 把一张折叠卡放进牌堆：anchor=锚点（父节点中心附近），i=组内序号，rotShift=组间角度，delay=顺序折叠延时
  function deckCard(el, anchor, i, rotShift, delay) {
    if (!el) return;
    el.style.left = `${anchor.x}px`;
    el.style.top = `${anchor.y}px`;
    el.classList.add("is-folded");
    el.inert = true;
    el.setAttribute("aria-hidden", "true");
    const focusCard = el.querySelector(".node-card");
    if (focusCard) focusCard.tabIndex = -1;
    el.style.transitionDelay = `${delay}s, ${delay}s, 0s`;  // left, top, opacity
    const card = el.querySelector(".node-card");
    if (card) {
      // 紧凑堆叠：小偏移、极小倾斜；父节点 z-index 恒在其上 → 永远可点
      const offX = (i % 4) * 2.5;
      const offY = Math.floor(i / 4) * 2.5 + 3;
      const rot = ((i % 3) - 1) * 0.8 + rotShift;
      card.style.transitionDelay = `${delay}s`;
      card.style.transform = `translate(${offX}px, ${offY}px) rotate(${rot}deg)`;
    }
  }

  function moveOwnedDeck(foldId, position) {
    const members = Graph.model?.foldState?.deckMembers.get(foldId) || [];
    for (const id of members) {
      const el = Graph.elements.get(id);
      if (!el) continue;
      el.style.left = `${position.x}px`;
      el.style.top = `${position.y}px`;
      el.style.transitionDelay = "0s, 0s, 0s";
      const card = el.querySelector(".node-card");
      if (card) card.style.transitionDelay = "0s";
    }
  }

  function applyDeckTransforms() {
    const foldState = Graph.model?.foldState;
    const foldedAway = foldState?.foldedAway || new Set();
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    for (const foldId of foldState?.activeRoots || []) {
      const pos = Graph.positions.get(foldId);
      if (!pos) continue;
      // 线性与多分支统一：全部紧凑叠在父节点正中心。
      // 不横向扩散 → 卡片体不会从父卡片两侧伸出围住它；父卡片最大且在最上层。
      let i = 0;
      for (const id of foldState.deckMembers.get(foldId) || []) {
        deckCard(Graph.elements.get(id), pos, i, 0, reducedMotion ? 0 : i * 0.02);
        i += 1;
      }
    }
    // 不再折叠的：摘掉牌堆状态
    for (const [id, el] of Graph.elements) {
      if (el.classList.contains("is-folded") && !foldedAway.has(id)) {
        el.classList.remove("is-folded");
        el.inert = false;
        el.removeAttribute("aria-hidden");
        const focusCard = el.querySelector(".node-card");
        if (focusCard) focusCard.tabIndex = 0;
        el.style.transitionDelay = "";
        const card = el.querySelector(".node-card");
        if (card) {
          card.style.transitionDelay = "";
          card.style.transform = "";
        }
      }
    }
  }

  async function deleteQuestionNode(node) {
    const count = subtreeNodeIds(node.id).size;
    const message = count > 1
      ? `删除这个问题及其后续 ${count - 1} 个节点吗？`
      : "删除这个问题吗？";
    if (!window.confirm(message)) return;
    try {
      const result = await API.deleteNode(State.sessionId, node.id);
      const deleted = new Set(result.deleted_node_ids || []);
      State.nodes = State.nodes.filter((item) => !deleted.has(item.id));
      State.forcedExpanded = new Set([...State.forcedExpanded].filter((id) => !deleted.has(id)));
      State.forcedCollapsed = new Set([...State.forcedCollapsed].filter((id) => !deleted.has(id)));
      State.foldedBranches = new Set([...State.foldedBranches].filter((id) => !deleted.has(id)));
      State.concealedNodes = new Set([...State.concealedNodes].filter((id) => !deleted.has(id)));
      for (const id of deleted) {
        const timer = State.layoutSaveTimers.get(id);
        if (timer) window.clearTimeout(timer);
        State.layoutSaveTimers.delete(id);
        Graph.elements.get(id)?.remove();
        Graph.elements.delete(id);
        Graph.positions.delete(id);
      }
      renderGraph();
      const parent = nodeById(result.parent_id);
      setCurrentNode(parent ? parent.id : (State.nodes[0]?.id || null), { center: false });
      await loadSessionHistory();
    } catch (error) {
      if (error.code === "tree_delete_busy") appendError("该分支仍有学习请求处理中，请稍后再删除。");
      else appendError(error.message || "删除节点失败，请稍后重试。");
    }
  }

  function createNodeElement(node) {
    const article = document.createElement("article");
    article.className = `graph-node ${node.role}`;
    article.dataset.nodeId = node.id;
    const card = document.createElement("div"); card.className = "node-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `阅读${node.role === "user" ? "问题" : "回答"}`);
    const selectCard = () => setCurrentNode(node.id);
    card.addEventListener("pointerdown", (event) => beginNodeDrag(event, node, card));
    card.addEventListener("click", (event) => {
      if (Graph.suppressClickNodeId === node.id) {
        Graph.suppressClickNodeId = null;
        return;
      }
      if (!event.target.closest("button, .node-resize-handle")) selectCard();
    });
    card.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !event.target.closest("button")) {
        event.preventDefault(); selectCard();
      }
    });
    const header = document.createElement("div"); header.className = "node-header";
    const roleLabel = document.createElement("span"); roleLabel.textContent = node.role === "user" ? "你" : "惠 / textbook-learning";
    const branchLabel = document.createElement("span"); branchLabel.className = "node-branch";
    header.append(roleLabel, branchLabel);
    const content = document.createElement("div"); content.className = "node-content"; content.textContent = node.content;
    const summary = document.createElement("div"); summary.className = "node-summary"; summary.textContent = compactText(node.content); summary.title = node.content;
    const actions = document.createElement("div"); actions.className = "node-actions";
    const continueButton = document.createElement("button"); continueButton.type = "button"; continueButton.className = "node-action node-action-continue";
    continueButton.addEventListener("click", () => { setCurrentNode(node.id); DOM.messageInput.focus(); });
    const collapseButton = document.createElement("button"); collapseButton.type = "button"; collapseButton.className = "node-action node-action-fold";
    collapseButton.dataset.action = "fold";
    collapseButton.addEventListener("click", () => {
      // 有后代节点：折叠整个子树成牌堆（奏折式收起）
      if (childNodes(node.id).length > 0) {
        toggleFold(node.id);
        return;
      }
      const currentlyExpanded = article.classList.contains("is-expanded");
      if (currentlyExpanded) {
        State.forcedCollapsed.add(node.id);
        State.forcedExpanded.delete(node.id);
      } else {
        State.forcedExpanded.add(node.id);
        State.forcedCollapsed.delete(node.id);
      }
      renderGraph();
    });
    const concealButton = document.createElement("button"); concealButton.type = "button"; concealButton.className = "node-action node-action-conceal";
    concealButton.addEventListener("click", (event) => { event.stopPropagation(); concealNode(node.id); });
    actions.append(continueButton, collapseButton, concealButton);
    if (node.role === "user") {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "node-action-delete";
      deleteButton.title = "删除这个问题及其后续节点";
      deleteButton.setAttribute("aria-label", "删除这个问题及其后续节点");
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        void deleteQuestionNode(node);
      });
      actions.append(deleteButton);
    }
    const body = document.createElement("div"); body.className = "node-body";
    body.append(summary, content);
    card.append(header, body, actions);

    if (node.role === "assistant") {
      const slots = document.createElement("div"); slots.className = "branch-slots";
      for (const slot of BRANCH_ORDER) {
        const button = document.createElement("button"); button.type = "button";
        button.className = `branch-slot ${slot}`; button.dataset.slot = slot;
        button.addEventListener("click", () => {
          if (button.disabled) return;
          setCurrentNode(node.id); chooseInteractionType(slot); DOM.messageInput.focus();
        });
        slots.append(button);
      }
      card.append(slots);
    }
    const concealOverlay = document.createElement("div"); concealOverlay.className = "node-conceal-overlay"; concealOverlay.hidden = true;
    const semanticSummary = document.createElement("strong"); semanticSummary.className = "node-conceal-summary";
    const revealButton = document.createElement("button"); revealButton.type = "button"; revealButton.className = "node-conceal-reveal"; revealButton.textContent = "显示";
    revealButton.addEventListener("click", (event) => { event.stopPropagation(); revealNode(node.id); });
    concealOverlay.append(semanticSummary, revealButton);
    card.append(concealOverlay);
    const resizeHandle = document.createElement("span");
    resizeHandle.className = "node-resize-handle";
    resizeHandle.setAttribute("aria-hidden", "true");
    resizeHandle.addEventListener("pointerdown", (event) => beginNodeResize(event, node, card));
    card.append(resizeHandle);
    article.append(card); return article;
  }

  function ensureNodeElement(node) {
    if (Graph.elements.has(node.id)) return Graph.elements.get(node.id);
    const element = createNodeElement(node); Graph.elements.set(node.id, element); DOM.nodesLayer.append(element); return element;
  }

  function cardHeight(nodeId) {
    return Graph.elements.get(nodeId)?.querySelector(".node-card")?.offsetHeight || NODE_DEFAULT_HEIGHT;
  }

  function buildLayout() {
    const nodes = State.nodes;
    Graph.positions.clear();
    if (!nodes.length) { Graph.width = 1; Graph.height = 1; return; }
    const { children, roots } = Graph.model;
    const measureMemo = new Map();
    // A single-child chain stays vertical: question -> answer is a calm
    // downward rhythm.  Only a real divergence consumes horizontal space.
    const nodeWidth = 300; const siblingGap = 80; const rootGap = 120;
    const widthOf = (id) => nodeLayout(nodeById(id))?.width || nodeWidth;
    const top = 95; const padding = 240; const layerGap = 82;
    const foldedAway = (Graph.model && Graph.model.foldedAway) || new Set();
    const visible = nodes.filter((node) => !foldedAway.has(node.id));
    const maxDepth = Math.max(0, ...visible.map((node) => depthOf(node.id)));
    const layerHeights = new Map();
    for (const node of visible) {
      const depth = depthOf(node.id);
      layerHeights.set(depth, Math.max(layerHeights.get(depth) || 0, cardHeight(node.id)));
    }
    const layerY = new Map([[0, top]]);
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const previousHeight = layerHeights.get(depth - 1) || 90;
      const currentHeight = layerHeights.get(depth) || 90;
      layerY.set(depth, layerY.get(depth - 1) + previousHeight / 2 + layerGap + currentHeight / 2);
    }
    const measure = (id, trail = new Set()) => {
      if (measureMemo.has(id)) return measureMemo.get(id);
      if (trail.has(id)) {
        Graph.model.warnings.push({ type: "cycle", nodeId: id });
        return widthOf(id);
      }
      const branchChildren = children.get(id) || [];
      const nextTrail = new Set([...trail, id]);
      const childWidths = branchChildren.map((child) => measure(child.id, nextTrail));
      // Use equal-width slots for a complete three-way branch. This keeps the
      // followup branch physically centered even when its subtree is wider or
      // narrower than check/custom.
      const slotWidth = branchChildren.length === 3
        ? Math.max(nodeWidth, ...childWidths)
        : 0;
      const width = branchChildren.length === 0
        ? widthOf(id)
        : slotWidth
          ? slotWidth * branchChildren.length + siblingGap * (branchChildren.length - 1)
          : childWidths.reduce((sum, childWidth) => sum + childWidth, 0) + (branchChildren.length - 1) * siblingGap;
      measureMemo.set(id, width); return width;
    };
    let cursor = padding;
    const assigned = new Set();
    const assign = (node, left, depth, trail = new Set()) => {
      if (assigned.has(node.id) || trail.has(node.id)) {
        if (trail.has(node.id)) Graph.model.warnings.push({ type: "cycle", nodeId: node.id });
        return;
      }
      assigned.add(node.id);
      const branchChildren = children.get(node.id) || [];
      let x = left + widthOf(node.id) / 2;
      if (branchChildren.length) {
        const childWidths = branchChildren.map((child) => measure(child.id));
        const slotWidth = branchChildren.length === 3
          ? Math.max(nodeWidth, ...childWidths)
          : 0;
        let childLeft = left;
        for (let index = 0; index < branchChildren.length; index += 1) {
          const child = branchChildren[index];
          const width = childWidths[index];
          const slotLeft = slotWidth ? left + index * (slotWidth + siblingGap) : childLeft;
          const childOffset = slotWidth ? (slotWidth - width) / 2 : 0;
          assign(child, slotLeft + childOffset, depth + 1, new Set([...trail, node.id]));
          childLeft += width + siblingGap;
        }
        if (slotWidth) {
          x = left + (slotWidth * branchChildren.length + siblingGap * (branchChildren.length - 1)) / 2;
        } else {
          const first = Graph.positions.get(branchChildren[0].id);
          const last = Graph.positions.get(branchChildren[branchChildren.length - 1].id);
          x = branchChildren.length === 1 ? first.x : (first.x + last.x) / 2;
        }
      }
      Graph.positions.set(node.id, { x, y: layerY.get(depth) || top });
    };
    for (const root of roots) { assign(root, cursor, 0); cursor += measure(root.id) + rootGap; }
    // Cycles or malformed parent links can leave nodes outside every root.
    // Place them as isolated roots and report the structural warning instead
    // of leaving their DOM elements at the origin with missing edges.
    for (const node of nodes) {
      if (assigned.has(node.id)) continue;
      if (foldedAway.has(node.id)) continue;
      Graph.model.warnings.push({ type: "unreachable", nodeId: node.id });
      assign(node, cursor, 0);
      cursor += measure(node.id) + rootGap;
    }
    for (const node of nodes) {
      const layout = nodeLayout(node);
      if (layout) Graph.positions.set(node.id, { x: layout.x, y: layout.y });
    }
    const maxRight = Math.max(0, ...visible.map((node) => (Graph.positions.get(node.id)?.x || 0) + widthOf(node.id) / 2));
    const maxBottom = Math.max(0, ...visible.map((node) => (Graph.positions.get(node.id)?.y || 0) + cardHeight(node.id) / 2));
    Graph.width = Math.max(700, cursor + padding - rootGap, maxRight + padding);
    const lastLayerHeight = layerHeights.get(maxDepth) || 90;
    Graph.height = Math.max(430, (layerY.get(maxDepth) || top) + lastLayerHeight / 2 + 120, maxBottom + 140);
  }

  function edgePath(from, to, parentHeight, childHeight) {
    const rawStartY = from.y + parentHeight / 2 + 10;
    const rawEndY = to.y - childHeight / 2 - 10;
    const startY = Math.min(rawStartY, rawEndY - 24);
    const endY = Math.max(rawEndY, startY + 24);
    const curveY = startY + (endY - startY) / 2;
    return `M ${from.x} ${startY} C ${from.x} ${curveY}, ${to.x} ${curveY}, ${to.x} ${endY}`;
  }

  function edgeColorClass(edge) {
    return ["check", "followup", "custom"].includes(edge.branch) ? edge.branch : "question";
  }

  function renderEdges() {
    DOM.edges.replaceChildren(); DOM.edges.setAttribute("width", Graph.width); DOM.edges.setAttribute("height", Graph.height);
    DOM.edges.style.width = `${Graph.width}px`; DOM.edges.style.height = `${Graph.height}px`;
    DOM.edges.setAttribute("viewBox", `0 0 ${Graph.width} ${Graph.height}`);
    const defs = document.createElementNS(SVG_NS, "defs");
    const glow = document.createElementNS(SVG_NS, "filter");
    glow.setAttribute("id", "edge-glow");
    // Percentage/objectBoundingBox filter regions collapse to zero width for
    // a perfectly vertical middle branch. Use graph coordinates so the glow
    // cannot clip the blue path merely because its geometric bbox is narrow.
    glow.setAttribute("filterUnits", "userSpaceOnUse");
    glow.setAttribute("x", "-64"); glow.setAttribute("y", "-64");
    glow.setAttribute("width", String(Graph.width + 128));
    glow.setAttribute("height", String(Graph.height + 128));
    const blur = document.createElementNS(SVG_NS, "feGaussianBlur"); blur.setAttribute("stdDeviation", "2.4"); blur.setAttribute("result", "blur");
    const merge = document.createElementNS(SVG_NS, "feMerge");
    const glowNode = document.createElementNS(SVG_NS, "feMergeNode"); glowNode.setAttribute("in", "blur");
    const sourceNode = document.createElementNS(SVG_NS, "feMergeNode"); sourceNode.setAttribute("in", "SourceGraphic");
    merge.append(glowNode, sourceNode); glow.append(blur, merge); defs.append(glow); DOM.edges.append(defs);

    const edgeGroups = new Map();
    for (const branch of ["question", ...BRANCH_ORDER]) {
      const group = document.createElementNS(SVG_NS, "g");
      group.classList.add(`edges-${branch}`);
      DOM.edges.append(group);
      edgeGroups.set(branch, group);
    }
    const expectedEdges = Graph.model.edges.length;
    let renderedEdges = 0;
    const missingEdges = [];
    for (const edgeData of Graph.model.edges) {
      const from = Graph.positions.get(edgeData.from);
      const to = Graph.positions.get(edgeData.to);
      if (!from || !to) { missingEdges.push(edgeData); continue; }
      const edge = document.createElementNS(SVG_NS, "path");
      edge.classList.add("graph-edge", edgeColorClass(edgeData));
      edge.dataset.from = edgeData.from;
      edge.dataset.to = edgeData.to;
      edge.dataset.relation = edgeData.relation;
      edge.setAttribute("d", edgePath(from, to, cardHeight(edgeData.from), cardHeight(edgeData.to)));
      edgeGroups.get(edgeColorClass(edgeData)).append(edge);
      renderedEdges += 1;
    }
    DOM.edges.dataset.expectedEdges = String(expectedEdges);
    DOM.edges.dataset.renderedEdges = String(renderedEdges);
    DOM.edges.dataset.missingEdges = String(missingEdges.length);
    DOM.edges.dataset.graphWarnings = String(Graph.model.warnings.length);
    if (missingEdges.length || Graph.model.warnings.length) {
      console.error("Quiz graph integrity warning", { warnings: Graph.model.warnings, missingEdges });
    }
  }

  function updateNodeElement(node, focusDepth) {
    const element = ensureNodeElement(node); const branch = normalizeBranch(node.branch_type);
    const position = Graph.positions.get(node.id); if (position) { element.style.left = `${position.x}px`; element.style.top = `${position.y}px`; }
    applyNodeLayoutStyle(node, element);
    const concealed = State.concealedNodes.has(node.id);
    const isFoldRoot = Graph.model?.foldState?.activeRoots.has(node.id) || false;
    element.dataset.branch = branch; element.classList.toggle("is-current", node.id === State.currentNodeId); element.classList.toggle("is-concealed", concealed);
    element.classList.toggle("has-branches", childNodes(node.id).length > 1);
    element.classList.toggle("is-fold-root", isFoldRoot);
    // Full text is read in the right pane. Keep graph cards compact by
    // default; explicit "展开" remains the only way to open a card.
    const expandedByRule = false;
    const expanded = State.forcedExpanded.has(node.id) ? true : (State.forcedCollapsed.has(node.id) ? false : expandedByRule);
    element.classList.toggle("is-expanded", expanded);
    const branchText = element.querySelector(".node-branch");
    branchText.textContent = BRANCH_LABELS[branch] || "学习回应";
    const continueButton = element.querySelector(".node-action-continue");
    const collapseButton = element.querySelector(".node-action-fold");
    const concealButton = element.querySelector(".node-action-conceal");
    continueButton.textContent = node.role === "assistant" ? "从这里继续" : "回到上层";
    if (childNodes(node.id).length > 0) {
      // 有后代：按钮语义 = 折叠 / 展开整棵子树（奏折式）
      collapseButton.textContent = isFoldRoot ? "展开" : "收起";
      collapseButton.setAttribute("aria-expanded", String(!isFoldRoot));
      collapseButton.setAttribute("aria-label", isFoldRoot ? "展开子树" : "收起子树");
    } else {
      collapseButton.textContent = expanded ? "收起" : "展开";
      collapseButton.setAttribute("aria-expanded", String(expanded));
      collapseButton.setAttribute("aria-label", expanded ? "收起节点内容" : "展开节点内容");
    }
    concealButton.textContent = concealed ? "已隐藏" : "隐藏";
    const concealOverlay = element.querySelector(".node-conceal-overlay");
    const semanticSummary = element.querySelector(".node-conceal-summary");
    concealOverlay.hidden = !concealed;
    semanticSummary.className = `node-conceal-summary ${branch}`;
    semanticSummary.textContent = nodeSummary(node) || "摘要生成中…";
    if (node.role !== "assistant") return;
    const used = new Set(childNodes(node.id).map((child) => normalizeBranch(child.branch_type)));
    element.querySelectorAll(".branch-slot").forEach((button) => {
      const slot = button.dataset.slot; const occupied = used.has(slot);
      button.disabled = occupied || used.size >= State.maxBranches;
      button.classList.toggle("is-used", occupied);
      button.textContent = slot === "custom" ? (occupied ? "其他 · 已用" : "＋ 其他") : (slot === "check" ? (occupied ? "验收 · 已用" : "验收") : (occupied ? "追问 · 已用" : "追问"));
      button.title = occupied ? "这个分支已经创建" : `从这里开始${BRANCH_LABELS[slot]}分支`;
    });
  }

  function renderMinimap() {
    const visible = State.nodes.length > 3; DOM.minimap.hidden = !visible; if (!visible) return;
    DOM.minimapSvg.replaceChildren(); DOM.minimapSvg.setAttribute("viewBox", `0 0 ${Graph.width} ${Graph.height}`);
    const defs = document.createElementNS(SVG_NS, "defs");
    const glow = document.createElementNS(SVG_NS, "filter");
    glow.setAttribute("id", "mini-edge-glow");
    glow.setAttribute("filterUnits", "userSpaceOnUse");
    glow.setAttribute("x", "-64"); glow.setAttribute("y", "-64");
    glow.setAttribute("width", String(Graph.width + 128));
    glow.setAttribute("height", String(Graph.height + 128));
    const blur = document.createElementNS(SVG_NS, "feGaussianBlur"); blur.setAttribute("stdDeviation", "2.4"); blur.setAttribute("result", "blur");
    const merge = document.createElementNS(SVG_NS, "feMerge");
    const blurNode = document.createElementNS(SVG_NS, "feMergeNode"); blurNode.setAttribute("in", "blur");
    const sourceNode = document.createElementNS(SVG_NS, "feMergeNode"); sourceNode.setAttribute("in", "SourceGraphic");
    merge.append(blurNode, sourceNode); glow.append(blur, merge); defs.append(glow); DOM.minimapSvg.append(defs);
    let renderedEdges = 0;
    for (const edgeData of Graph.model.edges) {
      const from = Graph.positions.get(edgeData.from), to = Graph.positions.get(edgeData.to);
      if (!from || !to) continue;
      const edge = document.createElementNS(SVG_NS, "path");
      edge.classList.add("mini-edge", edgeColorClass(edgeData));
      edge.dataset.from = edgeData.from;
      edge.dataset.to = edgeData.to;
      edge.dataset.relation = edgeData.relation;
      edge.setAttribute("d", edgePath(from, to, 0, 0));
      DOM.minimapSvg.append(edge);
      renderedEdges += 1;
    }
    DOM.minimapSvg.dataset.expectedEdges = String(Graph.model.edges.length);
    DOM.minimapSvg.dataset.renderedEdges = String(renderedEdges);
    for (const node of State.nodes) {
      const pos = Graph.positions.get(node.id); if (!pos) continue;
      const rect = document.createElementNS(SVG_NS, "rect"); rect.classList.add("mini-node", node.role, normalizeBranch(node.branch_type));
      rect.setAttribute("x", pos.x - 5); rect.setAttribute("y", pos.y - 4); rect.setAttribute("width", 10); rect.setAttribute("height", 8); rect.setAttribute("rx", 3); DOM.minimapSvg.append(rect);
    }
    const viewportRect = document.createElementNS(SVG_NS, "rect"); viewportRect.classList.add("mini-viewport");
    const rect = DOM.viewport.getBoundingClientRect(); viewportRect.setAttribute("x", Math.max(0, -Graph.tx / Graph.scale)); viewportRect.setAttribute("y", Math.max(0, -Graph.ty / Graph.scale));
    viewportRect.setAttribute("width", Math.min(Graph.width, rect.width / Graph.scale)); viewportRect.setAttribute("height", Math.min(Graph.height, rect.height / Graph.scale)); DOM.minimapSvg.append(viewportRect);
  }

  function applyTransform() {
    Graph.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Graph.scale));
    const overviewMode = Graph.scale < OVERVIEW_SCALE;
    if (Graph.overviewMode !== overviewMode) {
      Graph.overviewMode = overviewMode;
      DOM.viewport.classList.toggle("is-overview", overviewMode);
      requestAnimationFrame(() => renderGraph());
    }
    DOM.world.style.transform = `translate(${Graph.tx}px, ${Graph.ty}px) scale(${Graph.scale})`;
    DOM.zoomLabel.textContent = `${Math.round(Graph.scale * 100)}%`; renderMinimap();
  }

  function renderGraph(options = {}) {
    const { reflow = true } = options;
    DOM.emptyState.hidden = State.nodes.length > 0; DOM.nodeCount.textContent = String(State.nodes.length);
    Graph.model = buildGraphModel();
    const focusNode = nodeById(State.currentNodeId); const focusDepth = focusNode ? depthOf(focusNode.id) : Math.max(0, ...State.nodes.map((node) => depthOf(node.id)));
    const rootQuestion = State.nodes.find((node) => node.role === "user" && !node.parent_id)?.content;
    DOM.studyApp?.classList.toggle("has-tree", State.nodes.length > 0);
    if (DOM.workspaceTitle) DOM.workspaceTitle.textContent = State.sessionTitle || compactText(rootQuestion || "未命名学习主题");
    if (DOM.workspaceMeta) DOM.workspaceMeta.textContent = `${State.nodes.length} 个节点 · 当前深度 ${focusDepth}`;
    const liveIds = new Set(State.nodes.map((node) => node.id));
    for (const [id, element] of Graph.elements) if (!liveIds.has(id)) { element.remove(); Graph.elements.delete(id); }
    for (const node of State.nodes) ensureNodeElement(node);
    // Apply collapsed/expanded classes before measuring card heights. The
    // edges are drawn only after layout and real DOM dimensions are known.
    for (const node of State.nodes) updateNodeElement(node, focusDepth);
    // reflow=false 用于折叠/展开：保留现有节点位置，只更新折叠状态与牌堆，
    // 避免"树在脚下跳"。结构变化（增删节点、展开正文等）仍走完整重排。
    if (reflow) buildLayout();
    for (const node of State.nodes) updateNodeElement(node, focusDepth);
    renderEdges();
    DOM.world.style.width = `${Graph.width}px`; DOM.world.style.height = `${Graph.height}px`; applyTransform();
    applyDeckTransforms();
    updateBulkVisibilityControls();
  }

  function appendNode(node, options = {}) {
    if (!node || nodeById(node.id)) return;
    State.nodes.push(node); ensureNodeElement(node); renderGraph();
    if (options.select !== false) setCurrentNode(node.id);
  }

  function renderInitialNodes(nodes) {
    State.nodes = []; State.currentNodeId = null; State.forcedExpanded.clear(); State.forcedCollapsed.clear(); State.concealedNodes.clear(); State.summaryJobs.clear();
    Graph.elements.clear(); DOM.nodesLayer.replaceChildren();
    State.nodes = Array.isArray(nodes) ? nodes.filter((node) => node && node.id) : [];
    const liveIds = new Set(State.nodes.map((node) => node.id));
    const parentIds = new Set(State.nodes.filter((node) => node.parent_id).map((node) => node.parent_id));
    for (const id of [...State.foldedBranches]) {
      if (!liveIds.has(id) || !parentIds.has(id)) State.foldedBranches.delete(id);
    }
    for (const node of State.nodes) ensureNodeElement(node);
    renderGraph();
    setCurrentNode(State.nodes.length ? State.nodes[State.nodes.length - 1].id : null, { center: false });
    if (State.nodes.length) scheduleFit(); else { Graph.tx = 0; Graph.ty = 0; applyTransform(); }
  }

  function appendLoading(jobId) {
    const loading = document.createElement("div"); loading.className = "loading-node"; loading.id = `loading-${jobId}`; loading.textContent = "惠正在整理这条思路"; DOM.viewport.append(loading);
  }
  function removeLoading(jobId) { document.getElementById(`loading-${jobId}`)?.remove(); }
  function appendError(message) { const error = document.createElement("div"); error.className = "inline-error"; error.textContent = message; DOM.viewport.append(error); window.setTimeout(() => error.remove(), 5000); }

  async function pollJob(jobId, generation = State.sessionGeneration) {
    if (generation !== State.sessionGeneration) {
      removeLoading(jobId);
      return;
    }
    try {
      const job = await API.getJob(jobId);
      if (generation !== State.sessionGeneration || job.session_id !== State.sessionId) {
        State.pendingJobs.delete(jobId); removeLoading(jobId); return;
      }
      if (job.status === "pending" || job.status === "running") { State.pendingJobs.set(jobId, true); window.setTimeout(() => pollJob(jobId, generation), 700); return; }
      State.pendingJobs.delete(jobId); removeLoading(jobId); setQuota(job.quota);
      if (job.status === "completed") {
        appendNode({ id: job.assistant_node_id, session_id: job.session_id, parent_id: job.user_node_id, role: "assistant", branch_type: job.branch_slot || normalizeBranch(nodeById(job.user_node_id)?.branch_type), content: job.answer || "（没有收到有效回答）" });
      } else appendError(job.error === "quiz provider is not configured" ? "学习服务尚未配置，请先设置 TEXTREE_API_KEY。" : "这次学习请求没有完成，可以稍后重试。");
      DOM.sendButton.disabled = false;
    } catch (error) {
      State.pendingJobs.delete(jobId); removeLoading(jobId);
      appendError("无法确认学习请求状态，请刷新后查看。");
      DOM.sendButton.disabled = false;
    }
  }

  async function submitMessage(event) {
    event.preventDefault(); const question = DOM.messageInput.value.trim();
    if (!question || State.pendingJobs.size >= 2) return;
    DOM.sendButton.disabled = true; DOM.composerHint.textContent = "请求已进入学习队列……";
    try {
      const result = await API.ask({ session_id: State.sessionId, parent_node_id: branchParentId(), interaction_type: State.interactionType, question });
      setQuota(result.quota); appendNode(result.user_node); DOM.messageInput.value = "";
      State.pendingJobs.set(result.job_id, true); appendLoading(result.job_id); window.setTimeout(() => pollJob(result.job_id, State.sessionGeneration), 200);
    } catch (error) {
      if (error.code === "tree_branch_slot_used") appendError("这个分支已经用过了。请选择回答下方的另一个出口。");
      else if (error.code === "tree_branch_limit_reached") appendError("这个回答下已经有三个分支，继续学习请回到其他节点。");
      else appendError(error.message || "无法发送这条问题。");
      DOM.sendButton.disabled = false;
    } finally { DOM.composerHint.textContent = "Enter 发送 · Shift + Enter 换行"; }
  }

  function chooseInteractionType(type) {
    if (type === "skip") { setCurrentNode(null); State.interactionType = "question"; }
    else State.interactionType = type;
    DOM.messageInput.placeholder = BRANCH_PLACEHOLDERS[State.interactionType] || BRANCH_PLACEHOLDERS.question;
    document.querySelectorAll("[data-interaction]").forEach((button) => button.classList.toggle("is-selected", button.dataset.interaction === State.interactionType));
    DOM.messageInput.focus();
  }
  function chooseInteraction(button) { chooseInteractionType(button.dataset.interaction); }

  function fitGraph() {
    if (!State.nodes.length) return;
    const rect = DOM.viewport.getBoundingClientRect(); const pad = 70;
    Graph.scale = Math.max(MIN_SCALE, Math.min(1.05, (rect.width - pad * 2) / Graph.width, (rect.height - pad * 2) / Graph.height));
    Graph.tx = (rect.width - Graph.width * Graph.scale) / 2; Graph.ty = (rect.height - Graph.height * Graph.scale) / 2; applyTransform();
  }
  function scheduleFit() {
    // 首帧布局可能尚未稳定：双 rAF + 超时兜底重 fit，确保用最终视口尺寸居中
    requestAnimationFrame(() => requestAnimationFrame(() => fitGraph()));
    window.setTimeout(() => { if (State.nodes.length) fitGraph(); }, 250);
  }
  function centerOnNode(id) {
    const position = Graph.positions.get(id); if (!position) return;
    const rect = DOM.viewport.getBoundingClientRect(); Graph.tx = rect.width / 2 - position.x * Graph.scale; Graph.ty = rect.height / 2 - position.y * Graph.scale; applyTransform();
  }
  function zoomAt(clientX, clientY, factor) {
    const rect = DOM.viewport.getBoundingClientRect(); const localX = clientX - rect.left; const localY = clientY - rect.top;
    const worldX = (localX - Graph.tx) / Graph.scale; const worldY = (localY - Graph.ty) / Graph.scale;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Graph.scale * factor)); Graph.tx = localX - worldX * next; Graph.ty = localY - worldY * next; Graph.scale = next; applyTransform();
  }

  function setupCanvas() {
    // 滚轮悬停画布即缩放，无需空格；不再依赖任何输入框焦点。
    // 唯一例外：滚轮在可滚动内容上（展开卡片正文等）时放行原生滚动。
    DOM.viewport.addEventListener("wheel", (event) => {
      const scrollable = event.target.closest(".node-content, textarea, input, [contenteditable='true']");
      if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) return;
      event.preventDefault(); zoomAt(event.clientX, event.clientY, Math.pow(1.0018, -event.deltaY));
    }, { passive: false });
    DOM.viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      if (event.target.closest(".graph-node, .minimap, button, textarea, input")) return;
      event.preventDefault();  // 平移时不触发原生拖拽/文本选区
      Graph.dragging = true; Graph.pointerId = event.pointerId; Graph.lastPointer = { x: event.clientX, y: event.clientY }; DOM.viewport.classList.add("is-panning"); DOM.viewport.setPointerCapture(event.pointerId);
    });
    DOM.viewport.addEventListener("selectstart", (event) => {
      if (Graph.dragging) event.preventDefault();  // 平移中禁止文本选区
    });
    DOM.viewport.addEventListener("pointermove", (event) => {
      if (!Graph.dragging || event.pointerId !== Graph.pointerId) return;
      Graph.tx += event.clientX - Graph.lastPointer.x; Graph.ty += event.clientY - Graph.lastPointer.y; Graph.lastPointer = { x: event.clientX, y: event.clientY }; applyTransform();
    });
    const stopPan = (event) => { if (event.pointerId !== Graph.pointerId) return; Graph.dragging = false; DOM.viewport.classList.remove("is-panning"); };
    DOM.viewport.addEventListener("pointerup", stopPan); DOM.viewport.addEventListener("pointercancel", stopPan);
    // 空格键已不再承担任何画布职责（滚轮缩放改为直接绑定画布）：
    // 移除 spaceHeld 状态，避免焦点切换导致"空格卡在画布里"的残留问题。
    window.addEventListener("pointermove", moveNodePointer, { passive: false });
    window.addEventListener("pointerup", finishNodePointer);
    window.addEventListener("pointercancel", finishNodePointer);
    DOM.minimapSvg.addEventListener("click", (event) => {
      if (State.nodes.length <= 3) return;
      const rect = DOM.minimapSvg.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width * Graph.width; const y = (event.clientY - rect.top) / rect.height * Graph.height; const viewport = DOM.viewport.getBoundingClientRect();
      Graph.tx = viewport.width / 2 - x * Graph.scale; Graph.ty = viewport.height / 2 - y * Graph.scale; applyTransform();
    });
    DOM.fitGraphButton.addEventListener("click", fitGraph); DOM.zoomInButton.addEventListener("click", () => zoomAt(DOM.viewport.getBoundingClientRect().left + DOM.viewport.clientWidth / 2, DOM.viewport.getBoundingClientRect().top + DOM.viewport.clientHeight / 2, 1.16));
    DOM.zoomOutButton.addEventListener("click", () => zoomAt(DOM.viewport.getBoundingClientRect().left + DOM.viewport.clientWidth / 2, DOM.viewport.getBoundingClientRect().top + DOM.viewport.clientHeight / 2, .86));

    // 按钮点击后立即失焦：避免焦点留在按钮上，导致"空格+滚轮缩放/平移"失效
    // （空格守卫会忽略 focus 在 button 上的按键）。同时覆盖折叠/隐藏等节点按钮。
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (button) button.blur();
    });

    // 窗口尺寸变化时重新居中
    let _resizeTimer = null;
    window.addEventListener("resize", () => {
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = window.setTimeout(() => { if (State.nodes.length) fitGraph(); }, 200);
    });
    // 字体就绪后重新布局+居中（防止测量用的是回退字体）
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (State.nodes.length) { renderGraph(); fitGraph(); }
      });
    }
  }

  function setupResponsivePanels() {
    const panels = {
      history: { panel: DOM.sessionRail, toggle: DOM.historyPanelToggle },
      reader: { panel: DOM.readerPanel, toggle: DOM.readerPanelToggle },
    };
    const closePanels = () => {
      for (const { panel, toggle } of Object.values(panels)) {
        panel?.classList.remove("is-panel-open");
        toggle?.setAttribute("aria-expanded", "false");
      }
      if (DOM.panelBackdrop) DOM.panelBackdrop.hidden = true;
      document.body.classList.remove("has-open-workspace-panel");
    };
    const togglePanel = (name) => {
      const target = panels[name];
      if (!target?.panel || window.innerWidth >= 1360) return;
      const shouldOpen = !target.panel.classList.contains("is-panel-open");
      closePanels();
      if (!shouldOpen) return;
      target.panel.classList.add("is-panel-open");
      target.toggle?.setAttribute("aria-expanded", "true");
      if (DOM.panelBackdrop) DOM.panelBackdrop.hidden = false;
      document.body.classList.add("has-open-workspace-panel");
    };
    DOM.historyPanelToggle?.addEventListener("click", () => togglePanel("history"));
    DOM.readerPanelToggle?.addEventListener("click", () => togglePanel("reader"));
    DOM.panelBackdrop?.addEventListener("click", closePanels);
    window.addEventListener("keydown", (event) => { if (event.key === "Escape") closePanels(); });
    window.addEventListener("resize", () => { if (window.innerWidth >= 1360) closePanels(); });
  }

  function resumeActiveJobs(result) {
    // 刷新后恢复进行中的学习任务轮询，回答完成后自动挂上新节点
    const jobs = Array.isArray(result.active_jobs) ? result.active_jobs : [];
    for (const job of jobs) {
      if (State.pendingJobs.has(job.id)) continue;
      State.pendingJobs.set(job.id, true);
      appendLoading(job.id);
      window.setTimeout(() => pollJob(job.id, State.sessionGeneration), 200);
    }
    if (jobs.length) DOM.sendButton.disabled = false;
  }

  async function loadSession() {
    const result = await API.getSession();
    State.sessionId = result.session.id; activateFoldSession(State.sessionId); State.maxBranches = result.max_branches || 3;
    State.sessionTitle = result.session.title || result.session.root_question || "";
    setQuota(result.quota); renderInitialNodes(result.nodes);
    resumeActiveJobs(result);
    // Keep a delayed fallback independent of the initial request. In some
    // browsers the access-cookie response and the first history request can
    // complete out of order; the refresh button should not be required.
    window.setTimeout(() => {
      if (State.sessionId && !DOM.sessionList.querySelector(".session-item")) {
        loadSessionHistory();
      }
    }, 1200);
    await loadSessionHistory();
    if (!DOM.sessionList.querySelector(".session-item")) {
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      await loadSessionHistory();
    }
  }

  async function loadSessionById(sessionId) {
    if (sessionId === State.sessionId) return;
    if (State.pendingJobs.size > 0 && !window.confirm("仍有学习请求处理中，切换主题会忽略它们，确定继续吗？")) return;
    const result = await API.getSessionById(sessionId);
    State.sessionGeneration += 1; clearPendingJobs();
    State.sessionId = result.session.id; activateFoldSession(State.sessionId); State.maxBranches = result.max_branches || State.maxBranches;
    State.sessionTitle = result.session.title || result.session.root_question || "";
    setQuota(result.quota); renderInitialNodes(result.nodes);
    resumeActiveJobs(result);
    chooseInteractionType("question"); await loadSessionHistory();
  }

  async function exportSession() {
    if (!State.sessionId || !State.nodes.length) { appendError("当前主题还没有可以导出的节点。"); return; }
    const scope = DOM.exportScope.value;
    const format = DOM.exportFormat.value;
    const params = new URLSearchParams({ format, scope });
    if (scope !== "tree" && State.currentNodeId) params.set("node_id", State.currentNodeId);
    DOM.exportButton.disabled = true;
    try {
      const response = await fetch(`/api/quiz/sessions/${encodeURIComponent(State.sessionId)}/export?${params}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "导出失败");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = "";
      document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    } catch (error) {
      appendError(error.message || "导出失败，请稍后重试。");
    } finally { DOM.exportButton.disabled = false; }
  }
  async function createNewSession() {
    if (State.pendingJobs.size > 0 && !window.confirm("仍有学习请求处理中，确定开始新主题吗？")) return;
    const result = await API.createSession();
    State.sessionGeneration += 1;
    clearPendingJobs();
    State.sessionId = result.session.id; activateFoldSession(State.sessionId); State.maxBranches = result.max_branches || State.maxBranches;
    State.sessionTitle = "";
    renderInitialNodes([]); setQuota(result.quota); DOM.messageInput.value = ""; chooseInteractionType("question"); DOM.messageInput.focus(); await loadSessionHistory();
  }
  DOM.messageForm.addEventListener("submit", submitMessage);
  DOM.messageInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); DOM.messageForm.requestSubmit(); } });
  document.querySelectorAll("[data-interaction]").forEach((button) => button.addEventListener("click", () => chooseInteraction(button)));
  DOM.clearContextButton.addEventListener("click", () => chooseInteractionType("skip"));
  DOM.readerFocusButton.addEventListener("click", () => {
    if (State.readerNodeId) {
      setCurrentNode(State.readerNodeId);
      centerOnNode(State.readerNodeId);
    }
  });
  if (DOM.readerRevealButton) DOM.readerRevealButton.addEventListener("click", () => {
    if (State.readerNodeId) revealNode(State.readerNodeId);
  });
  DOM.refreshSessionsButton.addEventListener("click", () => loadSessionHistory());
  DOM.exportButton.addEventListener("click", () => exportSession());
  if (DOM.concealAllButton) DOM.concealAllButton.addEventListener("click", concealAllNodes);
  if (DOM.revealAllButton) DOM.revealAllButton.addEventListener("click", revealAllNodes);
  DOM.newSessionButton.addEventListener("click", () => createNewSession().catch((error) => appendError(error.message)));
  setupCanvas(); setupResponsivePanels(); renderGraph(); loadSession();
})();
