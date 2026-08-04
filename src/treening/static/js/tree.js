(() => {
  "use strict";

  const State = {
    sessionId: null,
    sessionTitle: "",
    nodes: [],
    viewMode: "tree",
    maxBranches: 3,
    currentNodeId: null,
    pathTargetNodeId: null,
    readerNodeId: null,
    interactionType: "question",
    pendingJobs: new Map(),
    sessionGeneration: 0,
    foldedBranches: new Set(),  // 当前会话的用户折叠意图；有效/潜伏根由解析层推导
    foldedBranchesBySession: new Map(),
    concealedNodes: new Set(),
    summaryJobs: new Map(),
    layoutSaveTimers: new Map(),
    canvasUndo: window.TreeningHistoryState.createUndoStack(30),
    viewTransitionTimer: null,
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
    nodeCount: $("#node-count"),
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
    fitGraphButton: $("#fit-graph-button"), undoCanvasButton: $("#undo-canvas-button"), zoomInButton: $("#zoom-in-button"),
    zoomOutButton: $("#zoom-out-button"),
    treeViewButton: $("#tree-view-button"), nearbyViewButton: $("#nearby-view-button"), pathViewButton: $("#path-view-button"),
    readerPanel: $("#reader-panel"), readerEmpty: $("#reader-empty"), readerView: $("#reader-view"),
    readerRole: $("#reader-role"), readerBranch: $("#reader-branch"), readerDepth: $("#reader-depth"),
    readerContent: $("#reader-content"), readerConcealed: $("#reader-concealed"),
    readerConcealedSummary: $("#reader-concealed-summary") || $("#reader-concealed-hint"), readerMeta: $("#reader-meta"),
    readerContext: $("#reader-context"), readerPath: $("#reader-path"), readerParent: $("#reader-parent"),
    readerDescendants: $("#reader-descendants"), readerFoldButton: $("#reader-fold-button"),
    readerConcealButton: $("#reader-conceal-button"), readerExportPathButton: $("#reader-export-path-button"),
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
    check: "写下你的理解，Treening 会和你一起检查……",
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
    deleteSession(sessionId) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }); },
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
    DOM.quotaLabel.hidden = Boolean(quota.unlimited);
    DOM.quotaLabel.textContent = quota.unlimited
      ? "今日提问不限"
      : `今日剩余 ${quota.remaining} / ${quota.max}`;
  }

  function formatSessionDate(value) {
    if (!value) return "未记录时间";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "未记录时间" : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  function formatSessionMoment(value) {
    if (!value) return "未记录时间";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未记录时间";
    const today = new Date();
    const sameDay = date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate();
    return sameDay
      ? `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`
      : formatSessionDate(value);
  }

  function createSessionItem(item, draft = false) {
    const active = item.id === State.sessionId;
    const shell = document.createElement("div"); shell.className = "session-item-shell";
    shell.classList.toggle("is-active", active);
    const button = document.createElement("button");
    button.type = "button"; button.className = "session-item";
    button.classList.toggle("is-active", active);
    button.classList.toggle("is-draft", draft);
    const marker = document.createElement("span"); marker.className = "session-item-marker";
    const content = document.createElement("span"); content.className = "session-item-content";
    const title = document.createElement("span"); title.className = "session-item-title";
    title.textContent = item.title || item.root_question || "未命名学习主题";
    const meta = document.createElement("span"); meta.className = "session-item-meta";
    const count = document.createElement("span"); count.textContent = draft ? "尚未开始" : `${item.node_count || 0} 个节点`;
    const moment = document.createElement("span"); moment.textContent = formatSessionMoment(item.updated_at);
    meta.append(count, moment); content.append(title, meta); button.append(marker, content);
    button.setAttribute("aria-label", `${title.textContent}，${count.textContent}，${moment.textContent}`);
    button.addEventListener("click", () => {
      loadSessionById(item.id).catch((error) => appendError(error.message || "历史主题加载失败，请稍后重试。"));
    });
    shell.append(button);
    if (active) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button"; deleteButton.className = "session-delete-button";
      const deleteIcon = document.createElement("span");
      deleteIcon.textContent = "×";
      deleteIcon.setAttribute("aria-hidden", "true");
      deleteButton.append(deleteIcon);
      deleteButton.title = "删除当前学习轨迹";
      deleteButton.setAttribute("aria-label", `删除学习轨迹：${title.textContent}`);
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteLearningSession(item, deleteButton);
      });
      shell.append(deleteButton);
    }
    return shell;
  }

  function appendSessionGroup(label, sessions, className = "") {
    if (!sessions.length) return;
    const group = document.createElement("section"); group.className = `session-group ${className}`.trim();
    const heading = document.createElement("div"); heading.className = "session-group-heading";
    const title = document.createElement("span"); title.textContent = label;
    const count = document.createElement("span"); count.textContent = String(sessions.length);
    heading.append(title, count); group.append(heading);
    for (const item of sessions) group.append(createSessionItem(item, className === "session-group-drafts"));
    DOM.sessionList.append(group);
  }

  function renderSessionList(sessions) {
    DOM.sessionList.replaceChildren();
    if (!sessions.length) {
      const empty = document.createElement("span"); empty.className = "history-empty"; empty.textContent = "暂无历史主题";
      DOM.sessionList.append(empty); return;
    }
    const groups = window.TreeningHistoryState.groupSessions(sessions);
    appendSessionGroup("今天", groups.today);
    appendSessionGroup("最近 7 天", groups.recent);
    appendSessionGroup("更早", groups.earlier);
    appendSessionGroup("草稿", groups.drafts, "session-group-drafts");
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

  async function deleteLearningSession(item, button) {
    if (!item?.id || item.id !== State.sessionId) return;
    const title = item.title || item.root_question || "未命名学习主题";
    const pendingWarning = State.pendingJobs.size
      ? "\n\n当前仍有学习请求正在处理，删除后也会一并停止显示。"
      : "";
    const confirmed = window.confirm(`确定永久删除“${title}”吗？\n\n其中的全部节点和回复都会被删除，且无法撤销。${pendingWarning}`);
    if (!confirmed) return;
    button.disabled = true;
    try {
      const deletedSessionId = item.id;
      await API.deleteSession(deletedSessionId);
      State.sessionGeneration += 1;
      clearPendingJobs();
      State.foldedBranchesBySession.delete(deletedSessionId);
      State.sessionId = null;
      const history = await API.listSessions();
      const next = (Array.isArray(history.sessions) ? history.sessions : [])
        .find((sessionItem) => sessionItem.id !== deletedSessionId);
      if (next) await loadSessionById(next.id);
      else await createNewSession();
    } catch (error) {
      if (!State.sessionId) {
        try {
          await loadSession();
          return;
        } catch (_recoveryError) {
          // Fall through to the visible error state if even a fresh session
          // cannot be established after the confirmed deletion.
        }
      }
      button.disabled = false;
      appendError(error.message || "无法删除这条学习轨迹，请稍后重试。");
      await loadSessionHistory();
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
    if (options.preservePathTarget !== true) State.pathTargetNodeId = State.currentNodeId;
    State.readerNodeId = State.currentNodeId;
    const node = nodeById(State.currentNodeId);
    DOM.contextLabel.textContent = node
      ? `回应「${node.content.slice(0, 42)}${node.content.length > 42 ? "…" : ""}」`
      : "从新的问题开始";
    DOM.clearContextButton.hidden = !node;
    renderReader();
    if (State.viewMode !== "tree") {
      markViewTransition();
      // 路径模式和折叠模式一样，只改变可见集合。已有节点沿用完整树
      // 中的世界坐标，不因兄弟节点消失而重新挤压、居中或跳位。
      renderGraph({ reflow: !Graph.positions.has(State.currentNodeId) });
    }
    else {
      // 完整树模式只更新高亮，避免点击节点时重建整图。
      for (const [id, el] of Graph.elements) el.classList.toggle("is-current", id === State.currentNodeId);
    }
    if (options.center !== false && node) centerOnNode(node.id);
  }

  function concealNode(nodeId, options = {}) {
    const node = nodeById(nodeId);
    if (!node || State.concealedNodes.has(nodeId)) return;
    if (options.record !== false) pushCanvasUndo(captureCanvasSnapshot());
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

  function revealNode(nodeId, options = {}) {
    if (!State.concealedNodes.has(nodeId)) return;
    if (options.record !== false) pushCanvasUndo(captureCanvasSnapshot());
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
    if (!State.nodes.some((node) => !State.concealedNodes.has(node.id))) return;
    pushCanvasUndo(captureCanvasSnapshot());
    State.nodes.forEach((node) => State.concealedNodes.add(node.id));
    renderGraph();
    renderReader();
    void ensureMissingSummaries(State.nodes.filter((node) => !nodeSummary(node)));
  }

  function revealAllNodes() {
    if (!State.concealedNodes.size) return;
    pushCanvasUndo(captureCanvasSnapshot());
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
    const viewTargetId = State.pathTargetNodeId || State.currentNodeId;
    const viewState = window.TreeningViewState.resolveViewState(State.nodes, viewTargetId, State.viewMode);
    // View selection and folding are independent layers. A path determines
    // which logical branch is in focus; active folded roots then contribute
    // their owned cards so the deck remains visible and reversible.
    const foldState = window.TreeningFoldState.resolveFoldState(State.nodes, State.foldedBranches);
    const displayIds = new Set(viewState.visibleIds);
    for (const rootId of foldState.activeRoots) {
      if (!displayIds.has(rootId)) continue;
      for (const memberId of foldState.deckMembers.get(rootId) || []) displayIds.add(memberId);
    }
    const nodes = State.nodes.filter((node) => displayIds.has(node.id));
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const children = new Map(nodes.map((node) => [node.id, []]));
    const roots = [];
    const edges = [];
    const warnings = [...viewState.warnings];

    // Pure resolver separates user intent from the roots that are currently
    // visible. Nested intents remain latent until their ancestor is reopened.
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

    return { nodes, nodeMap, children, roots, edges, warnings, foldedAway, foldState, viewState };
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
      if (DOM.readerContext) DOM.readerContext.hidden = true;
      return;
    }
    if (DOM.readerContext) DOM.readerContext.hidden = false;
    const branch = normalizeBranch(node.branch_type);
    const concealed = State.concealedNodes.has(node.id);
    DOM.readerRole.textContent = node.role === "user" ? "你" : "Treening";
    DOM.readerBranch.textContent = BRANCH_LABELS[branch] || "学习回应";
    DOM.readerDepth.textContent = `深度 ${displayDepth(node.id)}`;
    DOM.readerContent.textContent = node.content;
    DOM.readerContent.hidden = concealed;
    if (DOM.readerConcealed) DOM.readerConcealed.hidden = !concealed;
    if (DOM.readerConcealedSummary) DOM.readerConcealedSummary.textContent = nodeSummary(node) || "摘要生成中…";
    if (concealed) {
      DOM.readerRole.textContent = "";
      DOM.readerBranch.textContent = "";
      DOM.readerDepth.textContent = "";
      DOM.readerMeta.textContent = "";
    }
    DOM.readerMeta.textContent = concealed ? "" : `${node.content.length} 字 · 完整文本阅读`;
    const pathState = window.TreeningViewState.resolveViewState(State.nodes, node.id, "path");
    const pathNodes = pathState.pathIds.map((id) => nodeById(id)).filter(Boolean);
    const parent = node.parent_id ? nodeById(node.parent_id) : null;
    const descendantCount = Math.max(0, directSubtree(node.id).size - 1);
    if (DOM.readerPath) DOM.readerPath.textContent = pathNodes.map((item, index) => index === 0 ? "起点" : BRANCH_LABELS[normalizeBranch(item.branch_type)] || "回应").join(" → ");
    if (DOM.readerParent) DOM.readerParent.textContent = parent ? compactText(parent.content, 46) : "这是起点节点";
    if (DOM.readerDescendants) DOM.readerDescendants.textContent = `${descendantCount} 个节点`;
    if (DOM.readerFoldButton) {
      DOM.readerFoldButton.disabled = descendantCount === 0;
      DOM.readerFoldButton.textContent = State.foldedBranches.has(node.id) ? "展开后代" : "收起后代";
    }
    if (DOM.readerConcealButton) DOM.readerConcealButton.textContent = concealed ? "显示内容" : "隐藏内容";
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      DOM.readerView.classList.remove("is-refreshing");
      void DOM.readerView.offsetWidth;
      DOM.readerView.classList.add("is-refreshing");
    }
  }

  const NODE_MIN_WIDTH = 220;
  const NODE_MAX_WIDTH = 640;
  const NODE_MIN_HEIGHT = 90;
  const NODE_MAX_HEIGHT = 4800;
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

  function captureCanvasSnapshot() {
    return {
      layouts: State.nodes.map((node) => ({ id: node.id, ...layoutSnapshot(node) })),
      foldedBranches: [...State.foldedBranches],
      concealedNodes: [...State.concealedNodes],
      currentNodeId: State.currentNodeId,
      pathTargetNodeId: State.pathTargetNodeId,
      readerNodeId: State.readerNodeId,
    };
  }

  function updateCanvasUndoControl() {
    if (!DOM.undoCanvasButton) return;
    DOM.undoCanvasButton.disabled = State.canvasUndo.size === 0;
    DOM.undoCanvasButton.setAttribute("aria-label", State.canvasUndo.size
      ? `撤销上一步画布操作，尚有 ${State.canvasUndo.size} 步`
      : "暂无可撤销的画布操作");
  }

  function pushCanvasUndo(snapshot) {
    State.canvasUndo.push(snapshot);
    updateCanvasUndoControl();
  }

  function layoutsEqual(left, right) {
    return left && right && ["x", "y", "width", "height"].every((key) => Math.abs(left[key] - right[key]) < 0.01);
  }

  function undoCanvasAction() {
    const snapshot = State.canvasUndo.pop();
    if (!snapshot) return;
    const liveIds = new Set(State.nodes.map((node) => node.id));
    const layouts = new Map(snapshot.layouts.map((layout) => [layout.id, layout]));
    for (const node of State.nodes) {
      const previous = layouts.get(node.id);
      if (!previous) continue;
      const changed = !layoutsEqual(nodeLayout(node), previous);
      const restored = setNodeLayout(node, previous);
      Graph.positions.set(node.id, { x: restored.x, y: restored.y });
      if (changed) scheduleNodeLayoutSave(node);
    }
    State.foldedBranches.clear();
    snapshot.foldedBranches.filter((id) => liveIds.has(id)).forEach((id) => State.foldedBranches.add(id));
    State.concealedNodes.clear();
    snapshot.concealedNodes.filter((id) => liveIds.has(id)).forEach((id) => State.concealedNodes.add(id));
    State.currentNodeId = liveIds.has(snapshot.currentNodeId) ? snapshot.currentNodeId : null;
    State.pathTargetNodeId = liveIds.has(snapshot.pathTargetNodeId) ? snapshot.pathTargetNodeId : State.currentNodeId;
    State.readerNodeId = liveIds.has(snapshot.readerNodeId) ? snapshot.readerNodeId : State.currentNodeId;
    renderGraph({ reflow: false });
    const readerNodeId = State.readerNodeId;
    setCurrentNode(State.currentNodeId, { center: false, preservePathTarget: true });
    State.readerNodeId = readerNodeId;
    renderReader();
    updateCanvasUndoControl();
  }

  function usefulCardHeight(card) {
    if (!card) return NODE_DEFAULT_HEIGHT;
    const content = card.querySelector(".node-content");
    const header = card.querySelector(".node-header");
    const actions = card.querySelector(".node-actions");
    const naturalHeight = (content?.scrollHeight || 0)
      + (header?.offsetHeight || 0)
      + (actions?.offsetHeight || 0)
      + 2;
    return clamp(naturalHeight || NODE_DEFAULT_HEIGHT, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT);
  }

  function resolveResizeOverlaps(anchorId) {
    const visibleNodes = State.nodes.filter((node) => {
      const element = Graph.elements.get(node.id);
      return element && !element.classList.contains("is-view-hidden") && !element.classList.contains("is-folded");
    });
    const geometry = visibleNodes.map((node) => {
      const element = Graph.elements.get(node.id);
      const card = element.querySelector(".node-card");
      const position = Graph.positions.get(node.id) || { x: 0, y: 0 };
      const layout = nodeLayout(node);
      return {
        id: node.id,
        x: position.x,
        y: position.y,
        width: layout?.width || element.offsetWidth || 300,
        height: layout?.height || card.offsetHeight || NODE_DEFAULT_HEIGHT,
      };
    });
    const result = window.TreeningLayoutState.resolveOverlaps(geometry, anchorId, { gap: 40 });
    for (const nodeId of result.movedIds) {
      const node = nodeById(nodeId);
      const position = result.positions.get(nodeId);
      const element = Graph.elements.get(nodeId);
      if (!node || !position || !element) continue;
      const layout = setNodeLayout(node, { ...layoutSnapshot(node), x: position.x, y: position.y });
      Graph.positions.set(nodeId, { x: layout.x, y: layout.y });
      element.style.left = `${layout.x}px`;
      element.style.top = `${layout.y}px`;
      scheduleNodeLayoutSave(node);
    }
    if (result.movedIds.length) {
      const maxRight = Math.max(...geometry.map((item) => (result.positions.get(item.id)?.x || item.x) + item.width / 2));
      const maxBottom = Math.max(...geometry.map((item) => (result.positions.get(item.id)?.y || item.y) + item.height / 2));
      Graph.width = Math.max(Graph.width, maxRight + 240);
      Graph.height = Math.max(Graph.height, maxBottom + 180);
    }
    return result;
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
    const beforeSnapshot = captureCanvasSnapshot();
    const layout = setNodeLayout(node, layoutSnapshot(node, position));
    Graph.nodeDrag = {
      node, card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      originX: layout.x, originY: layout.y, moved: false, beforeSnapshot,
    };
    card.setPointerCapture?.(event.pointerId);
    card.classList.add("is-node-dragging");
    event.preventDefault(); event.stopPropagation();
  }

  function beginNodeResize(event, node, card) {
    if (event.button !== 0) return;
    const beforeSnapshot = captureCanvasSnapshot();
    const layout = setNodeLayout(node, layoutSnapshot(node));
    Graph.nodeResize = {
      node, card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      originWidth: layout.width, originHeight: layout.height, moved: false, beforeSnapshot,
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
        // Stop at the first height that reveals the complete reply. This
        // avoids both an unnecessary inner scrollbar and a tall empty card.
        height: Math.min(resize.originHeight + dy, usefulCardHeight(resize.card)),
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
      if (drag.moved) {
        pushCanvasUndo(drag.beforeSnapshot);
        scheduleNodeLayoutSave(drag.node);
      }
      Graph.nodeDrag = null;
      window.setTimeout(() => { if (Graph.suppressClickNodeId === drag.node.id) Graph.suppressClickNodeId = null; }, 0);
      refreshGraphGeometry();
      return;
    }
    const resize = Graph.nodeResize;
    if (resize && resize.pointerId === event.pointerId) {
      resize.card.releasePointerCapture?.(event.pointerId);
      resize.card.classList.remove("is-node-resizing");
      if (resize.moved) {
        scheduleNodeLayoutSave(resize.node);
        resolveResizeOverlaps(resize.node.id);
        pushCanvasUndo(resize.beforeSnapshot);
      }
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
    State.foldedBranches.add(nodeId);
    if (selectionWillHide) setCurrentNode(nodeId, { center: false, preservePathTarget: true });
    else if (readerWillHide) { State.readerNodeId = nodeId; renderReader(); }
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
    const subtree = directSubtree(nodeId);
    if (!nodeById(nodeId) || subtree.size <= 1) return;
    pushCanvasUndo(captureCanvasSnapshot());
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
    const count = directSubtree(node.id).size;
    const message = count > 1
      ? `删除这个问题及其后续 ${count - 1} 个节点吗？`
      : "删除这个问题吗？";
    if (!window.confirm(message)) return;
    try {
      const result = await API.deleteNode(State.sessionId, node.id);
      const deleted = new Set(result.deleted_node_ids || []);
      State.nodes = State.nodes.filter((item) => !deleted.has(item.id));
      State.foldedBranches = new Set([...State.foldedBranches].filter((id) => !deleted.has(id)));
      if (deleted.has(State.pathTargetNodeId)) State.pathTargetNodeId = result.parent_id || null;
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

  function setBranchDrawerOpen(article, open) {
    if (!article) return;
    article.classList.toggle("is-drawer-open", Boolean(open));
    article.querySelector(".node-action-drawer")?.setAttribute("aria-expanded", String(Boolean(open)));
  }

  function closeBranchDrawers(except = null) {
    DOM.nodesLayer.querySelectorAll(".graph-node.is-drawer-open").forEach((element) => {
      if (element !== except) setBranchDrawerOpen(element, false);
    });
  }

  function createNodeElement(node) {
    const article = document.createElement("article");
    article.className = `graph-node ${node.role}`;
    article.dataset.nodeId = node.id;
    const card = document.createElement("div"); card.className = "node-card";
    card.tabIndex = 0;
    // The card contains real buttons; use a labelled group instead of nesting
    // interactive controls inside another ARIA button.
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", `阅读${node.role === "user" ? "问题" : "回答"}`);
    const selectCard = () => setCurrentNode(node.id);
    card.addEventListener("pointerdown", (event) => beginNodeDrag(event, node, card));
    card.addEventListener("click", (event) => {
      if (Graph.suppressClickNodeId === node.id) {
        Graph.suppressClickNodeId = null;
        return;
      }
      if (!event.target.closest("button, .node-resize-handle")) {
        selectCard();
        // Touch devices do not have a stable hover state. Tapping an answer
        // card therefore toggles the same branch drawer that desktop users
        // reveal by hovering, without changing the card's measured height.
        const usesTapDrawer = window.innerWidth <= 860
          || event.pointerType === "touch"
          || event.pointerType === "pen"
          || !window.matchMedia("(hover: hover) and (pointer: fine)").matches;
        if (usesTapDrawer) {
          const shouldOpen = node.role === "assistant" && !article.classList.contains("is-drawer-open");
          closeBranchDrawers(article);
          if (node.role === "assistant") setBranchDrawerOpen(article, shouldOpen);
        }
      }
    });
    article.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setBranchDrawerOpen(article, false);
        card.focus();
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && !event.target.closest("button")) {
        event.preventDefault(); selectCard();
      }
    });
    const header = document.createElement("div"); header.className = "node-header";
    const roleLabel = document.createElement("span"); roleLabel.textContent = node.role === "user" ? "你" : "Treening";
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
      // 这里只负责折叠真实后代；节点正文始终填满卡片，不再有独立展开状态。
      if (childNodes(node.id).length > 0) toggleFold(node.id);
    });
    const concealButton = document.createElement("button"); concealButton.type = "button"; concealButton.className = "node-action node-action-conceal";
    concealButton.addEventListener("click", (event) => { event.stopPropagation(); concealNode(node.id); });
    actions.append(continueButton, collapseButton, concealButton);
    if (node.role === "assistant") {
      const drawerButton = document.createElement("button");
      drawerButton.type = "button";
      drawerButton.className = "node-action node-action-drawer";
      drawerButton.textContent = "分支";
      drawerButton.setAttribute("aria-label", "打开分支操作");
      drawerButton.setAttribute("aria-expanded", "false");
      drawerButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const shouldOpen = !article.classList.contains("is-drawer-open");
        closeBranchDrawers(article);
        setBranchDrawerOpen(article, shouldOpen);
      });
      actions.append(drawerButton);
    }
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

    let slots = null;
    if (node.role === "assistant") {
      slots = document.createElement("div"); slots.className = "branch-slots";
      slots.setAttribute("role", "group");
      slots.setAttribute("aria-label", "选择后续分支");
      for (const slot of BRANCH_ORDER) {
        const button = document.createElement("button"); button.type = "button";
        button.className = `branch-slot ${slot}`; button.dataset.slot = slot;
        button.addEventListener("click", () => {
          if (button.disabled) return;
          setBranchDrawerOpen(article, false);
          setCurrentNode(node.id); chooseInteractionType(slot); DOM.messageInput.focus();
        });
        slots.append(button);
      }
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
    article.append(card);
    if (slots) article.append(slots);
    return article;
  }

  function ensureNodeElement(node) {
    if (Graph.elements.has(node.id)) return Graph.elements.get(node.id);
    const element = createNodeElement(node); Graph.elements.set(node.id, element); DOM.nodesLayer.append(element); return element;
  }

  function cardHeight(nodeId) {
    return Graph.elements.get(nodeId)?.querySelector(".node-card")?.offsetHeight || NODE_DEFAULT_HEIGHT;
  }

  function buildLayout() {
    const nodes = Graph.model.nodes;
    Graph.positions.clear();
    if (!nodes.length) { Graph.width = 1; Graph.height = 1; return; }
    const { children, roots } = Graph.model;
    // A single-child chain stays vertical: question -> answer is a calm
    // downward rhythm.  Only a real divergence consumes horizontal space.
    const nodeWidth = 300; const siblingGap = 68; const rootGap = 110;
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
    const horizontal = window.TreeningLayoutState.createHorizontalGeometry(children, widthOf, {
      siblingGap,
      onCycle: (id) => Graph.model.warnings.push({ type: "cycle", nodeId: id }),
    });
    const measure = (id) => horizontal.measure(id).width;
    let cursor = padding;
    const assigned = new Set();
    const assign = (node, left, depth, trail = new Set()) => {
      if (assigned.has(node.id) || trail.has(node.id)) {
        if (trail.has(node.id)) Graph.model.warnings.push({ type: "cycle", nodeId: node.id });
        return;
      }
      assigned.add(node.id);
      const branchChildren = children.get(node.id) || [];
      const nodeGeometry = horizontal.measure(node.id);
      const x = left + nodeGeometry.rootOffset;
      if (branchChildren.length) {
        let childLeft = left + nodeGeometry.childInset;
        for (let index = 0; index < branchChildren.length; index += 1) {
          const child = branchChildren[index];
          assign(child, childLeft, depth + 1, new Set([...trail, node.id]));
          childLeft += measure(child.id) + siblingGap;
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
    const isCurrent = node.id === State.currentNodeId;
    const isPath = Graph.model?.viewState?.pathIds.includes(node.id) || false;
    const isNearby = State.viewMode === "nearby" && (Graph.model?.viewState?.nearbyIds.has(node.id) || false);
    element.dataset.branch = branch; element.classList.toggle("is-current", isCurrent); element.classList.toggle("is-path", isPath); element.classList.toggle("is-nearby", isNearby); element.classList.toggle("is-background", !isCurrent && !isPath && !isNearby); element.classList.toggle("is-concealed", concealed);
    element.classList.toggle("has-branches", childNodes(node.id).length > 1);
    element.classList.toggle("is-fold-root", isFoldRoot);
    element.classList.remove("is-expanded");
    const branchText = element.querySelector(".node-branch");
    const card = element.querySelector(".node-card");
    if (card) card.setAttribute("aria-current", isCurrent ? "true" : "false");
    branchText.textContent = BRANCH_LABELS[branch] || "学习回应";
    const continueButton = element.querySelector(".node-action-continue");
    const collapseButton = element.querySelector(".node-action-fold");
    const concealButton = element.querySelector(".node-action-conceal");
    continueButton.textContent = node.role === "assistant" ? "从这里继续" : "回到上层";
    const hasChildren = childNodes(node.id).length > 0;
    collapseButton.hidden = !hasChildren;
    if (hasChildren) {
      // 有后代：按钮语义 = 折叠 / 展开整棵子树（奏折式）
      collapseButton.textContent = isFoldRoot ? "展开" : "收起";
      collapseButton.setAttribute("aria-expanded", String(!isFoldRoot));
      collapseButton.setAttribute("aria-label", isFoldRoot ? "展开子树" : "收起子树");
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
    const visible = Graph.model.nodes.length > 3; DOM.minimap.hidden = !visible; if (!visible) return;
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
    for (const node of Graph.model.nodes) {
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
    const visibleCount = Graph.model.viewState.visibleIds.size;
    DOM.studyApp?.classList.toggle("has-tree", State.nodes.length > 0);
    DOM.studyApp?.classList.toggle("is-large-tree", State.nodes.length > 80);
    DOM.viewport.dataset.visibleNodes = String(visibleCount);
    if (DOM.workspaceTitle) DOM.workspaceTitle.textContent = State.sessionTitle || compactText(rootQuestion || "未命名学习主题");
    if (DOM.workspaceMeta) DOM.workspaceMeta.textContent = State.viewMode === "path"
      ? `当前路径 ${visibleCount} / ${State.nodes.length} 个节点 · 深度 ${focusDepth}`
      : State.viewMode === "nearby"
        ? `路径与邻近分支 ${visibleCount} / ${State.nodes.length} 个节点 · 深度 ${focusDepth}`
        : `${State.nodes.length} 个节点 · 当前深度 ${focusDepth}`;
    const liveIds = new Set(State.nodes.map((node) => node.id));
    const displayIds = new Set(Graph.model.nodes.map((node) => node.id));
    for (const [id, element] of Graph.elements) if (!liveIds.has(id)) { element.remove(); Graph.elements.delete(id); }
    for (const node of State.nodes) ensureNodeElement(node);
    for (const [id, element] of Graph.elements) {
      const viewHidden = !displayIds.has(id);
      element.classList.toggle("is-view-hidden", viewHidden);
      if (viewHidden) {
        element.inert = true;
        element.setAttribute("aria-hidden", "true");
      } else if (!Graph.model.foldedAway.has(id)) {
        element.inert = false;
        element.removeAttribute("aria-hidden");
      }
    }
    // Apply collapsed/expanded classes before measuring card heights. The
    // edges are drawn only after layout and real DOM dimensions are known.
    for (const node of Graph.model.nodes) updateNodeElement(node, focusDepth);
    // reflow=false 用于折叠/展开：保留现有节点位置，只更新折叠状态与牌堆，
    // 避免"树在脚下跳"。结构变化（增删节点、展开正文等）仍走完整重排。
    if (reflow) buildLayout();
    for (const node of Graph.model.nodes) updateNodeElement(node, focusDepth);
    renderEdges();
    DOM.world.style.width = `${Graph.width}px`; DOM.world.style.height = `${Graph.height}px`; applyTransform();
    applyDeckTransforms();
    updateBulkVisibilityControls();
  }

  function appendNode(node, options = {}) {
    if (!node || nodeById(node.id)) return;
    State.nodes.push(node); ensureNodeElement(node);
    if (State.viewMode === "tree") {
      renderGraph();
      if (options.select !== false) setCurrentNode(node.id);
      return;
    }
    // Structural changes first receive coordinates in the complete tree.
    // The focused view is restored in the same task, before the browser paints.
    const focusedMode = State.viewMode;
    State.viewMode = "tree";
    renderGraph();
    State.viewMode = focusedMode;
    if (options.select !== false) setCurrentNode(node.id);
    else renderGraph({ reflow: false });
  }

  function renderInitialNodes(nodes) {
    State.nodes = []; State.currentNodeId = null; State.pathTargetNodeId = null; State.concealedNodes.clear(); State.summaryJobs.clear();
    State.canvasUndo.clear(); updateCanvasUndoControl();
    Graph.elements.clear(); DOM.nodesLayer.replaceChildren();
    State.nodes = Array.isArray(nodes) ? nodes.filter((node) => node && node.id) : [];
    const liveIds = new Set(State.nodes.map((node) => node.id));
    const parentIds = new Set(State.nodes.filter((node) => node.parent_id).map((node) => node.parent_id));
    for (const id of [...State.foldedBranches]) {
      if (!liveIds.has(id) || !parentIds.has(id)) State.foldedBranches.delete(id);
    }
    renderGraph();
    setCurrentNode(State.nodes.length ? State.nodes[State.nodes.length - 1].id : null, { center: false });
    if (State.nodes.length) scheduleFit(); else { Graph.tx = 0; Graph.ty = 0; applyTransform(); }
  }

  function appendLoading(jobId) {
    const loading = document.createElement("div"); loading.className = "loading-node"; loading.id = `loading-${jobId}`; loading.textContent = "Treening 正在整理这条思路"; DOM.viewport.append(loading);
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
      } else appendError(job.error === "quiz provider is not configured" ? "学习服务尚未配置，请先设置 TREENING_API_KEY。" : "这次学习请求没有完成，可以稍后重试。");
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

  function markViewTransition() {
    DOM.viewport.classList.add("is-view-transitioning");
    if (State.viewTransitionTimer) window.clearTimeout(State.viewTransitionTimer);
    State.viewTransitionTimer = window.setTimeout(() => {
      DOM.viewport.classList.remove("is-view-transitioning");
      State.viewTransitionTimer = null;
    }, 340);
  }

  function setViewMode(mode) {
    State.viewMode = ["path", "nearby"].includes(mode) ? mode : "tree";
    if (State.viewMode !== "tree" && State.currentNodeId) State.pathTargetNodeId = State.currentNodeId;
    DOM.treeViewButton?.classList.toggle("is-selected", State.viewMode === "tree");
    DOM.nearbyViewButton?.classList.toggle("is-selected", State.viewMode === "nearby");
    DOM.pathViewButton?.classList.toggle("is-selected", State.viewMode === "path");
    DOM.treeViewButton?.setAttribute("aria-pressed", String(State.viewMode === "tree"));
    DOM.nearbyViewButton?.setAttribute("aria-pressed", String(State.viewMode === "nearby"));
    DOM.pathViewButton?.setAttribute("aria-pressed", String(State.viewMode === "path"));
    markViewTransition();
    // 视图切换只隐藏/恢复节点，不重新计算布局，也不自动改变用户的
    // 缩放和平移。完整树首次布局留下的坐标会继续作为稳定参照。
    renderGraph({ reflow: false });
  }

  function fitGraph() {
    if (!State.nodes.length) return;
    const rect = DOM.viewport.getBoundingClientRect(); const pad = 70;
    const composerInset = window.matchMedia("(min-width: 861px)").matches ? 138 : 0;
    const usableHeight = Math.max(180, rect.height - composerInset);
    Graph.scale = Math.max(MIN_SCALE, Math.min(1.05, (rect.width - pad * 2) / Graph.width, (usableHeight - pad * 2) / Graph.height));
    Graph.tx = (rect.width - Graph.width * Graph.scale) / 2; Graph.ty = (usableHeight - Graph.height * Graph.scale) / 2; applyTransform();
  }
  function scheduleFit() {
    // 首帧布局可能尚未稳定：双 rAF + 超时兜底重 fit，确保用最终视口尺寸居中
    requestAnimationFrame(() => requestAnimationFrame(() => fitGraph()));
    window.setTimeout(() => { if (State.nodes.length) fitGraph(); }, 250);
  }
  function centerOnNode(id) {
    const position = Graph.positions.get(id); if (!position) return;
    const rect = DOM.viewport.getBoundingClientRect();
    const composerInset = window.matchMedia("(min-width: 861px)").matches ? 138 : 0;
    Graph.tx = rect.width / 2 - position.x * Graph.scale; Graph.ty = (rect.height - composerInset) / 2 - position.y * Graph.scale; applyTransform();
  }
  function zoomAt(clientX, clientY, factor) {
    const rect = DOM.viewport.getBoundingClientRect(); const localX = clientX - rect.left; const localY = clientY - rect.top;
    const worldX = (localX - Graph.tx) / Graph.scale; const worldY = (localY - Graph.ty) / Graph.scale;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Graph.scale * factor)); Graph.tx = localX - worldX * next; Graph.ty = localY - worldY * next; Graph.scale = next; applyTransform();
  }

  function setupCanvas() {
    // 滚轮悬停画布即缩放，无需空格；不再依赖任何输入框焦点。
    // 唯一例外：滚轮在当前节点的可滚动正文上时放行原生滚动。
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
    DOM.undoCanvasButton?.addEventListener("click", undoCanvasAction);
    window.addEventListener("keydown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "z") return;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      undoCanvasAction();
    });

    // 按钮点击后立即失焦：避免焦点留在按钮上，导致"空格+滚轮缩放/平移"失效
    // （空格守卫会忽略 focus 在 button 上的按键）。同时覆盖折叠/隐藏等节点按钮。
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".graph-node")) {
        closeBranchDrawers();
      }
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
    DOM.panelBackdrop?.addEventListener("pointerdown", closePanels);
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
  DOM.readerFoldButton?.addEventListener("click", () => {
    const node = nodeById(State.readerNodeId);
    if (!node || childNodes(node.id).length === 0) return;
    toggleFold(node.id);
    renderReader();
  });
  DOM.readerConcealButton?.addEventListener("click", () => {
    const node = nodeById(State.readerNodeId);
    if (!node) return;
    if (State.concealedNodes.has(node.id)) revealNode(node.id);
    else concealNode(node.id);
  });
  DOM.readerExportPathButton?.addEventListener("click", async () => {
    const previousScope = DOM.exportScope.value;
    DOM.exportScope.value = "path";
    await exportSession();
    DOM.exportScope.value = previousScope;
  });
  DOM.refreshSessionsButton.addEventListener("click", () => loadSessionHistory());
  DOM.treeViewButton?.addEventListener("click", () => setViewMode("tree"));
  DOM.nearbyViewButton?.addEventListener("click", () => setViewMode("nearby"));
  DOM.pathViewButton?.addEventListener("click", () => setViewMode("path"));
  DOM.exportButton.addEventListener("click", () => exportSession());
  if (DOM.concealAllButton) DOM.concealAllButton.addEventListener("click", concealAllNodes);
  if (DOM.revealAllButton) DOM.revealAllButton.addEventListener("click", revealAllNodes);
  DOM.newSessionButton.addEventListener("click", () => createNewSession().catch((error) => appendError(error.message)));
  setupCanvas(); setupResponsivePanels(); renderGraph(); loadSession();
})();
