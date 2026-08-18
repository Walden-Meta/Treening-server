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
    layoutPrefs: {},  // 全局布局偏好：qa_gap / branch_gap / node_width / node_height
    canvasUndo: window.TreeningHistoryState.createUndoStack(30),
    viewTransitionTimer: null,
    personaPresets: [],   // 内置人设预设（GET /api/quiz/persona-presets）
    sessionPersona: "",   // 当前树的陪伴者 key（chunyu/rational/emotional/custom:N）；空 = 春宁默认
    pendingPersonaMode: null,  // 人设对话框用途："new" 建树 / "switch" 切人设
    pendingEmptySession: false,  // 新主题已建空树：虽无节点，工作台已进入「树状态」（显示标题/陪伴者）
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
    minX: 0,
    minY: 0,
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
    marquee: null,                    // { pointerId, x1, y1, x2, y2 } 框选进行中
    marqueeEl: null,                  // 框选矩形元素
    marqueeSelection: new Set(),      // 框选选中的节点 id
    // 移动端触控手势
    activePointers: new Map(),        // pointerId -> {x, y} 多指跟踪
    pinch: null,                      // 双指捏合 { ids, p0, p1, d0, s0, tx0, ty0, mx0, my0 }
    panStartX: 0, panStartY: 0,       // 本次平移起点（用于平移后抑制误触卡片点击）
    mobileSuppressAnyNodeClickUntil: 0, // 平移幅度足够后短时抑制卡片 click
    lastNodeTapNodeId: null, lastNodeTapAt: 0, // 移动端双击节点 → 详情
  };

  // 详情工作台（宽屏：田字四格 + 底部常驻提问栏）的运行时状态
  let detailLayer = null;
  let detailSourceNodeId = null;
  let detailComposerWasCollapsed = true;
  // 详情舞台内直接提问：不退出舞台，等回答长出后同步刷新到新回答
  let detailPendingRebuild = false;

  const $ = (selector) => document.querySelector(selector);
  const DOM = {
    studyApp: $("#study-app"), workspaceTitle: $("#workspace-title"), railDepth: $("#rail-depth"),
    quotaLabel: $("#quota-label"),
    nodeCount: $("#node-count"),
    viewport: $("#graph-viewport"), world: $("#graph-world"), edges: $("#graph-edges"),
    nodesLayer: $("#graph-nodes"), minimap: $("#minimap"), minimapSvg: $("#minimap-svg"),
    emptyState: $("#empty-state"), messageForm: $("#message-form"),
    messageInput: $("#message-input"), sendButton: $("#send-button"),
    composerHint: $("#composer-hint"), newSessionButton: $("#new-session-button"),
    composer: $(".composer"),
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
    nodeSearchInput: $("#node-search-input"), nodeSearchResults: $("#node-search-results"), nodeSearch: $("#node-search"),
    sessionRail: $("#session-rail"), historyPanelToggle: $("#history-panel-toggle"),
    readerPanelToggle: $("#reader-panel-toggle"), panelBackdrop: $("#panel-backdrop"),
    railCollapseToggle: $("#rail-collapse-toggle"),
    readerDeconstruction: $("#reader-deconstruction"),
    readerDeconContradiction: $("#reader-decon-contradiction"),
    readerDeconPractice: $("#reader-decon-practice"),
    readerDeconQuestions: $("#reader-decon-questions"),
    personaTag: $("#persona-tag"), personaTagLabel: $("#persona-tag-label"),
    personaModal: $("#persona-modal"), personaModalTitle: $("#persona-modal-title"),
    personaOptions: $("#persona-options"), personaModalCancel: $("#persona-modal-cancel"),
    personaModalConfirm: $("#persona-modal-confirm"), personaModalBackdrop: $("#persona-modal"),
  };

  // 生长回放入口：同树双舞台——点开在当前画布上盖一层全屏剧场，
  // 播的是这棵树真实的节点与生长顺序；退出后编辑器原样还原。
  let replayTheater = null;
  function openReplayOverlay() {
    const overlay = document.querySelector("#replay-overlay");
    if (!overlay || !State.sessionId) return;
    if (typeof window.createReplayTheater !== "function") return;
    if (replayTheater) { replayTheater.destroy(); replayTheater = null; }
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("has-replay-overlay");
    replayTheater = window.createReplayTheater(overlay, {
      sessionId: State.sessionId,
      onExit: closeReplayOverlay,
      onContinue: closeReplayOverlay,
    });
  }
  function closeReplayOverlay() {
    if (replayTheater) { replayTheater.destroy(); replayTheater = null; }
    const overlay = document.querySelector("#replay-overlay");
    if (overlay) {
      overlay.hidden = true;
      overlay.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("has-replay-overlay");
  }
  function syncReplayHref(sessionId) {
    const link = document.querySelector("#replay-link");
    if (!link) return;
    link.disabled = !sessionId;
  }

  let BRANCH_LABELS = {
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
      if (response.status === 401) {
        // 会话失效：跳到登录页
        window.location.href = "/login";
        throw new Error(body.error || "请先登录");
      }
      if (!response.ok) {
        // 错误响应带 request_id：拼进消息，用户反馈时能带回同一 id 让管理员查日志
        const msg = body.error || "请求失败";
        const display = body.request_id ? `${msg}（问题编号 ${body.request_id}）` : msg;
        const error = new Error(display);
        error.code = body.code; error.status = response.status; error.body = body;
        error.request_id = body.request_id;
        throw error;
      }
      return body;
    },
    getSession() { return this.fetchJson("/api/quiz/session"); },
    createSession(persona = "") { return this.fetchJson("/api/quiz/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persona }),
    }); },
    getPersonaPresets() { return this.fetchJson("/api/quiz/persona-presets"); },
    listSessions() { return this.fetchJson("/api/quiz/sessions"); },
    getSessionById(sessionId) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}`); },
    deleteSession(sessionId) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }); },
    updateSession(sessionId, data) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); },
    updateNodeLayout(sessionId, nodeId, layout) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}/nodes/${encodeURIComponent(nodeId)}/layout`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(layout),
    }); },
    clearSessionLayouts(sessionId) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}/layouts/clear`, { method: "POST" }); },
    deleteNode(sessionId, nodeId) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" }); },
    ask(payload) { return this.fetchJson("/api/quiz/ask", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }); },
    getJob(jobId) { return this.fetchJson(`/api/quiz/jobs/${encodeURIComponent(jobId)}`); },
    generateNodeSummary(sessionId, nodeId) { return this.fetchJson(`/api/quiz/sessions/${encodeURIComponent(sessionId)}/nodes/${encodeURIComponent(nodeId)}/summary`, { method: "POST" }); },
    saveLayoutPrefs(layoutPrefs) { return this.fetchJson("/api/setup/layout-prefs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout_prefs: layoutPrefs }),
    }); },
  };

  function clearTransientOverlays() {
    document.querySelectorAll(".loading-node, .inline-error").forEach((element) => element.remove());
  }

  function clearPendingJobs() {
    State.pendingJobs.clear();
    clearTransientOverlays();
    DOM.sendButton.disabled = false;
  }

  function setComposerActive(active) {
    // 输入框按需出现：空树/准备提问时显示，其余时间收起
    if (!DOM.composer) return;
    // 移动端提问框已迁入工作台抽屉：折叠态由抽屉状态控制，流程不插手收起
    if (isMobile()) {
      if (active) { DOM.composer.classList.remove("is-collapsed"); DOM.messageInput?.focus(); }
      return;
    }
    // 详情工作台内提问栏常驻展开：不随"回答长出"等流程收起
    if (!active && detailLayer) return;
    DOM.composer.classList.toggle("is-collapsed", !active);
    if (active) DOM.messageInput?.focus();
  }

  function setQuota(quota) {
    if (!quota) return;
    DOM.quotaLabel.hidden = Boolean(quota.unlimited);
    DOM.quotaLabel.textContent = quota.unlimited
      ? "今日提问不限"
      : `今日剩余 ${quota.remaining} / ${quota.max}`;
    const moreQuota = document.querySelector("#mobile-more-quota");
    if (moreQuota) {
      moreQuota.hidden = Boolean(quota.unlimited);
      moreQuota.textContent = quota.unlimited
        ? "今日提问不限"
        : `今日剩余 ${quota.remaining} / ${quota.max}`;
    }
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
    title.textContent = item.title || item.root_question || "一棵还没起名的树";
    const meta = document.createElement("span"); meta.className = "session-item-meta";
    const count = document.createElement("span"); count.textContent = draft ? "尚未开始" : `${item.node_count || 0} 个节点`;
    const moment = document.createElement("span"); moment.textContent = formatSessionMoment(item.updated_at);
    meta.append(count, moment); content.append(title, meta); button.append(marker, content);
    button.setAttribute("aria-label", `${title.textContent}，${count.textContent}，${moment.textContent}`);
    button.addEventListener("click", (event) => {
      // 标题上的点击交给 title 的双击判定；其余区域直接加载主题
      if (event.target === title || title.contains(event.target)) return;
      if (isMobile()) setMobileWorkspace("collapsed");  // 加载历史主题后收起工作台，露出画布
      loadSessionById(item.id).catch((error) => appendError(error.message || "历史主题加载失败，请稍后重试。"));
    });
    shell.append(button);

    // 双击标题：进入内联改名（单击仍按 250ms 判定，双击不触发加载）
    let titleClickTimer = null;
    title.addEventListener("click", (event) => {
      event.stopPropagation();
      if (titleClickTimer) {
        clearTimeout(titleClickTimer); titleClickTimer = null;
        startTitleEdit(item, title, shell);
        return;
      }
      titleClickTimer = window.setTimeout(() => {
        titleClickTimer = null;
        if (isMobile()) setMobileWorkspace("collapsed");  // 加载历史主题后收起工作台，露出画布
        loadSessionById(item.id).catch((error) => appendError(error.message || "历史主题加载失败，请稍后重试。"));
      }, 250);
    });
    title.addEventListener("dblclick", (event) => event.stopPropagation());

    // 删除按钮：所有主题都有，hover 主题框时直接显示
    const deleteButton = document.createElement("button");
    deleteButton.type = "button"; deleteButton.className = "session-delete-button";
    const deleteIcon = document.createElement("span");
    deleteIcon.textContent = "×";
    deleteIcon.setAttribute("aria-hidden", "true");
    deleteButton.append(deleteIcon);
    deleteButton.title = "删除这条学习轨迹";
    deleteButton.setAttribute("aria-label", `删除学习轨迹：${title.textContent}`);
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteLearningSession(item, deleteButton);
    });
    shell.append(deleteButton);
    return shell;
  }

  // 双击标题改名的内联编辑：Enter/失焦保存，Esc 取消；重名冲突时保留输入并提示。
  function startTitleEdit(item, titleEl, shell) {
    const originalTitle = titleEl.textContent;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "session-title-editor";
    input.value = originalTitle;
    input.maxLength = 120;
    input.setAttribute("aria-label", "编辑主题名称");
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      const value = input.value.trim();
      if (save && value && value !== originalTitle) {
        try {
          const result = await API.updateSession(item.id, { title: value });
          item.title = result.session?.title || value;
          titleEl.textContent = item.title || "一棵还没起名的树";
          if (item.id === State.sessionId) {
            State.sessionTitle = item.title || "";
            if (DOM.workspaceTitle) DOM.workspaceTitle.textContent = State.sessionTitle || "一棵还没起名的树";
          }
          const itemButton = shell?.querySelector(".session-item");
          const metaText = shell?.querySelector(".session-item-meta")?.textContent?.trim() || "";
          if (itemButton) itemButton.setAttribute("aria-label", `${titleEl.textContent}，${metaText}`);
        } catch (error) {
          finished = false;
          input.disabled = false;
          if (error.code === "title_conflict") {
            input.classList.add("is-conflict");
            input.setAttribute("aria-invalid", "true");
            appendError(error.message || "已存在同名学习主题，请换一个名称");
            input.focus();
            input.select();
            return;
          }
          appendError(error.message || "主题名称保存失败，请稍后重试。");
        }
      }
      finished = true;
      input.replaceWith(titleEl);
      loadSessionHistory();
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("dblclick", (event) => event.stopPropagation());
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
    // 只有一个主题：直接置顶展示，不套日期分组标题（美观）
    if (sessions.length === 1) {
      const item = sessions[0];
      const draft = Number(item.node_count) <= 0;
      DOM.sessionList.append(createSessionItem(item, draft));
      return;
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
    if (!item?.id) return;
    const isActive = item.id === State.sessionId;
    const title = item.title || item.root_question || "一棵还没起名的树";
    const pendingWarning = isActive && State.pendingJobs.size
      ? "\n\n当前仍有学习请求正在处理，删除后也会一并停止显示。"
      : "";
    const confirmed = window.confirm(`确定永久删除“${title}”吗？\n\n其中的全部节点和回复都会被删除，且无法撤销。${pendingWarning}`);
    if (!confirmed) return;
    button.disabled = true;
    try {
      const deletedSessionId = item.id;
      await API.deleteSession(deletedSessionId);
      if (!isActive) {
        // 删除的是非当前主题：仅刷新历史列表，不打断当前学习
        await loadSessionHistory();
        return;
      }
      State.sessionGeneration += 1;
      clearPendingJobs();
      State.foldedBranchesBySession.delete(deletedSessionId);
      State.sessionId = null;
      syncReplayHref(null);
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

  // 把后端下发的自定义分支命名合并进 BRANCH_LABELS，并同步刷新静态 UI 标签。
  function applyBranchLabels(labels) {
    if (!labels || typeof labels !== "object") return;
    BRANCH_LABELS = Object.assign({}, BRANCH_LABELS, labels);
    const setText = (sel, text) => { const el = document.querySelector(sel); if (el) el.textContent = text; };
    const label = (slot, fallback) => BRANCH_LABELS[slot] || fallback;
    setText("#legend-check", label("check", "验收"));
    setText("#legend-followup", label("followup", "追问"));
    setText("#legend-custom", label("custom", "其他"));
    setText("#eb-check", label("check", "验收"));
    setText("#eb-followup", label("followup", "追问"));
    setText("#eb-custom", "＋ " + label("custom", "其他"));
    setText("#hc-check", label("check", "验收"));
    setText("#hc-followup", label("followup", "追问"));
    setText("#hc-custom", label("custom", "其他"));
    // 提问框四个快捷入口保持固定完整文案，不被分支自定义短标签缩短
    const setSuggestion = (inter, text) => { const el = document.querySelector(`.suggestion[data-interaction="${inter}"]`); if (el) el.textContent = text; };
    setSuggestion("check", "验收理解");
    setSuggestion("followup", "追问细节");
    setSuggestion("custom", "＋ 其他分支");
  }
  // UI depth is 1-based so the root is the first layer, matching the usual
  // level/height vocabulary used when explaining binary trees.
  // UI depth 按「问答对」分组：一个问题 + 它的回答 = 一组，一组算一个深度（1 起）。
  // 根问答对 = 深度 1；第一个分支问答对 = 深度 2，依此类推。
  function displayDepth(id) { return Math.floor(depthOf(id) / 2) + 1; }
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
    updateMobileCurrentNode();
  }

  function concealNode(nodeId, options = {}) {
    const node = nodeById(nodeId);
    if (!node || State.concealedNodes.has(nodeId)) return;
    if (options.record !== false) pushCanvasUndo(captureCanvasSnapshot());
    State.concealedNodes.add(nodeId);
    renderGraph();
    renderReader();
    if (!nodeSummary(node)) void ensureNodeSummary(node);
    syncDetailClone();
  }

  function nodeSummary(node) {
    const summary = node && node.metadata && node.metadata.summary;
    if (typeof summary !== "string") return "";
    let normalized = summary.trim();
    // Defensive: strip code fences and JSON markers before showing anything.
    // A model echoing "```json {...}" must never leak structural text into
    // the recall hint on a concealed card.
    const pullSummaryField = (text) => {
      // text looks like a JSON object literal -> extract the summary-ish value.
      const match = text.match(/"?(summary|answer_summary|recall_hint|answer)"?\s*[:=]\s*"?([^",}\s][^",}\n]*)/);
      if (match) return match[2].trim();
      return text;
    };
    if (normalized.startsWith("```")) {
      normalized = normalized.replace(/^```[a-zA-Z]*\s*/i, "").trim();
      const brace = normalized.indexOf("{");
      if (brace >= 0) {
        const close = normalized.lastIndexOf("}");
        normalized = close > brace ? normalized.slice(brace, close + 1) : normalized.slice(brace);
      }
      normalized = pullSummaryField(normalized);
    } else if (/^json\s*[{\"':]|^json\s/i.test(normalized)) {
      normalized = normalized.replace(/^json\s*/i, "")
        .replace(/^[{:\"']+\s*/, "");
      normalized = pullSummaryField(normalized);
    } else if (/^[{]/.test(normalized)) {
      // Bare object literal (no fence, no json marker).
      normalized = pullSummaryField(normalized);
    }
    normalized = normalized.replace(/^`+|`+$/g, "").replace(/\s+/g, " ").trim();
    const stopWords = ["回忆", "提示", "显示", "隐藏", BRANCH_LABELS.check, BRANCH_LABELS.followup, BRANCH_LABELS.custom]
      .filter(Boolean)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    if (!normalized || normalized.length > 50 || new RegExp(`^(${stopWords})$`).test(normalized)) return "";
    if (normalized.toLowerCase().startsWith("json")) return "";
    return normalized;
  }

  // 拆解块的防御性清洗（同 nodeSummary 思路，但按块长截断而非拒绝）
  function deconBlock(node, key, maxLen) {
    const value = node && node.metadata && node.metadata[key];
    if (typeof value !== "string") return "";
    let text = value.trim();
    const pull = (input) => {
      // \b 防止 summary 后缀匹配进 answer_summary / question_summary
      const match = input.match(/"?\b(contradiction|practice|check_question|reflect_question|inspire_question|summary)"?\s*[:=]\s*"?([^",}\s][^",}\n]*)/);
      return match ? match[2].trim() : input;
    };
    if (text.startsWith("```")) {
      text = text.replace(/^```[a-zA-Z]*\s*/i, "").trim();
      const brace = text.indexOf("{");
      if (brace >= 0) {
        const close = text.lastIndexOf("}");
        text = close > brace ? text.slice(brace, close + 1) : text.slice(brace);
      }
      text = pull(text);
    } else if (/^json\s/i.test(text)) {
      text = text.replace(/^json\s*/i, "").replace(/^[{:"']+\s*/, "");
      text = pull(text);
    } else if (/^[{]/.test(text)) {
      text = pull(text);
    }
    text = text.replace(/^[`"'“”]+|[`"'“”]+$/g, "").replace(/\s+/g, " ").trim();
    if (!text || text.toLowerCase().startsWith("json")) return "";
    if (text.length > maxLen) text = `${text.slice(0, maxLen - 1).replace(/[，、：；: ]+$/g, "")}…`;
    return text;
  }

  // 三问 → 预填提问栏并预设分支类型（验收→check，反思→followup，启发→custom）
  function applyQuestionToComposer(qtype, text) {
    if (qtype === "check") chooseInteractionType("check");
    else if (qtype === "reflect") chooseInteractionType("followup");
    else chooseInteractionType("custom");
    DOM.messageInput.value = text;
    DOM.messageInput.focus();
    setComposerActive(true);
  }

  async function ensureNodeSummary(node) {
    if (!node || nodeSummary(node)) return nodeSummary(node);
    if (!node.metadata || typeof node.metadata !== "object") node.metadata = {};
    // Legacy nodes may predate answer-time summaries. Give them a stable
    // local fallback immediately instead of starting a second model request
    // when the user hides the card.
    const plain = String(node.content || "").replace(/[`,*_#>\[\]()]/g, "").replace(/\s+/g, " ").trim();
    const firstSentence = plain.split(/(?<=[。！？!?；;.])\s*/).find(Boolean) || plain;
    node.metadata.summary = firstSentence.length <= 50
      ? firstSentence
      : `${firstSentence.slice(0, 49).replace(/[，、：；: ]+$/g, "")}…`;
    renderGraph();
    renderReader();
    return node.metadata.summary || "暂无摘要";
  }

  async function ensureMissingSummaries(nodes) {
    for (const node of nodes) await ensureNodeSummary(node);
  }

  function revealNode(nodeId, options = {}) {
    if (!State.concealedNodes.has(nodeId)) return;
    if (options.record !== false) pushCanvasUndo(captureCanvasSnapshot());
    State.concealedNodes.delete(nodeId);
    // 嵌套回答卡单独「显示」时，若其发问卡仍处于隐藏态，回答卡会被 CSS 随发问卡一起藏回；
    // 因此一并恢复发问卡，保证「显示」总能带回整个问答对，不会出现点一下又消失的情况。
    const node = nodeById(nodeId);
    if (node && node.role === "assistant" && node.parent_id) {
      const parent = nodeById(node.parent_id);
      if (parent && parent.role === "user") State.concealedNodes.delete(parent.id);
    }
    renderGraph();
    renderReader();
    syncDetailClone();
  }

  function updateBulkVisibilityControls() {
    if (!DOM.concealAllButton || !DOM.revealAllButton) return;
    const total = State.nodes.length;
    const hidden = State.concealedNodes.size;
    DOM.concealAllButton.disabled = total === 0 || hidden === total;
    DOM.revealAllButton.disabled = total === 0 || hidden === 0;
  }

  // 「全部隐藏」= 与每个节点自己的「隐藏」完全相同的效果，作用于全部节点：
  // 正文盖住、卡面变成「已隐藏」芯片并展示语义摘要（node-conceal-overlay）。
  function concealAllNodes() {
    if (!State.nodes.some((node) => !State.concealedNodes.has(node.id))) return;
    pushCanvasUndo(captureCanvasSnapshot());
    State.nodes.forEach((node) => State.concealedNodes.add(node.id));
    renderGraph();
    renderReader();
    void ensureMissingSummaries(State.nodes.filter((node) => !nodeSummary(node)));
  }

  // 「全部显示」= 全部卡片恢复可见
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
    DOM.readerBranch.dataset.branch = branch;  // 阅读栏分支标签按真实分支着色（验收/追问/其他）
    DOM.readerDepth.textContent = `深度 ${displayDepth(node.id)}`;
    DOM.readerContent.textContent = node.content;
    DOM.readerContent.hidden = concealed;
    if (DOM.readerConcealed) DOM.readerConcealed.hidden = !concealed;
    if (DOM.readerConcealedSummary) DOM.readerConcealedSummary.textContent = nodeSummary(node) || "摘要生成中…";
    if (concealed) {
      DOM.readerRole.textContent = "";
      DOM.readerBranch.textContent = "";
      delete DOM.readerBranch.dataset.branch;
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
    if (DOM.readerDescendants) DOM.readerDescendants.textContent = `${descendantCount} 条分支`;
    if (DOM.readerFoldButton) {
      DOM.readerFoldButton.disabled = descendantCount === 0;
      DOM.readerFoldButton.textContent = State.foldedBranches.has(node.id) ? "展开这一支" : "折起这一支";
    }
    if (DOM.readerConcealButton) DOM.readerConcealButton.textContent = concealed ? "翻开看看" : "先盖住";
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      DOM.readerView.classList.remove("is-refreshing");
      void DOM.readerView.offsetWidth;
      DOM.readerView.classList.add("is-refreshing");
    }
    renderReaderDeconstruction(node, concealed);
  }

  // ── 详情舞台（宽屏清晰节点 + 矛盾论/实践论/三问三卡） ──
  let detailBuildToken = 0;

  function renderReaderDeconstruction(node, concealed) {
    const section = DOM.readerDeconstruction;
    if (!section) return;
    // 拆解只在窄屏阅读栏回退展示；宽屏拆解由详情三卡承担，阅读栏不重复
    const show = Boolean(node) && node.role === "assistant" && !concealed && window.innerWidth < 1360;
    section.hidden = !show;
    if (!show) return;
    const contradiction = deconBlock(node, "contradiction", 100);
    const practice = deconBlock(node, "practice", 100);
    if (DOM.readerDeconContradiction) {
      DOM.readerDeconContradiction.textContent = contradiction;
      DOM.readerDeconContradiction.closest(".decon-block").hidden = !contradiction;
    }
    if (DOM.readerDeconPractice) {
      DOM.readerDeconPractice.textContent = practice;
      DOM.readerDeconPractice.closest(".decon-block").hidden = !practice;
    }
    if (DOM.readerDeconQuestions) {
      const questions = [
        { key: "check_question", qtype: "check", cls: "detail-q-check" },
        { key: "reflect_question", qtype: "reflect", cls: "detail-q-reflect" },
        { key: "inspire_question", qtype: "inspire", cls: "detail-q-inspire" },
      ].map((q) => ({ ...q, text: deconBlock(node, q.key, 60) })).filter((q) => q.text);
      DOM.readerDeconQuestions.replaceChildren();
      // 三问默认毛玻璃覆盖（不咄咄逼人），悬浮浮现；内容包进 wrap 供遮罩
      const wrap = document.createElement("div");
      wrap.className = "decon-questions-wrap";
      for (const q of questions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `detail-question ${q.cls}`;
        button.textContent = q.text;
        button.addEventListener("click", () => applyQuestionToComposer(q.qtype, q.text));
        wrap.append(button);
      }
      DOM.readerDeconQuestions.append(wrap);
      bindQuestionReveal(wrap);
      DOM.readerDeconQuestions.closest(".decon-block").hidden = questions.length === 0;
    }
    const any = contradiction || practice || (DOM.readerDeconQuestions && DOM.readerDeconQuestions.childElementCount > 0);
    section.hidden = !any;
  }

  function clearDetailLayer() {
    const wasOpen = Boolean(detailLayer);
    detailPendingRebuild = false;
    detailBuildToken += 1;
    const layer = detailLayer;
    if (layer) {
      detailLayer = null;
      if (wasOpen && !layer.dataset.closing) {
        // 直接淡出：克隆与整体工作台一起柔和消失
        layer.dataset.closing = "1";
        layer.animate(
          [{ opacity: 1 }, { opacity: 0 }],
          { duration: 240, easing: "ease-out", fill: "forwards" },
        ).addEventListener("finish", () => { layer.remove(); });
        window.setTimeout(() => { layer.remove(); }, 400);  // 兜底
      } else {
        layer.remove();
      }
    }
    detailSourceNodeId = null;
    document.body.classList.remove("is-detail-focus");
    // 退出详情：提问栏不再让位阅读栏
    document.body.style.removeProperty("--reader-reserve");
    // 真正退出详情（而非重建）时：提问栏恢复为进入前的状态（有树时通常是收起态）
    if (wasOpen && DOM.composer && detailComposerWasCollapsed) {
      DOM.composer.classList.add("is-collapsed");
    }
  }

  function syncDetailClone() {
    // 隐藏/显示内容等操作会重建画布节点，但工作台克隆是独立副本：
    // 若操作的是当前详情节点，直接重建工作台（就位，不重播 FLIP）以保持一致。
    if (!detailLayer || !detailSourceNodeId) return;
    const node = nodeById(detailSourceNodeId);
    if (node) buildDetailStage(node, { fly: false });
  }

  function detailCardElement(className, tag, sub) {
    const card = document.createElement("section");
    card.className = `detail-card ${className}`;
    const header = document.createElement("header");
    const tagEl = document.createElement("span"); tagEl.className = "detail-card-tag"; tagEl.textContent = tag;
    const subEl = document.createElement("span"); subEl.className = "detail-card-sub"; subEl.textContent = sub;
    header.append(tagEl, subEl);
    card.append(header);
    const body = document.createElement("p"); body.className = "detail-card-body";
    card.append(body);
    return card;
  }

  // ── 详情工作台（宽屏：田字四格 + 底部常驻提问栏） ──
  // 布局：画布区虚化后整体变成工作台；上部田字四格（矛盾论/实践论/三问/原卡片），
  // 底部留给提问栏。原卡片格用 createNodeElement 重建，交互全保留，FLIP 从树中飞入。

  function detailCell(grid, className, label, hint) {
    const cell = document.createElement("div");
    cell.className = `detail-cell ${className}`;
    cell.dataset.area = className.replace("detail-cell-", "");
    const card = detailCardElement(`detail-card-${className.replace("detail-cell-", "")}`, label, hint);
    cell.append(card);
    grid.append(cell);
    return cell;
  }

  // 空拆解卡隐藏，有内容的卡自适应拉宽：按可见模块数动态重排 grid。
  function layoutDetailGrid(grid) {
    if (!grid) return;
    const names = [];
    for (const cell of grid.querySelectorAll(".detail-cell:not(.detail-cell-node)")) {
      const card = cell.querySelector(".detail-card");
      const empty = !card || card.classList.contains("is-empty");
      cell.style.display = empty ? "none" : "";
      if (!empty) names.push(cell.dataset.area || "");
    }
    if (!names.length) {
      grid.style.gridTemplateAreas = '"source"';
      grid.style.gridTemplateColumns = "minmax(0, 1fr)";
      grid.style.gridTemplateRows = "auto";
      return;
    }
    const count = names.length;
    grid.style.gridTemplateAreas = `"${Array(count).fill("source").join(" ")}" "${names.join(" ")}"`;
    grid.style.gridTemplateColumns = count === 1 ? "minmax(0, 1fr)" : Array(count).fill("1fr").join(" ");
    grid.style.gridTemplateRows = "auto 1fr";
  }

  function fillDetailCards(node) {
    if (!detailLayer || node.role !== "assistant") return;
    if (State.concealedNodes.has(node.id)) return;  // 隐藏内容时不透出拆解
    const contradiction = deconBlock(node, "contradiction", 100);
    const practice = deconBlock(node, "practice", 100);
    const questions = [
      { key: "check_question", qtype: "check", cls: "detail-q-check" },
      { key: "reflect_question", qtype: "reflect", cls: "detail-q-reflect" },
      { key: "inspire_question", qtype: "inspire", cls: "detail-q-inspire" },
    ].map((q) => ({ ...q, text: deconBlock(node, q.key, 60) })).filter((q) => q.text);

    const deconCard = detailLayer.querySelector(".detail-card-decon");
    const practiceCard = detailLayer.querySelector(".detail-card-practice");
    const questionsCard = detailLayer.querySelector(".detail-card-questions");

    if (deconCard) {
      deconCard.querySelector(".detail-card-body").textContent = contradiction || "该节点暂无认识拆解";
      deconCard.classList.toggle("is-empty", !contradiction);
    }
    if (practiceCard) {
      practiceCard.querySelector(".detail-card-body").textContent = practice || "该节点暂无实践拆解";
      practiceCard.classList.toggle("is-empty", !practice);
    }
    if (questionsCard) {
      const ul = document.createElement("ul"); ul.className = "detail-questions";
      for (const q of questions) {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = `detail-question ${q.cls}`;
        button.textContent = q.text;
        button.addEventListener("click", () => applyQuestionToComposer(q.qtype, q.text));
        li.append(button); ul.append(li);
      }
      questionsCard.querySelector(".detail-card-body").textContent = questions.length ? "" : "该节点暂无验收 / 反思 / 启发问题";
      // 三问默认毛玻璃覆盖（不咄咄逼人），悬浮浮现；内容包进 wrap 供遮罩
      const wrap = document.createElement("div");
      wrap.className = "detail-questions-wrap";
      wrap.append(ul);
      questionsCard.append(wrap);
      bindQuestionReveal(wrap);
      questionsCard.classList.toggle("is-empty", questions.length === 0);
    }
    layoutDetailGrid(detailLayer.querySelector(".detail-grid"));
  }

  // 三问毛玻璃的触屏兜底：无 hover 的触摸设备上，点击内容区切换展开/收起
  function bindQuestionReveal(wrap) {
    if (!wrap) return;
    if (window.matchMedia("(hover: hover)").matches) return;  // 桌面用 hover，无需点击
    wrap.addEventListener("click", () => wrap.classList.toggle("is-revealed"));
  }

  function buildDetailStage(node, options = {}) {
    // 首次进入详情才记录提问栏的原始收起态；重建（resize）沿用原记录
    const firstEntry = !detailSourceNodeId && !detailLayer;
    if (firstEntry) {
      detailComposerWasCollapsed = Boolean(DOM.composer && DOM.composer.classList.contains("is-collapsed"));
    }
    clearDetailLayer();
    Graph.marquee = null;  // 详情舞台接管画布：中断可能进行中的框选
    if (Graph.marqueeEl) Graph.marqueeEl.style.display = "none";
    clearMarqueeSelection();
    const element = Graph.elements.get(node.id);
    if (!element) return;
    const token = ++detailBuildToken;
    const fly = options.fly !== false;

    detailSourceNodeId = node.id;
    // 原卡片保留在虚化背景中，不做隐藏
    document.body.classList.add("is-detail-focus");
    if (DOM.composer) DOM.composer.classList.remove("is-collapsed");  // 提问栏常驻展开

    // 舞台 = 整屏左侧区域：右侧让出阅读栏（固定抽屉），居中基准是"整个屏幕"而非画布盒子
    const readerEl = DOM.readerPanel;
    const readerWidth = readerEl && readerEl.classList.contains("is-panel-open")
      ? readerEl.offsetWidth
      : 0;
    // 提问栏同样让位阅读栏（详情期间常驻展开）
    document.body.style.setProperty("--reader-reserve", `${readerWidth}px`);
    detailLayer = document.createElement("div");
    detailLayer.className = "detail-stage";
    detailLayer.id = "detail-stage";
    detailLayer.style.left = "0";
    detailLayer.style.top = "0";
    detailLayer.style.right = `${readerWidth + 24}px`;
    detailLayer.style.bottom = "0";
    document.body.append(detailLayer);

    // 田字四格：矛盾论 / 实践论 / 三问 / 原卡片（右下）
    const grid = document.createElement("div");
    grid.className = "detail-grid";
    detailLayer.append(grid);
    const moduleCells = [
      detailCell(grid, "detail-cell-decon", "矛盾论", "认识拆解"),
      detailCell(grid, "detail-cell-practice", "实践论", "行动指向"),
      detailCell(grid, "detail-cell-questions", "问题", "验收 · 反思 · 启发"),
    ];
    const nodeCell = document.createElement("div");
    nodeCell.className = "detail-cell detail-cell-node";
    grid.append(nodeCell);

    // 三条支线（树形）：源卡（左）右缘 → 三个模块左缘，画在卡片层之下
    const branches = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    branches.setAttribute("class", "detail-branches");
    branches.setAttribute("aria-hidden", "true");
    detailLayer.append(branches);

    // 原卡片格：createNodeElement 重建（全部交互天然可用），抽屉常驻
    // 源卡在详情工作台内固定尺寸：不跟随外部画布的手动缩放（高度固定值由 CSS 定义）
    // 树形排版：回答卡顶部居中，水平拉长，长度 = 下方提问框宽度的 3/5；
    // 问答对绑定后回答卡宽度扩为原来的 5/4，上方并列发问卡（等宽、高 = 回答固定高的 0.6 倍）
    const composerW = Math.min(760, window.innerWidth - readerWidth - 32);
    const sourceLength = Math.round(composerW * 3 / 5);
    const answerWidth = Math.round(sourceLength * 5 / 4);
    const pairStack = document.createElement("div");
    pairStack.className = "detail-source-stack";
    let questionClone = null;
    const parentNode = node.role === "assistant" && node.parent_id ? nodeById(node.parent_id) : null;
    if (parentNode) {
      questionClone = createNodeElement(parentNode);
      questionClone.classList.add("is-in-workspace", "is-detail-clone", "source-question");
      questionClone.style.width = `${answerWidth}px`;
      syncNodeBranchUI(questionClone, parentNode);
      pairStack.append(questionClone);
      const sourceDivider = document.createElement("div");
      sourceDivider.className = "detail-source-divider";
      sourceDivider.setAttribute("aria-hidden", "true");
      pairStack.append(sourceDivider);
    }
    const clone = createNodeElement(node);
    clone.classList.add("is-in-workspace", "is-detail-clone");
    clone.style.width = `${answerWidth}px`;
    syncNodeBranchUI(clone, node);      // 分支标签 + 抽屉三选项（标签/占用态/禁用）
    pairStack.append(clone);
    nodeCell.append(pairStack);
    if (node.role === "assistant") setBranchDrawerOpen(clone, true);
    if (fly) {
      pairStack.style.opacity = "0";  // 问答对：淡入前先隐藏
      moduleCells.forEach((cell) => { cell.style.opacity = "0"; });  // 模块卡：飞入前先隐藏
    }

    fillDetailCards(node);

    // 双 rAF：等舞台落位后取各格最终位置
    // 三张模块卡从田字右下角（克隆卡片所在格）生发到各自格子；
    // 只动 transform/opacity（合成器属性），不用 filter blur，保证 60Hz 流畅
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token !== detailBuildToken) return;
      // 支线：源卡（顶部）下缘 → 各可见模块上缘（扇形向下），无论是否重播 FLIP 都要画
      const cardRect = clone.getBoundingClientRect();
      const visibleModules = moduleCells.filter((cell) => {
        const modCard = cell.querySelector(".detail-card");
        return modCard && !modCard.classList.contains("is-empty");
      });
      visibleModules.forEach((cell) => {
        const rect = cell.getBoundingClientRect();
        const xEnd = rect.left + rect.width / 2;
        const yEnd = rect.top;
        const xStart = Math.max(cardRect.left, Math.min(cardRect.right, xEnd));
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("class", "detail-branch-line");
        line.setAttribute("x1", String(xStart));
        line.setAttribute("y1", String(cardRect.bottom));
        line.setAttribute("x2", String(xEnd));
        line.setAttribute("y2", String(yEnd));
        branches.append(line);
      });
      if (!fly) return;
      const originRect = pairStack.getBoundingClientRect();  // 问答对整体 = 生发点
      visibleModules.forEach((cell) => {
        const rect = cell.getBoundingClientRect();
        const dx = originRect.left - rect.left;
        const dy = originRect.top - rect.top;
        const sx = originRect.width / rect.width;
        const sy = originRect.height / rect.height;
        cell.style.transformOrigin = "50% 50%";
        // 带弧线的生发：从源卡微升起、逐渐清晰、轻轻落位
        cell.animate(
          [
            { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0 },
            { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 14}px) scale(${sx + (1 - sx) * 0.5}, ${sy + (1 - sy) * 0.5})`, opacity: 0.96, offset: 0.5 },
            { transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
          ],
          { duration: 520, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "both" },
        );
      });
      // 支线随模块落位淡入
      branches.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 320, delay: 260, easing: "ease-out", fill: "both" },
      );
      // 问答对整体：直接淡入（轻微收拢放大，无位移）
      pairStack.animate(
        [
          { opacity: 0, transform: "scale(0.96)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" },
      );
    }));
  }

  const NODE_MIN_WIDTH = 220;
  const NODE_MAX_WIDTH = 640;
  const NODE_MIN_HEIGHT = 90;
  const NODE_MAX_HEIGHT = 4800;
  const NODE_DEFAULT_HEIGHT = 180;
  const NODE_DEFAULT_WIDTH = 300;

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  // 全局布局偏好（用户可在配置页调整；默认值须与后端 LAYOUT_PREFS_DEFAULTS 一致）
  function layoutPrefs() {
    const p = State.layoutPrefs || {};
    return {
      orientation: p.orientation === "horizontal" ? "horizontal" : "vertical",
      qa_gap: clamp(Number(p.qa_gap) || 24, 16, 200),
      branch_gap: clamp(Number(p.branch_gap) || 82, 40, 300),
      node_width: clamp(Number(p.node_width) || NODE_DEFAULT_WIDTH, NODE_MIN_WIDTH, NODE_MAX_WIDTH),
      node_height: clamp(Number(p.node_height) || NODE_DEFAULT_HEIGHT, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT),
    };
  }

  function isHorizontal() { return layoutPrefs().orientation === "horizontal"; }

  function applyLayoutPrefs(prefs) {
    State.layoutPrefs = (prefs && typeof prefs === "object") ? { ...prefs } : {};
    syncOrientationButton();
  }

  // 工具栏方向切换按钮的文案/提示随当前布局方向刷新
  function syncOrientationButton() {
    const button = document.querySelector("#orientation-toggle-button");
    if (!button) return;
    button.textContent = isHorizontal() ? "⇅ 纵向" : "⇄ 横向";
    button.title = isHorizontal()
      ? "切换树图方向：横向河流 → 自上而下（问答对保持纵向、分支向右）"
      : "切换树图方向：自上而下 → 横向河流（问答对保持纵向、分支向右）";
  }

  function nodeWidthOf(nodeId) {
    const layout = nodeLayout(nodeById(nodeId));
    return (layout && layout.width) || layoutPrefs().node_width;
  }

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
      width: current ? current.width : clamp(card?.offsetWidth || layoutPrefs().node_width, NODE_MIN_WIDTH, NODE_MAX_WIDTH),
      height: current ? current.height : clamp(card?.offsetHeight || layoutPrefs().node_height, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT),
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
    if (!card) return layoutPrefs().node_height;
    const content = card.querySelector(".node-content");
    const header = card.querySelector(".node-header");
    const actions = card.querySelector(".node-actions");
    const naturalHeight = (content?.scrollHeight || 0)
      + (header?.offsetHeight || 0)
      + (actions?.offsetHeight || 0)
      + 2;
    return clamp(naturalHeight || layoutPrefs().node_height, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT);
  }

  function resolveResizeOverlaps(anchorId) {
    const visibleNodes = State.nodes.filter((node) => {
      const element = Graph.elements.get(node.id);
      return element && !element.classList.contains("is-view-hidden") && !element.classList.contains("is-folded");
    });
    const raw = visibleNodes.map((node) => {
      const element = Graph.elements.get(node.id);
      const card = element.querySelector(".node-card");
      const position = Graph.positions.get(node.id) || { x: 0, y: 0 };
      const layout = nodeLayout(node);
      return {
        id: node.id,
        x: position.x,
        y: position.y,
        width: layout?.width || element.offsetWidth || layoutPrefs().node_width,
        height: layout?.height || card.offsetHeight || layoutPrefs().node_height,
      };
    });
    // 单元化：问答对合并为一个包围盒（发问卡 ∪ 嵌套回答卡），重叠避让整对平移，
    // 绝不出现"避让把回答卡单独推开、拆散问答对"的情况。
    const unitBoxes = new Map();
    for (const item of raw) {
      const q = unitRootOf(nodeById(item.id));
      if (!q || q.id !== item.id) continue;  // 嵌套回答卡已并入其发问卡单元盒
      const existing = unitBoxes.get(q.id);
      if (!existing) { unitBoxes.set(q.id, { ...item, id: q.id }); continue; }
      const left = Math.min(existing.x - existing.width / 2, item.x - item.width / 2);
      const right = Math.max(existing.x + existing.width / 2, item.x + item.width / 2);
      const top = Math.min(existing.y - existing.height / 2, item.y - item.height / 2);
      const bottom = Math.max(existing.y + existing.height / 2, item.y + item.height / 2);
      unitBoxes.set(q.id, {
        id: q.id,
        x: (left + right) / 2,
        y: (top + bottom) / 2,
        width: right - left,
        height: bottom - top,
      });
    }
    const geometry = [...unitBoxes.values()];
    const anchorNode = nodeById(anchorId);
    const anchorUnit = anchorNode ? unitRootOf(anchorNode) : null;
    const anchorUnitId = anchorUnit ? anchorUnit.id : anchorId;
    const beforePositions = new Map(geometry.map((item) => [item.id, { x: item.x, y: item.y }]));
    // 画布无墙：重叠避让也允许把节点推到负坐标（左/上），不设 140/90 旧墙
    const result = window.TreeningLayoutState.resolveOverlaps(geometry, anchorUnitId, { gap: 40, minX: -100000, minY: -100000 });
    for (const nodeId of result.movedIds) {
      const node = nodeById(nodeId);
      const prev = beforePositions.get(nodeId);
      const next = result.positions.get(nodeId);
      if (!node || !prev || !next) continue;
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      // 整对平移：发问卡 + 嵌套回答卡共享同一位移，回答卡相对位置不变
      const moveUnitNode = (n) => {
        if (!n) return;
        const pos = Graph.positions.get(n.id);
        if (!pos) return;
        const nx = pos.x + dx;
        const ny = pos.y + dy;
        const layout = setNodeLayout(n, { ...layoutSnapshot(n, pos), x: nx, y: ny });
        Graph.positions.set(n.id, { x: layout.x, y: layout.y });
        if (n.id === nodeId) {
          const element = Graph.elements.get(n.id);
          if (element) { element.style.left = `${layout.x}px`; element.style.top = `${layout.y}px`; }
        }
        scheduleNodeLayoutSave(n);
      };
      moveUnitNode(node);
      moveUnitNode(unitAnswerOf(node));
    }
    if (result.movedIds.length) {
      // 包围盒同步按含负坐标的全量范围扩展，保证 edges/minimap/fit 覆盖推到负方向的节点
      const minLeft2 = Math.min(0, ...geometry.map((item) => (result.positions.get(item.id)?.x || item.x) - item.width / 2));
      const minTop2 = Math.min(0, ...geometry.map((item) => (result.positions.get(item.id)?.y || item.y) - item.height / 2));
      const maxRight = Math.max(0, ...geometry.map((item) => (result.positions.get(item.id)?.x || item.x) + item.width / 2));
      const maxBottom = Math.max(0, ...geometry.map((item) => (result.positions.get(item.id)?.y || item.y) + item.height / 2));
      Graph.minX = Math.min(Graph.minX, minLeft2);
      Graph.minY = Math.min(Graph.minY, minTop2);
      Graph.width = Math.max(Graph.width, maxRight - Graph.minX + 240);
      Graph.height = Math.max(Graph.height, maxBottom - Graph.minY + 180);
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
    element.style.width = `${layout ? layout.width : layoutPrefs().node_width}px`;
    // Keep a stable card frame even before the user manually resizes it.
    // Expanding should only change what is visible inside this frame.
    card.style.height = `${layout ? layout.height : layoutPrefs().node_height}px`;
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

  // 记录一个问答对单元在拖拽开始时的初始坐标（发问卡 + 嵌套回答卡），
  // 供整对平移时按「初始坐标 + 总位移」精确计算，绝不叠加累计误差。
  function recordUnitDragState(id) {
    const root = unitRootOf(nodeById(id));
    if (!root) return null;
    const qPos = Graph.positions.get(root.id);
    if (!qPos) return null;
    const aNode = unitAnswerOf(root);
    const aPos = aNode ? Graph.positions.get(aNode.id) : null;
    return {
      id: root.id,
      qx: qPos.x, qy: qPos.y,
      ax: aPos ? aPos.x : null, ay: aPos ? aPos.y : null,
    };
  }

  function beginNodeDrag(event, node, card, options = {}) {
    // 移动端默认「查看模式」：单指触摸卡片不拖动节点（留给平移 / 长按抓住节点），
    // 只有编辑模式或长按合成抓取时才进入节点拖拽。
    if (isMobile() && !isMobileEditMode() && !options.synthetic) return;
    if (detailSourceNodeId) return;  // 详情工作台脱离画布自由度：禁拖拽
    if (event.button !== 0 || event.target.closest("button, .node-resize-handle")) return;
    const position = Graph.positions.get(node.id);
    if (!position) return;
    const beforeSnapshot = captureCanvasSnapshot();
    const layout = setNodeLayout(node, layoutSnapshot(node, position));
    // 框选组拖拽：按下的节点在选中集内 → 记录整组初始位置，拖动时整组平移（相对位置不变）。
    // 嵌套回答卡并入其发问卡单元，组内不出现"落单回答卡"。
    let group = null;
    if (Graph.marqueeSelection.size > 0 && Graph.marqueeSelection.has(node.id)) {
      const foldedAway = Graph.model?.foldState?.foldedAway || new Set();
      group = [];
      const seen = new Set();
      for (const id of Graph.marqueeSelection) {
        const entry = recordUnitDragState(id);
        if (!entry || foldedAway.has(entry.id) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        group.push(entry);
      }
      if (group.length > 1) DOM.studyApp?.classList.add("is-group-dragging");
    } else {
      // 问答对绑定：整对作为一个单元拖动（嵌套回答卡随发问卡一起走）
      const partnerId = node.role === "assistant" ? node.parent_id
        : State.nodes.find((n) => n.role === "assistant" && n.parent_id === node.id)?.id;
      const partnerPos = partnerId ? Graph.positions.get(partnerId) : null;
      if (partnerId && partnerPos && partnerId !== node.id) {
        group = [recordUnitDragState(node.id), recordUnitDragState(partnerId)].filter(Boolean);
        DOM.studyApp?.classList.add("is-group-dragging");
      }
    }
    const qRoot = unitRootOf(node);
    const qRootPos = Graph.positions.get(qRoot.id);
    const aNode = unitAnswerOf(qRoot);
    const aNodePos = aNode ? Graph.positions.get(aNode.id) : null;
    Graph.nodeDrag = {
      node, card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      originX: layout.x, originY: layout.y, moved: false, beforeSnapshot, group,
      synthetic: Boolean(options.synthetic),  // 长按合成抓取：未持有卡片指针捕获
      // 单元拖拽基准：拖到嵌套回答卡也以发问卡初始坐标计算位移，避免累计误差
      unit: qRootPos ? {
        q: qRoot,
        a: aNode,
        qx: qRootPos.x, qy: qRootPos.y,
        ax: aNodePos ? aNodePos.x : null, ay: aNodePos ? aNodePos.y : null,
      } : null,
    };
    if (!options.synthetic) card.setPointerCapture?.(event.pointerId);
    card.classList.add("is-node-dragging");
    event.preventDefault(); event.stopPropagation();
  }

  function beginNodeResize(event, node, card) {
    if (detailSourceNodeId) return;  // 详情工作台脱离画布自由度：禁缩放
    if (event.button !== 0) return;
    const beforeSnapshot = captureCanvasSnapshot();
    const layout = setNodeLayout(node, layoutSnapshot(node));
    // 回答卡右下角 = 问答对整体缩放：发问卡随动，两张卡共享宽度、按当前比例分配高度
    if (node.role === "assistant") {
      const qNode = nodeById(node.parent_id);
      if (qNode) {
        const qPos = Graph.positions.get(qNode.id);
        const qLayout = layoutSnapshot(qNode, qPos);
        const gap = pairGapBetween(qNode, node);  // 实测间距：整体缩放只改尺寸，不改间距
        const pairTotalH = qLayout.height + gap + layout.height;
        Graph.nodeResize = {
          node, card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
          originWidth: layout.width, originPairH: pairTotalH, gap,
          split: qLayout.height / pairTotalH,
          moved: false, beforeSnapshot, pair: qNode,
          // 视觉锚点 = 发问卡左上角：整对缩放时发问卡顶部不动，只拉右下。
          // 锚点用实时渲染位置，避免横向纯自动布局下保存坐标滞后导致整对"跳"动。
          anchorX: (qPos ? qPos.x : qLayout.x) - qLayout.width / 2,
          anchorY: (qPos ? qPos.y : qLayout.y) - qLayout.height / 2,
        };
        card.setPointerCapture?.(event.pointerId);
        card.classList.add("is-node-resizing");
        DOM.studyApp?.classList.add("is-divider-dragging");  // 问答对整体缩放同样需关闭位移动画
        event.preventDefault(); event.stopPropagation();
        return;
      }
    }
    const pos = Graph.positions.get(node.id);
    Graph.nodeResize = {
      node, card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      originWidth: layout.width, originHeight: layout.height, moved: false, beforeSnapshot,
      // 视觉左上角锚点：resize 时左上角保持不动，只拉右下角
      anchorX: pos.x - layout.width / 2,
      anchorY: pos.y - layout.height / 2,
    };
    card.setPointerCapture?.(event.pointerId);
    card.classList.add("is-node-resizing");
    event.preventDefault(); event.stopPropagation();
  }

  // 问答对间距中心的横细线 = 高度分配把手：上下拖拽重分配发问卡/回答卡高度
  function beginQADividerDrag(event, edgeData) {
    if (detailSourceNodeId) return;  // 详情工作台脱离画布自由度：禁拖拽
    if (event.button !== 0) return;
    const qNode = nodeById(edgeData.from);
    const aNode = nodeById(edgeData.to);
    if (!qNode || !aNode || aNode.role !== "assistant") return;
    const beforeSnapshot = captureCanvasSnapshot();
    const qLayout = layoutSnapshot(qNode);
    const aLayout = layoutSnapshot(aNode);
    const gap = pairGapBetween(qNode, aNode);  // 实测间距：拖拽只改高度，不改间距
    Graph.pairDivider = {
      qNode, aNode, pointerId: event.pointerId, startY: event.clientY,
      originQHeight: qLayout.height,
      totalH: qLayout.height + gap + aLayout.height,
      gap,
      moved: false, beforeSnapshot,
      rafId: null,   // 拖拽期间按帧合并写 DOM（高频 pointermove 只记最新目标高度）
      latestQH: null,
    };
    // 拖拽期间关闭卡片位移动画：高度瞬变、位置若带 260ms transition 会滞后，
    // 两卡追不上指针，可见间距会在拖拽中来回伸缩（"拉灰条间距在动"）。
    DOM.studyApp?.classList.add("is-divider-dragging");
    event.preventDefault(); event.stopPropagation();
  }

  // 问答对两卡当前画布上的实测间距（用渲染位置 Graph.positions 而非已保存坐标）：
  // buildLayout 已把回答卡纵坐标按生效 qa_gap 重推，渲染位置即配置间距；
  // 已保存坐标可能来自历史拖拽、残留旧间距，绝不能拿来当基准。
  // 分界线拖拽与整体缩放一律沿用实测间距：只重分配两卡高度，绝不改写间距。
  function pairGapBetween(qNode, aNode) {
    const qPos = Graph.positions.get(qNode.id);
    const aPos = Graph.positions.get(aNode.id);
    if (qPos && aPos) {
      const qH = cardHeight(qNode.id) || layoutPrefs().node_height;
      const aH = cardHeight(aNode.id) || layoutPrefs().node_height;
      return aPos.y - aH / 2 - (qPos.y + qH / 2);
    }
    const q = layoutSnapshot(qNode);
    const a = layoutSnapshot(aNode);
    return a.y - a.height / 2 - (q.y + q.height / 2);
  }

  // 按给定高度重写问答对两卡：发问卡顶部不动，回答卡跟随，宽度不动。
  // 锚点优先用实时渲染位置（Graph.positions）：横向纯自动布局下已保存坐标可能
  // 滞后于实际渲染，若用它当锚，第一次拖拽整对会"跳"回旧坐标系。
  function applyQAPairHeights(qNode, aNode, qH, aH, gap) {
    const qPos = Graph.positions.get(qNode.id);
    const aPos = Graph.positions.get(aNode.id);
    const qLayout = layoutSnapshot(qNode, qPos);
    const aLayout = layoutSnapshot(aNode, aPos);
    const qX = qPos ? qPos.x : qLayout.x;
    const qTop = (qPos ? qPos.y : qLayout.y) - qLayout.height / 2;
    const newQY = qTop + qH / 2;
    const newAY = qTop + qH + gap + aH / 2;
    setNodeLayout(qNode, { ...qLayout, x: qX, y: newQY, height: qH });
    setNodeLayout(aNode, { ...aLayout, x: qX, y: newAY, height: aH });
    Graph.positions.set(qNode.id, { x: qX, y: newQY });
    Graph.positions.set(aNode.id, { x: qX, y: newAY });
    const qEl = Graph.elements.get(qNode.id);
    if (qEl) {
      qEl.style.left = `${qX}px`; qEl.style.top = `${newQY}px`;
      applyNodeLayoutStyle(qNode, qEl);
      const divider = qEl.querySelector(".qa-divider");
      if (divider) divider.style.top = `${qH + gap / 2}px`;
    }
    // 单元化：回答卡相对发问卡 DOM 定位（left 50% 居中、top = 发问卡底 + 间距），
    // 只改高度，位置随单元一起走，不存在独立坐标漂移。
    const aEl = Graph.elements.get(aNode.id);
    if (aEl) { aEl.style.left = "50%"; aEl.style.top = `${qH + gap}px`; applyNodeLayoutStyle(aNode, aEl); }
  }

  function moveNodePointer(event) {
    const drag = Graph.nodeDrag;
    if (drag && drag.pointerId === event.pointerId) {
      const dx = (event.clientX - drag.startX) / Graph.scale;
      const dy = (event.clientY - drag.startY) / Graph.scale;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      Graph.suppressClickNodeId = drag.node.id;
      // 整组平移：所有选中单元共享同一位移，严格保持相对位置；画布四向无墙，不做钳制
      if (drag.group && drag.group.length > 1) {
        const gdx = dx;
        const gdy = dy;
        const seen = new Set();
        for (const member of drag.group) {
          if (!member || seen.has(member.id)) continue;
          seen.add(member.id);
          const qNode = nodeById(member.id);
          if (!qNode) continue;
          const nx = member.qx + gdx;
          const ny = member.qy + gdy;
          setNodeLayout(qNode, { ...layoutSnapshot(qNode, { x: member.qx, y: member.qy }), x: nx, y: ny });
          Graph.positions.set(qNode.id, { x: nx, y: ny });
          const qEl = Graph.elements.get(qNode.id);
          if (qEl) { qEl.style.left = `${nx}px`; qEl.style.top = `${ny}px`; }
          // 嵌套回答卡整对平移：初始坐标 + 同一位移，元素随发问卡 DOM 一起走
          if (member.ax != null && member.ay != null) {
            const aNode = unitAnswerOf(qNode);
            if (aNode) {
              setNodeLayout(aNode, { ...layoutSnapshot(aNode, { x: member.ax, y: member.ay }), x: member.ax + gdx, y: member.ay + gdy });
              Graph.positions.set(aNode.id, { x: member.ax + gdx, y: member.ay + gdy });
            }
          }
          if (Graph.model?.foldState?.activeRoots.has(qNode.id)) moveOwnedDeck(qNode.id, { x: nx, y: ny });
        }
        queueEdgesRender();
        event.preventDefault();
        return;
      }
      // 单卡拖拽：整对单元作为一个整体平移（拖到任意一卡都带动整个单元）。
      // 用拖拽开始时的初始坐标 + 总位移，避免多帧 pointermove 累计误差。
      const unit = drag.unit;
      const nx = unit.qx + dx;
      const ny = unit.qy + dy;
      setNodeLayout(unit.q, { ...layoutSnapshot(unit.q, { x: unit.qx, y: unit.qy }), x: nx, y: ny });
      Graph.positions.set(unit.q.id, { x: nx, y: ny });  // 同步连线锚点
      const qEl = Graph.elements.get(unit.q.id);
      if (qEl) { qEl.style.left = `${nx}px`; qEl.style.top = `${ny}px`; }
      if (unit.a && unit.ax != null && unit.ay != null) {
        setNodeLayout(unit.a, { ...layoutSnapshot(unit.a, { x: unit.ax, y: unit.ay }), x: nx, y: unit.ay + dy });
        Graph.positions.set(unit.a.id, { x: nx, y: unit.ay + dy });
      }
      if (Graph.model?.foldState?.activeRoots.has(unit.q.id)) moveOwnedDeck(unit.q.id, { x: nx, y: ny });
      queueEdgesRender();  // 下一帧才重建连线，拖动不卡
      event.preventDefault();
      return;
    }
    const divider = Graph.pairDivider;
    if (divider && divider.pointerId === event.pointerId) {
      const dy = (event.clientY - divider.startY) / Graph.scale;
      if (!divider.moved && Math.abs(dy) < 2) return;
      divider.moved = true;
      // 快速拖拽时 pointermove 频率可能高于 60fps：只记最新目标高度，交给一帧只跑一次的
      // RAF 去写 DOM，避免一帧内多次 layout+reflow 把主线程卡住造成可见抖动。
      const gap = divider.gap;  // 进入拖拽时捕获的实测间距，拖拽期间保持恒定
      divider.latestQH = clamp(divider.originQHeight + dy, NODE_MIN_HEIGHT, divider.totalH - gap - NODE_MIN_HEIGHT);
      if (divider.rafId == null) {
        divider.rafId = requestAnimationFrame(() => {
          divider.rafId = null;
          if (divider.latestQH == null) return;
          const qH = divider.latestQH;
          const aH = divider.totalH - divider.gap - qH;
          applyQAPairHeights(divider.qNode, divider.aNode, qH, aH, divider.gap);
          queueEdgesRender();
        });
      }
      event.preventDefault();
      return;
    }
    const resize = Graph.nodeResize;
    if (resize && resize.pointerId === event.pointerId) {
      const dx = (event.clientX - resize.startX) / Graph.scale;
      const dy = (event.clientY - resize.startY) / Graph.scale;
      if (!resize.moved && Math.hypot(dx, dy) >= 2) resize.moved = true;
      if (resize.pair) {
        // 问答对整体缩放：共享宽度、按进入时的比例分配高度、发问卡顶部不动、间距恒定
        const gap = resize.gap;
        const newWidth = Math.max(NODE_MIN_WIDTH, resize.originWidth + dx);
        const newTotalH = Math.max(NODE_MIN_HEIGHT * 2 + gap, resize.originPairH + dy);
        const newQH = clamp((newTotalH - gap) * resize.split, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT);
        const newAH = Math.min(Math.max(NODE_MIN_HEIGHT, newTotalH - gap - newQH), usefulCardHeight(resize.card));
        const qNode = resize.pair;
        const qLayout = layoutSnapshot(qNode);
        const aLayout = layoutSnapshot(resize.node);
        const newQX = resize.anchorX + newWidth / 2;
        const newQY = resize.anchorY + newQH / 2;
        const newAX = newQX;
        const newAY = newQY + newQH / 2 + gap + newAH / 2;
        setNodeLayout(qNode, { ...qLayout, x: newQX, y: newQY, width: newWidth, height: newQH });
        setNodeLayout(resize.node, { ...aLayout, x: newAX, y: newAY, width: newWidth, height: newAH });
        Graph.positions.set(qNode.id, { x: newQX, y: newQY });
        Graph.positions.set(resize.node.id, { x: newAX, y: newAY });
        const qEl = Graph.elements.get(qNode.id);
        if (qEl) {
          qEl.style.left = `${newQX}px`; qEl.style.top = `${newQY}px`;
          applyNodeLayoutStyle(qNode, qEl);
          const divider = qEl.querySelector(".qa-divider");
          if (divider) divider.style.top = `${newQH + gap / 2}px`;
        }
        const aEl = Graph.elements.get(resize.node.id);
        if (aEl) { aEl.style.left = "50%"; aEl.style.top = `${newQH + gap}px`; applyNodeLayoutStyle(resize.node, aEl); }
        queueEdgesRender();
        event.preventDefault();
        return;
      }
      const layout = nodeLayout(resize.node);
      const newWidth = resize.originWidth + dx;
      const newHeight = Math.min(resize.originHeight + dy, usefulCardHeight(resize.card));
      setNodeLayout(resize.node, {
        ...layout,
        width: newWidth,
        // Stop at the first height that reveals the complete reply. This
        // avoids both an unnecessary inner scrollbar and a tall empty card.
        height: newHeight,
      });
      // 保持左上角不动，只拉右下角：按新尺寸重算中心位置
      const newX = resize.anchorX + newWidth / 2;
      const newY = resize.anchorY + newHeight / 2;
      Graph.positions.set(resize.node.id, { x: newX, y: newY });
      const el = Graph.elements.get(resize.node.id);
      el.style.left = `${newX}px`;
      el.style.top = `${newY}px`;
      applyNodeLayoutStyle(resize.node, el);
      // 单元化：发问卡单独缩放高度时，嵌套回答卡顶/分隔线同步跟随（间距恒定），
      // 回答卡永远贴着发问卡底边，不存在"拉大问题卡、回答卡留在原地"的脱节。
      if (resize.node.role === "user") {
        const aNode = unitAnswerOf(resize.node);
        if (aNode) {
          const gap = pairGapBetween(resize.node, aNode);
          const aEl = Graph.elements.get(aNode.id);
          const aPos = Graph.positions.get(aNode.id);
          if (aEl && aPos) {
            const aLayout = layoutSnapshot(aNode, aPos);
            const aNewY = resize.anchorY + newHeight + gap + aLayout.height / 2;
            setNodeLayout(aNode, { ...aLayout, x: newX, y: aNewY });
            Graph.positions.set(aNode.id, { x: newX, y: aNewY });
            aEl.style.left = "50%";
            aEl.style.top = `${newHeight + gap}px`;
            applyNodeLayoutStyle(aNode, aEl);
          }
          const divider = el.querySelector(".qa-divider");
          if (divider) divider.style.top = `${newHeight + gap / 2}px`;
        }
      }
      queueEdgesRender();
      event.preventDefault();
    }
  }

  function finishNodePointer(event) {
    const drag = Graph.nodeDrag;
    if (drag && drag.pointerId === event.pointerId) {
      if (!drag.synthetic) drag.card.releasePointerCapture?.(event.pointerId);
      drag.card.classList.remove("is-node-dragging");
      if (drag.group && drag.group.length > 1) {
        DOM.studyApp?.classList.remove("is-group-dragging");
        if (drag.moved) {
          pushCanvasUndo(drag.beforeSnapshot);
          // 每个单元保存发问卡 + 嵌套回答卡两份 layout
          const saved = new Set();
          for (const member of drag.group) {
            if (!member) continue;
            const qNode = nodeById(member.id);
            if (!qNode) continue;
            for (const n of [qNode, unitAnswerOf(qNode)]) {
              if (n && !saved.has(n.id)) { saved.add(n.id); scheduleNodeLayoutSave(n); }
            }
          }
        }
      } else if (drag.moved) {
        pushCanvasUndo(drag.beforeSnapshot);
        if (drag.unit) {
          scheduleNodeLayoutSave(drag.unit.q);
          if (drag.unit.a) scheduleNodeLayoutSave(drag.unit.a);
        } else {
          scheduleNodeLayoutSave(drag.node);
        }
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
      DOM.studyApp?.classList.remove("is-divider-dragging");
      if (resize.moved) {
        scheduleNodeLayoutSave(resize.node);
        if (resize.pair) scheduleNodeLayoutSave(resize.pair);
        resolveResizeOverlaps(resize.node.id);
        pushCanvasUndo(resize.beforeSnapshot);
      }
      Graph.nodeResize = null;
      refreshGraphGeometry();
      return;
    }
    const divider = Graph.pairDivider;
    if (divider && divider.pointerId === event.pointerId) {
      // 若有未落地的 RAF 帧，取消并同步补上最终高度，保证松手时状态完整
      if (divider.rafId != null) {
        cancelAnimationFrame(divider.rafId);
        divider.rafId = null;
        if (divider.latestQH != null) {
          const qH = divider.latestQH;
          const aH = divider.totalH - divider.gap - qH;
          applyQAPairHeights(divider.qNode, divider.aNode, qH, aH, divider.gap);
          queueEdgesRender();
        }
      }
      if (divider.moved) {
        scheduleNodeLayoutSave(divider.qNode);
        scheduleNodeLayoutSave(divider.aNode);
        // 分界线拖拽不改变问答对占地（发问卡顶固定、回答卡底恒定），不会产生新重叠；
        // 且 resolveResizeOverlaps 不识问答对，可能把发问卡单独推开破坏配对间距，故跳过。
        pushCanvasUndo(divider.beforeSnapshot);
      }
      DOM.studyApp?.classList.remove("is-divider-dragging");
      Graph.pairDivider = null;
      refreshGraphGeometry();
    }
  }

  // ── 框选（Ctrl/⌘ + 画布空白拖拽）──
  function beginMarquee(event) {
    const rect = DOM.viewport.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    clearMarqueeSelection();
    if (!Graph.marqueeEl) {
      Graph.marqueeEl = document.createElement("div");
      Graph.marqueeEl.className = "marquee-select";
      Graph.marqueeEl.setAttribute("aria-hidden", "true");
      DOM.viewport.append(Graph.marqueeEl);
    }
    Graph.marquee = { pointerId: event.pointerId, x1: x, y1: y, x2: x, y2: y };
    const el = Graph.marqueeEl;
    el.style.display = "block";
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    el.style.width = "0px"; el.style.height = "0px";
    DOM.viewport.setPointerCapture?.(event.pointerId);
  }
  function updateMarquee(event) {
    const marquee = Graph.marquee;
    if (!marquee) return;
    const rect = DOM.viewport.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    marquee.x2 = x; marquee.y2 = y;
    const left = Math.min(marquee.x1, marquee.x2), top = Math.min(marquee.y1, marquee.y2);
    const el = Graph.marqueeEl;
    el.style.left = `${left}px`; el.style.top = `${top}px`;
    el.style.width = `${Math.abs(marquee.x2 - marquee.x1)}px`;
    el.style.height = `${Math.abs(marquee.y2 - marquee.y1)}px`;
  }
  function finishMarquee(event) {
    const marquee = Graph.marquee;
    if (!marquee) return;
    Graph.marquee = null;
    if (Graph.marqueeEl) Graph.marqueeEl.style.display = "none";
    DOM.viewport.releasePointerCapture?.(marquee.pointerId);
    const width = Math.abs(marquee.x2 - marquee.x1), height = Math.abs(marquee.y2 - marquee.y1);
    if (width < 4 && height < 4) { clearMarqueeSelection(); return; }  // 视为点击：清空选中
    const rect = DOM.viewport.getBoundingClientRect();
    const left = Math.min(marquee.x1, marquee.x2), top = Math.min(marquee.y1, marquee.y2);
    const worldX1 = (left - Graph.tx) / Graph.scale;
    const worldY1 = (top - Graph.ty) / Graph.scale;
    const worldX2 = (left + width - Graph.tx) / Graph.scale;
    const worldY2 = (top + height - Graph.ty) / Graph.scale;
    const foldedAway = Graph.model?.foldState?.foldedAway || new Set();
    const hits = [];
    for (const node of State.nodes) {
      const pos = Graph.positions.get(node.id);
      const element = Graph.elements.get(node.id);
      if (!pos || !element || foldedAway.has(node.id)) continue;
      // 用渲染后的真实尺寸判定（自动排版节点没有 metadata.layout 也能命中）
      const halfW = element.offsetWidth / 2, halfH = cardHeight(node.id) / 2;
      if (pos.x - halfW < worldX2 && pos.x + halfW > worldX1 && pos.y - halfH < worldY2 && pos.y + halfH > worldY1) {
        hits.push(node.id);
      }
    }
    applyMarqueeSelection(hits);
  }
  function applyMarqueeSelection(ids) {
    Graph.marqueeSelection = new Set(ids);
    updateSelectionClasses();
    // 框选接管焦点：旧的"单击选中"当前节点回归普通状态（不再悬浮发光）
    if (ids.length > 0 && State.currentNodeId) {
      setCurrentNode(null, { center: false, preservePathTarget: true });
    }
  }
  function clearMarqueeSelection() {
    if (Graph.marqueeSelection.size === 0) return;
    Graph.marqueeSelection.clear();
    updateSelectionClasses();
  }
  function updateSelectionClasses() {
    const selected = Graph.marqueeSelection;
    for (const [id, element] of Graph.elements) element.classList.toggle("is-marquee-selected", selected.has(id));
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
    // 嵌套回答卡随其发问卡一起折叠：不单独定位（DOM 在发问卡内部，CSS 在
    // .graph-node.user.is-folded 时整体隐藏），只标记折叠状态保持可展开语义。
    if (el.dataset.answerNodeId) {
      el.classList.add("is-folded");
      el.inert = true;
      el.setAttribute("aria-hidden", "true");
      const focusCard = el.querySelector(".node-card");
      if (focusCard) focusCard.tabIndex = -1;
      return;
    }
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
      if (!el || el.dataset.answerNodeId) continue;  // 嵌套回答卡随发问卡移动，不单独定位
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
      if (detailSourceNodeId && deleted.has(detailSourceNodeId)) clearDetailLayer();  // 详情节点被删，收起工作台
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
    const selectCard = () => {
      // 单击卡片只做选中（高亮 / 作为后续提问挂载点）；查看全文统一走「详情」
      setCurrentNode(node.id);
    };
    card.addEventListener("pointerdown", (event) => {
      // 移动端查看模式：单指先进入长按判定（长按=编辑+抓住节点，快速移动=画布平移）
      if (isMobile() && !isMobileEditMode()) { beginMobileHold(event, node, card); return; }
      beginNodeDrag(event, node, card);
    });
    card.addEventListener("click", (event) => {
      // 移动端平移幅度足够后落回的 click 一律视为误触，不再触发选中/展开
      if (isMobile() && Date.now() < Graph.mobileSuppressAnyNodeClickUntil) return;
      // 移动端双击节点 → 半展开工作台显示节点详情
      const now = Date.now();
      const isDoubleTap = isMobile() && Graph.lastNodeTapNodeId === node.id && (now - Graph.lastNodeTapAt) < 320;
      Graph.lastNodeTapNodeId = node.id;
      Graph.lastNodeTapAt = now;
      if (Graph.suppressClickNodeId === node.id) {
        Graph.suppressClickNodeId = null;
        return;
      }
      if (!event.target.closest("button, .node-resize-handle")) {
        selectCard();
        if (isDoubleTap && isMobile()) {
          setMobileWorkspace("half");
          setMobileWorkspaceTab("reader");
        }
        // Touch devices do not have a stable hover state. Tapping an answer
        // card therefore toggles the same branch drawer that desktop users
        // reveal by hovering, without changing the card's measured height.
        const usesTapDrawer = window.innerWidth <= 767
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
        // 详情工作台内抽屉常驻，Escape 不收起
        if (!article.classList.contains("is-in-workspace")) setBranchDrawerOpen(article, false);
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
    const collapseButton = document.createElement("button"); collapseButton.type = "button"; collapseButton.className = "node-action node-action-fold";
    collapseButton.dataset.action = "fold";
    collapseButton.addEventListener("click", () => {
      // 收起 = 折叠「这一支」：该节点下的整棵子树收成一叠牌堆（奏折式）。
      // 只对有子节点的卡显示；不碰卡片正文。
      if (detailSourceNodeId) return;  // 详情工作台内「收起/展开」无效化
      if (childNodes(node.id).length > 0) toggleFold(node.id);
    });
    const concealButton = document.createElement("button"); concealButton.type = "button"; concealButton.className = "node-action node-action-conceal";
    concealButton.addEventListener("click", (event) => { event.stopPropagation(); concealNode(node.id); });
    const detailButton = document.createElement("button");
    detailButton.type = "button";
    detailButton.className = "node-action node-action-detail";
    detailButton.textContent = "详情";
    detailButton.title = "查看全文";
    detailButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (detailSourceNodeId === node.id && detailLayer) return;  // 已在详情，避免重建
      setCurrentNode(node.id, { center: false });
      // 移动端：详情收进「研究工作台」半展开的节点详情标签页
      if (isMobile()) {
        setMobileWorkspace("half");
        setMobileWorkspaceTab("reader");
        return;
      }
      // 详情始终在右侧阅读栏展示完整文本；宽屏拆解由工作台田字格承担（不重复渲染）
      if (DOM.readerPanel && !DOM.readerPanel.classList.contains("is-panel-open")) {
        DOM.readerPanel.classList.add("is-panel-open");
        if (DOM.readerPanelToggle) DOM.readerPanelToggle.setAttribute("aria-expanded", "true");
        if (DOM.panelBackdrop) DOM.panelBackdrop.hidden = false;
        document.body.classList.add("has-open-workspace-panel");
      }
      // 宽屏：节点居中后，克隆卡片 FLIP 飞入田字工作台右下格
      if (window.innerWidth >= 1360) {
        centerOnNode(node.id);
        buildDetailStage(node, { fly: true });
      }
    });
    actions.append(collapseButton, concealButton, detailButton);
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
          // 详情工作台内抽屉常驻：点选方向后不收起
          if (!article.classList.contains("is-in-workspace")) setBranchDrawerOpen(article, false);
          setCurrentNode(node.id); chooseInteractionType(slot); setComposerActive(true);
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
    // 问答对绑定：右下角小直角只保留在回答卡上，缩放会带动发问卡一起调整
    if (node.role === "assistant") {
      const resizeHandle = document.createElement("span");
      resizeHandle.className = "node-resize-handle";
      resizeHandle.setAttribute("aria-hidden", "true");
      resizeHandle.addEventListener("pointerdown", (event) => beginNodeResize(event, node, card));
      // 手柄挂在 element 层（而非 card），才能凸出卡片圆角外
      article.append(resizeHandle);
    }
    article.append(card);
    if (slots) article.append(slots);
    return article;
  }

  // ── 问答对单元（方案2）──
  // 回答卡 DOM 直接嵌套进发问卡的 article（同一棵 DOM 树），整对作为单元移动，
  // 物理上不可能发生"问答对漂移"。每节点仍保留自己的 .graph-node 元素与状态类。
  function isNestedAnswer(node) {
    if (!node || node.role !== "assistant") return false;
    const q = node.parent_id ? nodeById(node.parent_id) : null;
    return Boolean(q && q.role === "user");
  }
  function unitAnswerOf(qNode) {
    if (!qNode || qNode.role !== "user") return null;
    return State.nodes.find((n) => n.role === "assistant" && n.parent_id === qNode.id) || null;
  }
  // 任意节点 → 它所属问答对单元的根（发问卡）。独立节点 = 自己。
  function unitRootOf(node) {
    if (!node) return null;
    if (node.role === "user") return node;
    const q = node.parent_id ? nodeById(node.parent_id) : null;
    return q && q.role === "user" ? q : node;
  }
  // 单元发问卡当前渲染高度（用于计算回答卡/分隔线的相对偏移）
  function unitQuestionHeight(qNode) {
    const card = qNode ? Graph.elements.get(qNode.id)?.querySelector(".node-card") : null;
    return card?.offsetHeight || (qNode ? nodeLayout(qNode)?.height : 0) || layoutPrefs().node_height;
  }
  // 把节点的绝对图坐标应用到元素：单元根/独立卡用绝对 left/top；
  // 嵌套回答卡永远贴在发问卡下方（left 50% + 相对 top），随单元一起移动。
  function applyNodeElementPosition(node, x, y) {
    const element = Graph.elements.get(node.id);
    if (!element) return;
    if (isNestedAnswer(node)) {
      const q = nodeById(node.parent_id);
      const qH = unitQuestionHeight(q);
      element.style.left = "50%";
      element.style.top = `${qH + layoutPrefs().qa_gap}px`;
      return;
    }
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
  }

  function ensureNodeElement(node) {
    if (Graph.elements.has(node.id)) return Graph.elements.get(node.id);
    // 问答对绑定：回答卡嵌套进发问卡的单元里（同一棵 DOM 树 → 整对永不漂移）
    if (node.role === "assistant") {
      const q = node.parent_id ? nodeById(node.parent_id) : null;
      if (q && q.role === "user") {
        const qEl = ensureNodeElement(q);
        const existing = qEl.querySelector(`[data-answer-node-id="${node.id}"]`);
        if (existing) { Graph.elements.set(node.id, existing); return existing; }
        const aEl = createNodeElement(node);
        aEl.setAttribute("data-answer-node-id", node.id);
        qEl.append(aEl);
        Graph.elements.set(node.id, aEl);
        return aEl;
      }
    }
    const element = createNodeElement(node);
    Graph.elements.set(node.id, element);
    if (node.role === "user") {
      // 单元壳：发问卡与分隔线；回答卡由 ensure 注入（先于发问卡处理时也已就位）
      const divider = document.createElement("div");
      divider.className = "qa-divider";
      divider.setAttribute("data-qa-divider", node.id);
      divider.setAttribute("role", "separator");
      divider.setAttribute("aria-label", "调整问答高度分配");
      divider.addEventListener("pointerdown", (event) => {
        const a = unitAnswerOf(node);
        if (a) beginQADividerDrag(event, { from: node.id, to: a.id });
      });
      element.append(divider);
    }
    DOM.nodesLayer.append(element);
    return element;
  }

  function cardHeight(nodeId) {
    return Graph.elements.get(nodeId)?.querySelector(".node-card")?.offsetHeight || layoutPrefs().node_height;
  }

  function buildLayout() {
    const nodes = Graph.model.nodes;
    Graph.positions.clear();
    if (!nodes.length) { Graph.width = 1; Graph.height = 1; Graph.minX = 0; Graph.minY = 0; return; }
    if (isHorizontal()) { buildLayoutHorizontal(); return; }
    const { children, roots } = Graph.model;
    // A single-child chain stays vertical: question -> answer is a calm
    // downward rhythm.  Only a real divergence consumes horizontal space.
    const prefs = layoutPrefs();
    const nodeWidth = prefs.node_width; const siblingGap = 68; const rootGap = 110;
    const widthOf = (id) => nodeLayout(nodeById(id))?.width || nodeWidth;
    // Tree alternates strictly: user question at even depth, assistant answer at
    // odd depth. Question -> answer links are tight (visible ~24px) so a Q&A pair
    // reads as one unit; answer -> branch links keep the normal spacing below.
    const top = 95; const padding = 240;
    const qaGap = prefs.qa_gap;   // visible edge = qaGap - 20 ≈ 24px
    const branchGap = prefs.branch_gap; // original spacing for answer -> branch
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
      // odd depth = entering an assistant answer (question -> answer, tight);
      // even depth = entering a user branch (answer -> branch, normal).
      const gap = depth % 2 === 1 ? qaGap : branchGap;
      layerY.set(depth, layerY.get(depth - 1) + previousHeight / 2 + gap + currentHeight / 2);
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
      const saved = nodeLayout(node);
      const computedX = left + nodeGeometry.rootOffset;
      const x = saved ? saved.x : computedX;
      // 已保存位置（拖拽/缩放过）的节点作为锚点：它的子树整体平移相同偏移，
      // 保证新长出的子节点对齐到父节点实际显示的位置——否则父节点用存档 x、
      // 新子节点用计算 x，父子中心错位，连线就歪（"一条线下来都不是直的"）。
      const dx = x - computedX;
      if (branchChildren.length) {
        let childLeft = left + nodeGeometry.childInset + dx;
        for (let index = 0; index < branchChildren.length; index += 1) {
          const child = branchChildren[index];
          assign(child, childLeft, depth + 1, new Set([...trail, node.id]));
          childLeft += measure(child.id) + siblingGap;
        }
      }
      const y = saved ? saved.y : (layerY.get(depth) || top);
      Graph.positions.set(node.id, { x, y });
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
    // 问答对内部间距永远跟随生效配置 qa_gap：已保存 layout 只保留发问卡位置与
    // 两卡高度，回答卡纵坐标按「发问卡顶 + 发问卡高 + qa_gap + 回答卡高」重推。
    // 否则历史拖拽把间距焊死在旧坐标里，改间距后仍显示旧间距（拖灰条"回退到之前"）。
    // 单元化后回答卡 DOM 贴着发问卡，x 强制同列：历史存档里 x 分叉的问答对归一化。
    for (const node of nodes) {
      if (node.role !== "assistant") continue;
      const q = nodeById(node.parent_id);
      if (!q || q.role !== "user") continue;
      const qPos = Graph.positions.get(q.id);
      if (!qPos) continue;
      const qH = cardHeight(q.id) || layoutPrefs().node_height;
      const aH = cardHeight(node.id) || layoutPrefs().node_height;
      Graph.positions.set(node.id, { x: qPos.x, y: qPos.y + qH / 2 + qaGap + aH / 2 });
    }
    // 画布四向无墙：内容允许进入负坐标（左/上可无限拖），包围盒按全部可见内容（含负数）计算，
    // 供 edges viewBox / minimap / fit 居中正确覆盖整棵内容。
    const minLeft = Math.min(0, ...visible.map((node) => (Graph.positions.get(node.id)?.x || 0) - widthOf(node.id) / 2));
    const minTop = Math.min(0, ...visible.map((node) => (Graph.positions.get(node.id)?.y || 0) - cardHeight(node.id) / 2));
    const maxRight = Math.max(0, ...visible.map((node) => (Graph.positions.get(node.id)?.x || 0) + widthOf(node.id) / 2));
    const maxBottom = Math.max(0, ...visible.map((node) => (Graph.positions.get(node.id)?.y || 0) + cardHeight(node.id) / 2));
    Graph.minX = minLeft;
    Graph.minY = minTop;
    Graph.width = Math.max(700, cursor + padding - rootGap, maxRight - minLeft + padding);
    const lastLayerHeight = layerHeights.get(maxDepth) || 90;
    Graph.height = Math.max(430, (layerY.get(maxDepth) || top) + lastLayerHeight / 2 + 120, maxBottom - minTop + 140);
  }

  function buildLayoutHorizontal() {
    // 横向河流布局：问答对保持纵向（发问在上、回答在下），分支向右生长，
    // 兄弟子树纵向打包堆叠，以回答卡中心为对齐轴。
    // 纯自动布局：忽略节点已保存的坐标（尺寸仍跟随保存值，因为卡片渲染尺寸
    // 由已保存的宽高决定）；切换方向时服务端会清空全部已保存 layout。
    const nodes = Graph.model.nodes;
    const { children, nodeMap } = Graph.model;
    const prefs = layoutPrefs();
    const qaGap = prefs.qa_gap;
    const branchGap = prefs.branch_gap;
    const siblingGap = 68;   // 兄弟子树纵向堆叠的缝隙
    const rootGap = 110;     // 根问答对纵向间隔
    const top = 95;
    const padding = 240;

    const foldedAway = (Graph.model && Graph.model.foldedAway) || new Set();
    const active = nodes.filter((node) => !foldedAway.has(node.id));
    const activeIds = new Set(active.map((node) => node.id));

    // 问答对映射：发问卡 -> 回答卡。横向「单位」= 发问卡 + qa_gap + 回答卡（纵向成对）。
    const answerOf = new Map();
    for (const node of nodes) {
      if (node.role !== "assistant") continue;
      const q = nodeMap.get(node.parent_id);
      if (q && q.role === "user" && activeIds.has(q.id)) answerOf.set(q.id, node.id);
    }
    // 单位分支映射：单位（发问卡 id）-> 其回答下挂的分支发问卡（折叠隐藏的分支不参与排布）
    const unitChildren = new Map();
    for (const node of active) {
      if (node.role !== "user") continue;
      const answer = answerOf.get(node.id);
      const branchNodes = (answer ? (children.get(answer) || []) : (children.get(node.id) || []))
        .filter((child) => child.role === "user" && activeIds.has(child.id));
      unitChildren.set(node.id, branchNodes);
    }
    const unitHeightOf = (qId) => {
      const qH = cardHeight(qId) || prefs.node_height;
      const aH = answerOf.has(qId) ? (cardHeight(answerOf.get(qId)) || prefs.node_height) : 0;
      return qH + qaGap + aH;
    };
    const unitWidthOf = (qId) => {
      const qw = nodeWidthOf(qId);
      const aw = answerOf.has(qId) ? nodeWidthOf(answerOf.get(qId)) : qw;
      return Math.max(qw, aw);
    };

    const vertical = window.TreeningLayoutState.createVerticalGeometry(unitChildren, unitHeightOf, {
      siblingGap,
      onCycle: (id) => Graph.model.warnings.push({ type: "cycle", nodeId: id }),
    });
    const measureHeight = (id) => vertical.measure(id).height;

    const assigned = new Set();
    const placeUnit = (qId, unitCenterY, x, trail = new Set()) => {
      if (assigned.has(qId) || trail.has(qId)) {
        if (trail.has(qId)) Graph.model.warnings.push({ type: "cycle", nodeId: qId });
        return;
      }
      assigned.add(qId);
      const qH = cardHeight(qId) || prefs.node_height;
      const aH = answerOf.has(qId) ? (cardHeight(answerOf.get(qId)) || prefs.node_height) : 0;
      const unitWidth = unitWidthOf(qId);
      // 问答对中心对齐同一 x：发问卡在上、回答卡在下，qaGap 居中
      Graph.positions.set(qId, { x, y: unitCenterY - (qaGap + aH) / 2 });
      if (answerOf.has(qId)) {
        Graph.positions.set(answerOf.get(qId), { x, y: unitCenterY + (qH + qaGap) / 2 });
        assigned.add(answerOf.get(qId));  // 回答卡同属该单位，兜底循环不得重复排布
      }
      const branches = unitChildren.get(qId) || [];
      if (!branches.length) return;
      // 分支向右：childX = 父回答右缘 + branchGap + 子单位半宽（每个子单位独立对齐自己的左缘）
      const geo = vertical.measure(qId);
      const childrenTop = unitCenterY - geo.rootOffset + geo.childInset;
      let cursor = childrenTop;
      for (const child of branches) {
        const childGeo = vertical.measure(child.id);
        const childX = x + unitWidth / 2 + branchGap + unitWidthOf(child.id) / 2;
        placeUnit(child.id, cursor + childGeo.rootOffset, childX, new Set([...trail, qId]));
        cursor += childGeo.height + siblingGap;
      }
    };

    // 根单位 = 无父链的发问卡（含缺少父链的孤立发问卡）
    const unitRoots = active.filter((node) => node.role === "user" && !node.parent_id);
    for (const node of active) {
      if (node.role === "user" && node.parent_id && !nodeMap.get(node.parent_id)) unitRoots.push(node);
    }
    let cursorY = top;
    for (const root of unitRoots) {
      const geo = vertical.measure(root.id);
      placeUnit(root.id, cursorY + geo.rootOffset, padding);
      cursorY += geo.height + rootGap;
    }
    // 兜底：异常结构（环/缺链）漏掉的节点单独排布，避免落在原点
    for (const node of active) {
      if (assigned.has(node.id)) continue;
      Graph.model.warnings.push({ type: "unreachable", nodeId: node.id });
      if (node.role === "user") {
        const geo = vertical.measure(node.id);
        placeUnit(node.id, cursorY + geo.rootOffset, padding);
        cursorY += geo.height + rootGap;
      } else {
        Graph.positions.set(node.id, { x: padding, y: cursorY });
        cursorY += cardHeight(node.id) + rootGap;
      }
    }

    // 画布四向无墙：包围盒按全部可见内容（含负数）计算
    const visible = active;
    const minLeft = Math.min(0, ...visible.map((node) => (Graph.positions.get(node.id)?.x || 0) - nodeWidthOf(node.id) / 2));
    const minTop = Math.min(0, ...visible.map((node) => (Graph.positions.get(node.id)?.y || 0) - cardHeight(node.id) / 2));
    const maxRight = Math.max(0, ...visible.map((node) => (Graph.positions.get(node.id)?.x || 0) + nodeWidthOf(node.id) / 2));
    const maxBottom = Math.max(0, ...visible.map((node) => (Graph.positions.get(node.id)?.y || 0) + cardHeight(node.id) / 2));
    Graph.minX = minLeft;
    Graph.minY = minTop;
    Graph.width = Math.max(700, maxRight - minLeft + padding);
    Graph.height = Math.max(430, cursorY - top + 120, maxBottom - minTop + 140);
  }

  // 横向河流的分支边：数据上是「回答 → 分支发问」，但视觉改为「父发问卡 → 子发问卡」
  // 的水平链接（问题对问题）。返回父发问卡的位置与尺寸；非横向或非分支边返回 null。
  function horizontalEdgeStart(edgeData) {
    if (!isHorizontal()) return null;
    const fromNode = nodeById(edgeData.from);
    if (!fromNode || fromNode.role !== "assistant") return null;
    const q = fromNode.parent_id ? nodeById(fromNode.parent_id) : null;
    if (!q || q.role !== "user") return null;
    const position = Graph.positions.get(q.id);
    if (!position) return null;
    return { id: q.id, position, size: { width: nodeWidthOf(q.id), height: cardHeight(q.id) } };
  }

  function edgePath(from, to, fromSize, toSize) {
    const sizeOf = (size, key) => (size && Number(size[key])) || 0;
    if (isHorizontal()) {
      // 横向河流：父回答卡右缘 → 子发问卡左缘，S 曲线（画布纵向中间连接）
      const rawStartX = from.x + sizeOf(fromSize, "width") / 2 + 10;
      const rawEndX = to.x - sizeOf(toSize, "width") / 2 - 10;
      const startX = Math.min(rawStartX, rawEndX - 20);
      const endX = Math.max(rawEndX, startX + 20);
      const curveX = startX + (endX - startX) / 2;
      return `M ${startX} ${from.y} C ${curveX} ${from.y}, ${curveX} ${to.y}, ${endX} ${to.y}`;
    }
    const rawStartY = from.y + sizeOf(fromSize, "height") / 2 + 10;
    const rawEndY = to.y - sizeOf(toSize, "height") / 2 - 10;
    const startY = Math.min(rawStartY, rawEndY - 20);
    const endY = Math.max(rawEndY, startY + 20);
    const curveY = startY + (endY - startY) / 2;
    return `M ${from.x} ${startY} C ${from.x} ${curveY}, ${to.x} ${curveY}, ${to.x} ${endY}`;
  }

  function edgeColorClass(edge) {
    return ["check", "followup", "custom"].includes(edge.branch) ? edge.branch : "question";
  }

  // 问答对内部边（发问→回答）：连接线 + 高度分配把手都是单元 DOM 里的
  // .qa-divider 元素，SVG 层不画问答对内边；缩略图仍用 qaDividerGeometry 画横短线。
  // 只有发问卡（user 角色）→ 回答卡（assistant 角色）的边属于问答对内部。
  function isQAPairEdge(edgeData) {
    return nodeById(edgeData.from)?.role === "user";
  }

  function qaDividerGeometry(edgeData, from, to) {
    // 全部取实时渲染值：位置来自 Graph.positions、高度来自 DOM 实测。
    // 不再混用已保存 layout（字体重测 / undo / 方向切换清空后仍准确），
    // 避免拖拽带偏出发问卡底边与回答卡顶边之间的空隙中线。
    const qH = cardHeight(edgeData.from) || layoutPrefs().node_height;
    const aH = cardHeight(edgeData.to) || layoutPrefs().node_height;
    const midY = (from.y + qH / 2 + to.y - aH / 2) / 2;  // 空隙正中：发问卡底边与回答卡顶边的中点
    const spanWidth = Math.max(nodeWidthOf(edgeData.from), nodeWidthOf(edgeData.to));
    const half = spanWidth * 0.375;  // 拖拽带长 = 较宽卡宽的 3/4，水平居中
    return { midY, half };
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
    glow.setAttribute("x", String(Graph.minX - 64)); glow.setAttribute("y", String(Graph.minY - 64));
    glow.setAttribute("width", String(Graph.width + 128));
    glow.setAttribute("height", String(Graph.height + 128));
    const blur = document.createElementNS(SVG_NS, "feGaussianBlur"); blur.setAttribute("stdDeviation", "2.4"); blur.setAttribute("result", "blur");
    const merge = document.createElementNS(SVG_NS, "feMerge");
    const glowNode = document.createElementNS(SVG_NS, "feMergeNode"); glowNode.setAttribute("in", "blur");
    const sourceNode = document.createElementNS(SVG_NS, "feMergeNode"); sourceNode.setAttribute("in", "SourceGraphic");
    merge.append(glowNode, sourceNode); glow.append(blur, merge); defs.append(glow);
    DOM.edges.append(defs);

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
      if (isQAPairEdge(edgeData)) {
        // 问答对内部：可见连接线 + 拖拽把手都是单元 DOM 内的 .qa-divider 元素，
        // 随发问卡一起移动，物理上不可能脱节。SVG 层不画任何东西。
        // （缩略图仍通过 qaDividerGeometry 画横短线。）
        renderedEdges += 1;
        continue;
      }
      const edge = document.createElementNS(SVG_NS, "path");
      edge.classList.add("graph-edge", edgeColorClass(edgeData));
      edge.dataset.from = edgeData.from;
      edge.dataset.to = edgeData.to;
      edge.dataset.relation = edgeData.relation;
      // 横向河流：分支边从父发问卡右缘出发（问题对问题横向链接），而非回答卡
      const hStart = horizontalEdgeStart(edgeData);
      const fromPos = hStart ? hStart.position : from;
      const fromSize = hStart ? hStart.size : { width: nodeWidthOf(edgeData.from), height: cardHeight(edgeData.from) };
      const toSize = { width: nodeWidthOf(edgeData.to), height: cardHeight(edgeData.to) };
      edge.setAttribute("d", edgePath(fromPos, to, fromSize, toSize));
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
    // 先应用卡片尺寸再计算位置：嵌套回答卡的相对 top 依赖发问卡实测高度
    applyNodeLayoutStyle(node, element);
    const position = Graph.positions.get(node.id);
    if (position) applyNodeElementPosition(node, position.x, position.y);
    // 单元根（发问卡）：同步分隔线高度（相对发问卡顶 = qH + qaGap/2）
    if (node.role === "user" && unitAnswerOf(node)) {
      const divider = element.querySelector(".qa-divider");
      if (divider) divider.style.top = `${unitQuestionHeight(node) + layoutPrefs().qa_gap / 2}px`;
    }
    // 单元有回答卡（且回答卡在当前显示集内）才显示分隔线；
    // 独立发问卡不画小横条，聚焦视图隐藏回答卡时也不留悬空分隔线
    const unitAnswer = node.role === "user" ? unitAnswerOf(node) : null;
    element.classList.toggle("has-answer", Boolean(unitAnswer) && Graph.model.nodeMap.has(unitAnswer.id));
    const concealed = State.concealedNodes.has(node.id);
    const isFoldRoot = Graph.model?.foldState?.activeRoots.has(node.id) || false;
    const isCurrent = node.id === State.currentNodeId;
    const isPath = Graph.model?.viewState?.pathIds.includes(node.id) || false;
    const isNearby = State.viewMode === "nearby" && (Graph.model?.viewState?.nearbyIds.has(node.id) || false);
    element.dataset.branch = branch; element.classList.toggle("is-current", isCurrent); element.classList.toggle("is-path", isPath); element.classList.toggle("is-nearby", isNearby); element.classList.toggle("is-background", !isCurrent && !isPath && !isNearby); element.classList.toggle("is-concealed", concealed);
    const verified = node.role === "assistant" && childNodes(node.id).some((c) => c.role === "user" && normalizeBranch(c.branch_type) === "check");
    element.classList.toggle("is-verified", verified);
    element.classList.toggle("has-branches", childNodes(node.id).length > 1);
    element.classList.toggle("is-fold-root", isFoldRoot);
    element.classList.remove("is-expanded");
    const branchText = element.querySelector(".node-branch");
    const card = element.querySelector(".node-card");
    if (card) card.setAttribute("aria-current", isCurrent ? "true" : "false");
    branchText.textContent = BRANCH_LABELS[branch] || "学习回应";
    const collapseButton = element.querySelector(".node-action-fold");
    const concealButton = element.querySelector(".node-action-conceal");
    // 收起 = 折叠「这一支」（子树收成牌堆）：只对有子节点的卡显示，发问卡同样适用；
    // 发问卡本身有子节点就出现，没子节点就不占位。
    const hasChildren = childNodes(node.id).length > 0;
    collapseButton.hidden = !hasChildren;
    if (hasChildren) {
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
    syncNodeBranchUI(element, node);
  }

  // 分支标签 + 抽屉三选项（标签 / 已用占用态 / 禁用）——画布节点与详情工作台克隆共用
  function syncNodeBranchUI(element, node) {
    const branch = normalizeBranch(node.branch_type);
    element.dataset.branch = branch;
    const branchText = element.querySelector(".node-branch");
    if (branchText) branchText.textContent = BRANCH_LABELS[branch] || "学习回应";
    if (node.role !== "assistant") return;
    const used = new Set(childNodes(node.id).map((child) => normalizeBranch(child.branch_type)));
    element.querySelectorAll(".branch-slot").forEach((button) => {
      const slot = button.dataset.slot; const occupied = used.has(slot);
      button.disabled = occupied || used.size >= State.maxBranches;
      button.classList.toggle("is-used", occupied);
      const slotLabel = BRANCH_LABELS[slot] || (slot === "custom" ? "其他" : slot === "check" ? "验收" : "追问");
      button.textContent = occupied ? `${slotLabel} · 已用` : (slot === "custom" ? `＋ ${slotLabel}` : slotLabel);
      button.title = occupied ? "这个分支已经创建" : `从这里开始${slotLabel}分支`;
    });
  }

  function renderMinimap() {
    const visible = Graph.model.nodes.length > 3; DOM.minimap.hidden = !visible; if (!visible) return;
    DOM.minimapSvg.replaceChildren(); DOM.minimapSvg.setAttribute("viewBox", `${Graph.minX} ${Graph.minY} ${Graph.width} ${Graph.height}`);
    const defs = document.createElementNS(SVG_NS, "defs");
    const glow = document.createElementNS(SVG_NS, "filter");
    glow.setAttribute("id", "mini-edge-glow");
    glow.setAttribute("filterUnits", "userSpaceOnUse");
    glow.setAttribute("x", String(Graph.minX - 64)); glow.setAttribute("y", String(Graph.minY - 64));
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
      if (isQAPairEdge(edgeData)) {
        // 缩略图里问答对的黑/白竖连线换成横短线
        const { midY } = qaDividerGeometry(edgeData, from, to);
        const edge = document.createElementNS(SVG_NS, "line");
        edge.classList.add("mini-edge", "qa-divider", edgeColorClass(edgeData));
        edge.dataset.from = edgeData.from;
        edge.dataset.to = edgeData.to;
        edge.dataset.relation = edgeData.relation;
        edge.setAttribute("x1", String(from.x - 5));
        edge.setAttribute("y1", String(midY));
        edge.setAttribute("x2", String(from.x + 5));
        edge.setAttribute("y2", String(midY));
        DOM.minimapSvg.append(edge);
        renderedEdges += 1;
        continue;
      }
      const edge = document.createElementNS(SVG_NS, "path");
      edge.classList.add("mini-edge", edgeColorClass(edgeData));
      edge.dataset.from = edgeData.from;
      edge.dataset.to = edgeData.to;
      edge.dataset.relation = edgeData.relation;
      // 缩略图与主画布同规则：横向时分叉边从父发问卡出发
      const hStart = horizontalEdgeStart(edgeData);
      edge.setAttribute("d", edgePath(hStart ? hStart.position : from, to, 0, 0));
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
    const rect = DOM.viewport.getBoundingClientRect(); viewportRect.setAttribute("x", Math.max(Graph.minX, -Graph.tx / Graph.scale)); viewportRect.setAttribute("y", Math.max(Graph.minY, -Graph.ty / Graph.scale));
    viewportRect.setAttribute("width", Math.min(Graph.width, rect.width / Graph.scale)); viewportRect.setAttribute("height", Math.min(Graph.height, rect.height / Graph.scale)); DOM.minimapSvg.append(viewportRect);
  }

  function applyTransform() {
    Graph.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Graph.scale));
    const overviewMode = Graph.scale < OVERVIEW_SCALE;
    if (Graph.overviewMode !== overviewMode) {
      Graph.overviewMode = overviewMode;
      DOM.viewport.classList.toggle("is-overview", overviewMode);
      // 缩放跨过概览阈值时只重绘外观，不重排布局（reflow:false）：
      // 横向模式是纯自动布局，若在这里重算，缩一下就回到紧凑排列，
      // 用户的手工摆放/当前视口会被重置。卡片尺寸由显式 style.height 决定，
      // 概览态只隐藏正文不改变尺寸，因此保留位置即可，边线照旧。
      requestAnimationFrame(() => renderGraph({ reflow: false }));
    }
    DOM.world.style.transform = `translate(${Graph.tx}px, ${Graph.ty}px) scale(${Graph.scale})`;
    DOM.zoomLabel.textContent = `${Math.round(Graph.scale * 100)}%`; renderMinimap();
  }

  function renderGraph(options = {}) {
    const { reflow = true } = options;
    DOM.emptyState.hidden = State.nodes.length > 0; DOM.nodeCount.textContent = String(State.nodes.length);
    Graph.model = buildGraphModel();
    const focusNode = nodeById(State.currentNodeId); const focusDepth = focusNode ? displayDepth(focusNode.id) : Math.max(0, ...State.nodes.map((node) => displayDepth(node.id)));
    const rootQuestion = State.nodes.find((node) => node.role === "user" && !node.parent_id)?.content;
    const visibleCount = Graph.model.viewState.visibleIds.size;
    // 有节点 → 树状态；刚建好的空主题也算（展示标题与陪伴者标签）
    DOM.studyApp?.classList.toggle("has-tree", State.nodes.length > 0 || State.pendingEmptySession);
    DOM.studyApp?.classList.toggle("is-large-tree", State.nodes.length > 80);
    DOM.viewport.dataset.visibleNodes = String(visibleCount);
    if (DOM.workspaceTitle) DOM.workspaceTitle.textContent = State.sessionTitle || compactText(rootQuestion || "一棵还没起名的树");
    if (DOM.railDepth) DOM.railDepth.textContent = `深度 ${focusDepth}`;
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
    if (reflow) {
      // 完整重排期间禁用卡片位移动画（260ms）：卡片瞬移到目标坐标，
      // 与同一帧画出的连线严格一致，消除"卡片滑行、连线瞬跳"的脱节感。
      DOM.studyApp?.classList.add("is-relayouting");
      buildLayout();
      requestAnimationFrame(() => DOM.studyApp?.classList.remove("is-relayouting"));
    }
    for (const node of Graph.model.nodes) updateNodeElement(node, focusDepth);
    renderEdges();
    DOM.world.style.width = `${Graph.width}px`; DOM.world.style.height = `${Graph.height}px`; applyTransform();
    applyDeckTransforms();
    // 框选随重绘同步：清理已不存在的节点，并给重建的卡片重新上高亮
    for (const id of [...Graph.marqueeSelection]) if (!liveIds.has(id)) Graph.marqueeSelection.delete(id);
    updateSelectionClasses();
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
      // 失败但标记为可重试：任务会在退避后自动重跑，前端继续轮询等待最终结果
      if (job.status === "failed" && job.retryable) {
        State.pendingJobs.set(jobId, true); removeLoading(jobId);
        DOM.composerHint.textContent = "学习服务暂时波动，正在自动重试……";
        window.setTimeout(() => pollJob(jobId, generation), 2000);
        return;
      }
      State.pendingJobs.delete(jobId); removeLoading(jobId); setQuota(job.quota);
      if (job.status === "completed") {
        const userNode = nodeById(job.user_node_id);
        if (userNode && job.user_node?.metadata) {
          userNode.metadata = job.user_node.metadata;
          renderGraph({ reflow: false });
          renderReader();
        }
        appendNode({
          id: job.assistant_node_id,
          session_id: job.session_id,
          parent_id: job.user_node_id,
          role: "assistant",
          branch_type: job.branch_slot || normalizeBranch(userNode?.branch_type),
          content: job.answer || "（没有收到有效回答）",
          metadata: job.assistant_node?.metadata || {},
        });
        // 详情舞台内提问：回答长出后同步刷新舞台到新回答（源卡/三卡一起换）
        if (detailPendingRebuild) {
          detailPendingRebuild = false;
          const fresh = nodeById(job.assistant_node_id);
          if (fresh && window.innerWidth >= 1360) buildDetailStage(fresh, { fly: false });
        }
        setComposerActive(false);  // 回答长出后收起输入框
      } else {
        // 详情舞台内提问最终失败：退回舞台，错误浮层才能被看到
        if (detailPendingRebuild) { detailPendingRebuild = false; clearDetailLayer(); }
        appendError(job.error === "quiz provider is not configured" ? "学习服务尚未配置，请先设置 TREENING_API_KEY。" : "这次学习请求最终失败，可以在「学习任务」里查看原因。");
      }
      DOM.composerHint.textContent = "Enter 发送 · Shift + Enter 换行";
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
    // 详情舞台内提问：保留舞台，回答长出后同步刷新到新回答（不再强制退出）。
    // 只有不在舞台时才清理（避免舞台与画布双重态）。
    const wasInDetail = Boolean(detailLayer);
    if (!wasInDetail) clearDetailLayer();
    else detailPendingRebuild = true;
    DOM.sendButton.disabled = true; DOM.composerHint.textContent = "请求已进入学习队列……";
    try {
      const idempotency_key = (crypto.randomUUID && crypto.randomUUID()) || ("k-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10));
      const result = await API.ask({ session_id: State.sessionId, parent_node_id: branchParentId(), interaction_type: State.interactionType, question, idempotency_key });
      if (!State.sessionId && result.session_id) {
        State.sessionId = result.session_id;
        activateFoldSession(State.sessionId);
      }
      syncReplayHref(State.sessionId);
      setQuota(result.quota); appendNode(result.user_node); DOM.messageInput.value = "";
      // 移动端：发送成功后收起工作台，露出画布上的新节点与生成进度
      if (isMobile()) setMobileWorkspace("collapsed");
      State.pendingJobs.set(result.job_id, true); appendLoading(result.job_id); window.setTimeout(() => pollJob(result.job_id, State.sessionGeneration), 200);
    } catch (error) {
      // 详情内提问失败：退回舞台，让错误提示可见（舞台层会挡住画布错误浮层）
      if (wasInDetail) clearDetailLayer();
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
  function chooseInteraction(button) { chooseInteractionType(button.dataset.interaction); setComposerActive(true); }

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
    // 聚焦视图（邻近/路径）才压暗非焦点节点；完整树默认全亮便于阅读
    DOM.studyApp?.classList.toggle("is-focus-view", State.viewMode !== "tree");
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
    const composerInset = (!DOM.composer.classList.contains("is-collapsed") && window.matchMedia("(min-width: 861px)").matches) ? 138 : 0;
    const usableHeight = Math.max(180, rect.height - composerInset);
    Graph.scale = Math.max(MIN_SCALE, Math.min(1.05, (rect.width - pad * 2) / Graph.width, (usableHeight - pad * 2) / Graph.height));
    // 包围盒中心 (minX+width/2, minY+height/2) 对准视口中心；无墙后包围盒可能起于负坐标
    Graph.tx = rect.width / 2 - (Graph.minX + Graph.width / 2) * Graph.scale; Graph.ty = usableHeight / 2 - (Graph.minY + Graph.height / 2) * Graph.scale; applyTransform();
  }
  function scheduleFit() {
    // 首帧布局可能尚未稳定：双 rAF + 超时兜底重 fit，确保用最终视口尺寸居中
    requestAnimationFrame(() => requestAnimationFrame(() => fitGraph()));
    window.setTimeout(() => { if (State.nodes.length) fitGraph(); }, 250);
  }
  async function compactLayout() {
    // 「紧凑排版」：卡片恢复默认尺寸、清除全部手动摆放，按默认间距紧凑重排。
    if (!State.sessionId || !State.nodes.length) return;
    pushCanvasUndo(captureCanvasSnapshot());  // 可撤销：撤销恢复旧摆放
    try {
      await API.clearSessionLayouts(State.sessionId);
      // 内存态同步：去掉节点上的 layout 元数据（尺寸/位置回默认）
      for (const node of State.nodes) {
        if (node.metadata && typeof node.metadata === "object" && node.metadata.layout) {
          delete node.metadata.layout;
        }
      }
      renderGraph();
      fitGraph();
    } catch (error) {
      appendError(error.message || "紧凑排版失败，请重试。");
    }
  }
  function centerOnNode(id) {
    const position = Graph.positions.get(id); if (!position) return;
    const rect = DOM.viewport.getBoundingClientRect();
    const composerInset = (!DOM.composer.classList.contains("is-collapsed") && window.matchMedia("(min-width: 861px)").matches) ? 138 : 0;
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
      // 移动端查看模式允许从卡片上开始单指平移（编辑模式下卡片留给节点拖拽/长按）
      const onCard = event.target.closest(".graph-node");
      if (onCard && !(isMobile() && !isMobileEditMode())) return;
      if (event.target.closest(".minimap, button, textarea, input")) return;
      event.preventDefault();  // 平移/框选时不触发原生拖拽/文本选区
      // 双指捏合缩放：第二根手指落下时结束单指平移，进入缩放手势。
      // 防御：丢弃 2s 前遗留的指针（浏览器偶发丢失 pointerup 时避免误判捏合）。
      const nowTs = Date.now();
      for (const [pid, p] of [...Graph.activePointers]) {
        if (nowTs - (p.ts || 0) > 2000) Graph.activePointers.delete(pid);
      }
      Graph.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY, ts: nowTs });
      if (Graph.activePointers.size >= 2 && !Graph.pinch && !Graph.marquee) {
        clearMobileHold();
        Graph.dragging = false;
        DOM.viewport.classList.remove("is-panning");
        const entries = [...Graph.activePointers.entries()];
        const [idA, a] = entries[entries.length - 2];
        const [idB, b] = entries[entries.length - 1];
        Graph.pinch = {
          ids: [idA, idB], p0: a, p1: b,
          d0: Math.max(8, Math.hypot(a.x - b.x, a.y - b.y)),
          s0: Graph.scale, tx0: Graph.tx, ty0: Graph.ty,
          mx0: (a.x + b.x) / 2, my0: (a.y + b.y) / 2,
        };
        return;
      }
      // 框选进行中：其他手指不干扰（等待框选收尾）
      if (Graph.marquee) { Graph.dragging = false; return; }
      // Ctrl/⌘ + 拖拽 = 框选节点；否则 = 平移（并清空框选）
      if (event.ctrlKey || event.metaKey) { beginMarquee(event); return; }
      clearMarqueeSelection();
      // 未发问时点击画布空白：收起输入框（空树除外——空树必须靠输入框开始）
      if (State.nodes.length > 0 && DOM.composer && !DOM.composer.classList.contains("is-collapsed")) {
        setComposerActive(false);
      }
      Graph.dragging = true; Graph.pointerId = event.pointerId;
      Graph.panStartX = event.clientX; Graph.panStartY = event.clientY;
      Graph.lastPointer = { x: event.clientX, y: event.clientY }; DOM.viewport.classList.add("is-panning"); DOM.viewport.setPointerCapture(event.pointerId);
    });
    DOM.viewport.addEventListener("selectstart", (event) => {
      if (Graph.dragging || Graph.marquee) event.preventDefault();  // 平移/框选中禁止文本选区
    });
    DOM.viewport.addEventListener("pointermove", (event) => {
      if (Graph.marquee && event.pointerId === Graph.marquee.pointerId) { updateMarquee(event); event.preventDefault(); return; }
      if (Graph.pinch) {
        Graph.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY, ts: Date.now() });
        if (Graph.pinch.ids.includes(event.pointerId)) {
          const a = Graph.activePointers.get(Graph.pinch.ids[0]);
          const b = Graph.activePointers.get(Graph.pinch.ids[1]);
          if (a && b) {
            const d = Math.max(8, Math.hypot(a.x - b.x, a.y - b.y));
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Graph.pinch.s0 * d / Graph.pinch.d0));
            // 起始中点对应的世界点跟着手指的中点走，保证缩放中心不跳
            Graph.tx = mx - (Graph.pinch.mx0 - Graph.pinch.tx0) * (next / Graph.pinch.s0);
            Graph.ty = my - (Graph.pinch.my0 - Graph.pinch.ty0) * (next / Graph.pinch.s0);
            Graph.scale = next;
            applyTransform();
          }
        }
        event.preventDefault();
        return;
      }
      if (!Graph.dragging || event.pointerId !== Graph.pointerId) return;
      Graph.tx += event.clientX - Graph.lastPointer.x; Graph.ty += event.clientY - Graph.lastPointer.y; Graph.lastPointer = { x: event.clientX, y: event.clientY }; applyTransform();
      // 平移幅度足够后短时抑制落回卡片的 click（一次手势里的平移不被误判成选中/展开）
      if (isMobile() && Date.now() >= Graph.mobileSuppressAnyNodeClickUntil
          && Math.abs(event.clientX - Graph.panStartX) + Math.abs(event.clientY - Graph.panStartY) > 12) {
        Graph.mobileSuppressAnyNodeClickUntil = Date.now() + 400;
      }
    });
    const stopPan = (event) => {
      if (Graph.marquee && event.pointerId === Graph.marquee.pointerId) { finishMarquee(event); return; }
      Graph.activePointers.delete(event.pointerId);
      if (Graph.pinch && Graph.pinch.ids.includes(event.pointerId)) {
        Graph.pinch = null;
        // 捏合结束但仍有单指按住 → 无缝转为平移
        if (Graph.activePointers.size === 1) {
          const [pid, pt] = [...Graph.activePointers.entries()][0];
          Graph.dragging = true; Graph.pointerId = pid;
          Graph.panStartX = pt.x; Graph.panStartY = pt.y;
          Graph.lastPointer = { x: pt.x, y: pt.y };
        }
      }
      if (event.pointerId !== Graph.pointerId) return;
      const moved = Math.hypot(event.clientX - Graph.panStartX, event.clientY - Graph.panStartY) > 6;
      Graph.dragging = false; DOM.viewport.classList.remove("is-panning");
      // 移动端点空白（无位移的轻点）= 取消选中，工作台把手回到「整棵树视图」
      if (!moved && isMobile() && event.type === "pointerup") setCurrentNode(null, { center: false });
    };
    DOM.viewport.addEventListener("pointerup", stopPan); DOM.viewport.addEventListener("pointercancel", stopPan);
    // 空格键已不再承担任何画布职责（滚轮缩放改为直接绑定画布）：
    // 移除 spaceHeld 状态，避免焦点切换导致"空格卡在画布里"的残留问题。
    window.addEventListener("pointermove", moveNodePointer, { passive: false });
    window.addEventListener("pointerup", finishNodePointer);
    window.addEventListener("pointercancel", finishNodePointer);
    DOM.minimapSvg.addEventListener("click", (event) => {
      if (State.nodes.length <= 3) return;
      const rect = DOM.minimapSvg.getBoundingClientRect(); const x = Graph.minX + (event.clientX - rect.left) / rect.width * Graph.width; const y = Graph.minY + (event.clientY - rect.top) / rect.height * Graph.height; const viewport = DOM.viewport.getBoundingClientRect();
      Graph.tx = viewport.width / 2 - x * Graph.scale; Graph.ty = viewport.height / 2 - y * Graph.scale; applyTransform();
    });
    DOM.fitGraphButton.addEventListener("click", fitGraph); DOM.zoomInButton.addEventListener("click", () => zoomAt(DOM.viewport.getBoundingClientRect().left + DOM.viewport.clientWidth / 2, DOM.viewport.getBoundingClientRect().top + DOM.viewport.clientHeight / 2, 1.16));
    DOM.zoomOutButton.addEventListener("click", () => zoomAt(DOM.viewport.getBoundingClientRect().left + DOM.viewport.clientWidth / 2, DOM.viewport.getBoundingClientRect().top + DOM.viewport.clientHeight / 2, .86));
    DOM.undoCanvasButton?.addEventListener("click", undoCanvasAction);
    const compactButton = document.querySelector("#compact-layout-button");
    if (compactButton) compactButton.addEventListener("click", () => { compactLayout().catch((error) => appendError(error.message || "紧凑排版失败，请重试。")); });
    const orientationButton = document.querySelector("#orientation-toggle-button");
    if (orientationButton) {
      syncOrientationButton();
      orientationButton.addEventListener("click", async () => {
        try {
          const next = isHorizontal() ? "vertical" : "horizontal";
          const result = await API.saveLayoutPrefs({ orientation: next });
          applyLayoutPrefs(result.layout_prefs);
          // 方向切换 = 全局布局规则变化：服务端已清空所有已保存 layout，内存同步清空
          // （坐标/尺寸回默认，与紧凑排版一致），避免后续切回纵向时读到陈旧位置。
          if (result.layout_reset) {
            for (const node of State.nodes) {
              if (node.metadata && typeof node.metadata === "object" && node.metadata.layout) {
                delete node.metadata.layout;
              }
            }
          }
          syncOrientationButton();
          renderGraph();
          fitGraph();
        } catch (error) {
          appendError(error.message || "切换方向失败，请重试。");
        }
      });
    }
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
      _resizeTimer = window.setTimeout(() => {
        // 详情打开时窗口变化：宽屏重建工作台（直接就位，不重播 FLIP）；缩到窄屏则收起舞台
        if (detailSourceNodeId) {
          if (window.innerWidth >= 1360) {
            const focus = nodeById(detailSourceNodeId);
            if (focus) { centerOnNode(focus.id); buildDetailStage(focus, { fly: false }); return; }
          } else {
            clearDetailLayer();
          }
        }
        // 跨 1360 边界时刷新阅读栏拆解回退的可见性
        if (State.readerNodeId) renderReader();
        if (State.nodes.length) fitGraph();
      }, 200);
    });
    // 字体就绪后重新布局（防止测量用的是回退字体）。卡片尺寸均由显式
    // style.height 固定，坐标不会因此改变；不重新 fitGraph，避免把用户
    // 正在查看的视口拽回居中（这正是"一缩放/操作后整树漂移"的来源之一）。
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (State.nodes.length) renderGraph();
      });
    }
    setupNodeSearch();
  }

  // 节点搜索：Ctrl/Cmd+F（或 K）唤出浮层，输入即过滤，回车跳转，Esc 关闭
  function setupNodeSearch() {
    const input = DOM.nodeSearchInput;
    if (!input) return;
    const results = DOM.nodeSearchResults;
    const panel = DOM.nodeSearch;
    let matches = [];

    const textOf = (node) => {
      const summary = node.metadata && typeof node.metadata.summary === "string" ? node.metadata.summary : "";
      return `${node.content || ""} ${summary}`.toLowerCase();
    };
    const clearHighlight = () => { for (const el of Graph.elements.values()) el.classList.remove("is-search-match"); };
    const applyHighlight = () => { for (const [id, el] of Graph.elements) el.classList.toggle("is-search-match", matches.some((m) => m.id === id)); };
    const close = () => { input.value = ""; matches = []; results.hidden = true; results.replaceChildren(); clearHighlight(); input.blur(); if (panel) panel.hidden = true; };
    const open = () => { if (panel) panel.hidden = false; input.focus(); input.select(); };

    const render = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { matches = []; results.hidden = true; results.replaceChildren(); clearHighlight(); return; }
      matches = State.nodes.filter((node) => textOf(node).includes(q)).slice(0, 12);
      results.replaceChildren();
      if (!matches.length) {
        const li = document.createElement("li"); li.className = "node-search-empty"; li.textContent = "没有匹配的节点";
        results.append(li);
      } else {
        matches.forEach((node) => {
          const li = document.createElement("li"); li.className = "node-search-item"; li.tabIndex = -1;
          const role = document.createElement("span"); role.className = "node-search-role"; role.textContent = node.role === "user" ? "你" : "Treening";
          const text = document.createElement("span"); text.className = "node-search-text"; text.textContent = compactText(node.content || node.metadata?.summary || "", 44);
          li.append(role, text);
          li.addEventListener("pointerdown", (event) => { event.preventDefault(); jump(node.id); });
          results.append(li);
        });
      }
      results.hidden = false;
      applyHighlight();
    };
    const jump = (nodeId) => { close(); setCurrentNode(nodeId, { center: true }); };

    input.addEventListener("input", render);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === "Enter") { event.preventDefault(); if (matches.length) jump(matches[0].id); }
      else if (event.key === "ArrowDown") { event.preventDefault(); results.querySelector(".node-search-item")?.focus(); }
    });
    input.addEventListener("focus", () => { if (input.value.trim()) render(); });
    window.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "f" || key === "k") { event.preventDefault(); open(); }
      }
    });
    document.addEventListener("pointerdown", (event) => { if (!event.target.closest(".node-search")) close(); });
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
      clearDetailLayer();
    };
    const togglePanel = (name) => {
      const target = panels[name];
      if (!target?.panel) return;
      // 宽屏左栏常驻，历史面板仅窄屏需要；阅读面板任意宽度都可展开
      if (name === "history" && window.innerWidth >= 768) return;
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
    window.addEventListener("keydown", (event) => { if (event.key === "Escape") { clearMarqueeSelection(); closePanels(); } });
    window.addEventListener("resize", () => { if (window.innerWidth < 768) closePanels(); });
  }

  // ── 移动端「研究工作台」统一抽屉（收起 / 半展开 / 全展开）+ 触屏查看/编辑模型 ──
  // 桌面（≥768px）完全不动：抽屉、移动画布控制、触屏手势全在 ≤767px 启用。
  function isMobile() { return window.innerWidth <= 767; }
  function isMobileEditMode() { return document.body.classList.contains("mobile-edit-mode"); }
  function enterMobileEditMode() {
    document.body.classList.add("mobile-edit-mode");
    syncMobileModeButtons();
    // 进入编辑时收起正在编辑的焦点：触屏不弹键盘
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
      document.activeElement.blur();
    }
  }
  function exitMobileEditMode() {
    document.body.classList.remove("mobile-edit-mode");
    syncMobileModeButtons();
  }
  function syncMobileModeButtons() {
    const viewBtn = document.querySelector("#mobile-mode-view");
    const editBtn = document.querySelector("#mobile-mode-edit");
    if (!viewBtn || !editBtn) return;
    const editing = isMobileEditMode();
    viewBtn.classList.toggle("is-active", !editing);
    viewBtn.setAttribute("aria-pressed", String(!editing));
    editBtn.classList.toggle("is-active", editing);
    editBtn.setAttribute("aria-pressed", String(editing));
  }

  let mobileWorkspaceState = "collapsed";
  let mobileWorkspaceTab = "qa";
  let mobilePanelsRelocated = false;
  let syncMobileLayoutTimer = null;

  function mobileWorkspaceEl() { return document.querySelector("#mobile-workspace"); }
  function mobileSheetScroll() { return document.querySelector("#mobile-workspace-scroll"); }

  function setMobileWorkspace(state) {
    if (!isMobile()) return;
    mobileWorkspaceState = state;
    const ws = mobileWorkspaceEl(); if (!ws) return;
    ws.hidden = false;
    document.body.classList.toggle("mobile-ws-collapsed", state === "collapsed");
    document.body.classList.toggle("mobile-ws-half", state === "half");
    document.body.classList.toggle("mobile-ws-full", state === "full");
    const handle = document.querySelector("#mobile-workspace-handle");
    const sheet = document.querySelector("#mobile-workspace-sheet");
    handle?.setAttribute("aria-expanded", String(state !== "collapsed"));
    sheet.hidden = state === "collapsed";
    if (state !== "collapsed") setMobileWorkspaceTab(mobileWorkspaceTab, { scroll: true });
  }
  function nextMobileWorkspaceState() {
    // 三态循环推进：收起 → 半展开 → 全展开 → 收起（全展开也能收回）
    const order = ["collapsed", "half", "full"];
    const idx = order.indexOf(mobileWorkspaceState);
    const next = order[(idx + 1) % order.length];
    setMobileWorkspace(next);
    return next;
  }
  function prevMobileWorkspaceState() {
    // 下拖收回：全展开 → 半展开 → 收起（收起保持不变）
    const order = ["collapsed", "half", "full"];
    const idx = order.indexOf(mobileWorkspaceState);
    const next = order[Math.max(0, idx - 1)];
    setMobileWorkspace(next);
    return next;
  }
  function setMobileWorkspaceTab(tab, options = {}) {
    mobileWorkspaceTab = tab;
    const ws = mobileWorkspaceEl(); if (!ws) return;
    ws.classList.toggle("sheet-tab-qa", tab === "qa");
    ws.classList.toggle("sheet-tab-reader", tab === "reader");
    ws.classList.toggle("sheet-tab-history", tab === "history");
    for (const t of ws.querySelectorAll(".mobile-tab")) {
      const on = t.dataset.mobileTab === tab;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", String(on));
    }
    if (options.scroll) {
      const scroll = mobileSheetScroll();
      if (scroll) scroll.scrollTop = 0;
    }
  }
  function updateMobileCurrentNode() {
    const label = document.querySelector("#mobile-current-node");
    if (!label) return;
    const node = nodeById(State.currentNodeId);
    label.textContent = node
      ? `${node.role === "assistant" ? "回答 · " : ""}${compactText(node.content, 26)}`
      : "整棵树视图";
  }

  // ≤767px 时把阅读栏 / 历史栏 / 提问框搬进工作台抽屉，画布顶部模块搬进右上角展开弹层；
  // ≥768px 全部还原原位（挂载点不同）。
  function relocateMobilePanels() {
    if (!isMobile() || mobilePanelsRelocated) return;
    const scroll = mobileSheetScroll(); if (!scroll) return;
    if (DOM.sessionRail) scroll.append(DOM.sessionRail);
    if (DOM.readerPanel) scroll.append(DOM.readerPanel);
    if (DOM.composer) scroll.append(DOM.composer);
    const popover = document.querySelector("#mobile-canvas-popover");
    if (popover) {
      for (const sel of [".canvas-tl", ".mobile-canvas-controls", ".bulk-visibility-controls", ".minimap"]) {
        const el = document.querySelector(sel);
        if (el) popover.append(el);
      }
    }
    mobilePanelsRelocated = true;
  }
  function restoreMobilePanels() {
    if (!mobilePanelsRelocated) return;
    const layout = document.querySelector(".study-layout");
    const conversation = document.querySelector(".conversation-area");
    const viewport = DOM.viewport;
    if (layout && DOM.sessionRail) layout.insertBefore(DOM.sessionRail, layout.querySelector(".conversation-area"));
    if (layout && DOM.readerPanel) layout.append(DOM.readerPanel);
    if (conversation && DOM.composer) conversation.append(DOM.composer);
    if (viewport) {
      if (DOM.minimap) viewport.append(DOM.minimap);  // 先把 minimap 放回画布，作后续插入的锚点
      const canvasTl = document.querySelector(".canvas-tl");
      if (canvasTl) viewport.insertBefore(canvasTl, DOM.minimap || viewport.firstChild);
      const mobileControls = document.querySelector(".mobile-canvas-controls");
      if (mobileControls) viewport.insertBefore(mobileControls, canvasTl ? canvasTl.nextSibling : viewport.firstChild);
      const bulk = document.querySelector(".bulk-visibility-controls");
      if (bulk && DOM.minimap) viewport.insertBefore(bulk, DOM.minimap);
    }
    mobilePanelsRelocated = false;
  }
  function syncMobileLayout() {
    const controls = document.querySelector("#mobile-canvas-controls");
    const moreButton = document.querySelector("#mobile-more-button");
    const moreMenu = document.querySelector("#mobile-more-menu");
    const expandBtn = document.querySelector("#mobile-canvas-expand");
    const popover = document.querySelector("#mobile-canvas-popover");
    if (isMobile()) {
      relocateMobilePanels();
      // [hidden]{display:none!important} 会压过移动端 display:flex，必须清除 hidden
      if (controls) controls.hidden = false;
      if (moreButton) moreButton.hidden = false;
      if (moreMenu) moreMenu.hidden = true;
      if (expandBtn) expandBtn.hidden = false;
      if (popover) popover.hidden = true;
      const hasState = document.body.classList.contains("mobile-ws-collapsed")
        || document.body.classList.contains("mobile-ws-half")
        || document.body.classList.contains("mobile-ws-full");
      if (!hasState) setMobileWorkspace("collapsed");
    } else {
      restoreMobilePanels();
      if (controls) controls.hidden = true;
      if (moreButton) moreButton.hidden = true;
      if (moreMenu) moreMenu.hidden = true;
      if (expandBtn) expandBtn.hidden = true;
      if (popover) popover.hidden = true;
      document.body.classList.remove("mobile-ws-collapsed", "mobile-ws-half", "mobile-ws-full", "mobile-edit-mode");
      syncMobileModeButtons();
      const ws = mobileWorkspaceEl();
      if (ws) ws.hidden = true;
    }
  }

  // 提问框已迁入工作台抽屉：打开抽屉「提问」页并聚焦（把手「继续提问」）
  function focusMobileComposer() {
    if (!isMobile()) return;
    setMobileWorkspace("half");
    setMobileWorkspaceTab("qa");
    setComposerActive(true);
    // 触屏键盘打开后再把提问框滚到可见位置
    window.setTimeout(() => { DOM.messageInput?.scrollIntoView({ block: "center", behavior: "smooth" }); }, 80);
  }

  function centerOnRoot() {
    const root = State.nodes.find((n) => !n.parent_id) || State.nodes[0];
    if (root) centerOnNode(root.id);
  }

  // 长按进入编辑模式并抓住节点（查看模式下卡片只负责平移/选中/双击详情）
  let mobileHold = null;
  let mobileHoldTimer = null;
  function beginMobileHold(event, node, card) {
    if (event.button !== 0 || event.target.closest("button, .node-resize-handle")) return;
    clearMobileHold();
    mobileHold = { node, card, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    mobileHoldTimer = window.setTimeout(() => {
      if (!mobileHold || mobileHold.pointerId !== event.pointerId) return;
      fireMobileHoldGrab(event.pointerId);
    }, 480);
  }
  function clearMobileHold() {
    if (mobileHoldTimer) { window.clearTimeout(mobileHoldTimer); mobileHoldTimer = null; }
    mobileHold = null;
  }
  function fireMobileHoldGrab(pointerId) {
    const hold = mobileHold;
    clearMobileHold();
    if (!hold || !isMobile()) return;
    enterMobileEditMode();
    // 长按期间可能已开始画布平移/捏合：先终止，再抓住该节点
    Graph.dragging = false;
    DOM.viewport.classList.remove("is-panning");
    Graph.pinch = null;
    Graph.activePointers.clear();
    try { DOM.viewport.releasePointerCapture(pointerId); } catch { /* 未捕获也正常 */ }
    const fake = {
      button: 0,
      clientX: hold.x, clientY: hold.y,
      pointerId,
      target: hold.card,
      preventDefault() {}, stopPropagation() {},
    };
    beginNodeDrag(fake, hold.node, hold.card, { synthetic: true });
  }

  function setupMobileWorkspace() {
    syncMobileLayout();

    // 把手：上拖推进 / 下拖收回 / 点按循环（收起 → 半展开 → 全展开 → 收起）
    const handle = document.querySelector("#mobile-workspace-handle");
    if (handle) {
      let holdY = null;
      let advanced = false;
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest(".mobile-ask-button, .mobile-close-button")) return;
        holdY = event.clientY; advanced = false;
        try { handle.setPointerCapture?.(event.pointerId); } catch { /* 忽略 */ }
      });
      handle.addEventListener("pointermove", (event) => {
        if (holdY == null || advanced) return;
        if (holdY - event.clientY > 42) { advanced = true; nextMobileWorkspaceState(); }
        else if (event.clientY - holdY > 42) { advanced = true; prevMobileWorkspaceState(); }
      });
      handle.addEventListener("pointerup", (event) => {
        if (holdY == null) return;
        holdY = null;
        if (!advanced) nextMobileWorkspaceState();
      });
      handle.addEventListener("pointercancel", () => { holdY = null; });
      handle.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); nextMobileWorkspaceState(); }
      });
    }
    // 抽屉关闭按钮：一键收起
    document.querySelector("#mobile-workspace-close")?.addEventListener("click", (event) => {
      event.stopPropagation();
      setMobileWorkspace("collapsed");
    });
    // 把手内「继续提问」：打开抽屉「提问」页并聚焦
    document.querySelector("#mobile-handle-ask")?.addEventListener("click", (event) => {
      event.stopPropagation();
      focusMobileComposer();
    });
    // 头部「⋯」更多菜单：导出 / 回放 / 紧凑 / 方向 / 配置 / 退出
    const moreButton = document.querySelector("#mobile-more-button");
    const moreMenu = document.querySelector("#mobile-more-menu");
    function toggleMobileMoreMenu(forceOpen) {
      if (!moreButton || !moreMenu) return;
      const show = forceOpen === undefined ? moreMenu.hidden : forceOpen;
      moreMenu.hidden = !show;
      moreButton.setAttribute("aria-expanded", String(show));
    }
    moreButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMobileMoreMenu(moreMenu?.hidden);
    });
    document.addEventListener("pointerdown", (event) => {
      if (moreMenu && !moreMenu.hidden && !event.target.closest("#mobile-more-menu, #mobile-more-button")) {
        toggleMobileMoreMenu(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && moreMenu && !moreMenu.hidden) toggleMobileMoreMenu(false);
    });
    moreMenu?.addEventListener("click", (event) => {
      const exportFmt = event.target.closest("[data-mobile-export]");
      if (exportFmt) {
        if (DOM.exportFormat) DOM.exportFormat.value = exportFmt.dataset.mobileExport;
        exportSession();
        toggleMobileMoreMenu(false);
        return;
      }
      if (event.target.id === "mobile-more-new") createNewSession();
      else if (event.target.id === "mobile-more-replay") document.querySelector("#replay-link")?.click();
      else if (event.target.id === "mobile-more-compact") document.querySelector("#compact-layout-button")?.click();
      else if (event.target.id === "mobile-more-orientation") document.querySelector("#orientation-toggle-button")?.click();
      else if (event.target.id === "mobile-more-setup") { window.location.href = "/setup"; return; }
      else if (event.target.id === "mobile-more-logout") document.querySelector("#logout-button")?.click();
      toggleMobileMoreMenu(false);
    });

    // 画布右上角「⌄」展开键：打开/收起画布控制弹层（视图切换 / 查看·编辑 / 全部隐藏 / OVERVIEW）
    const expandBtn = document.querySelector("#mobile-canvas-expand");
    const canvasPopover = document.querySelector("#mobile-canvas-popover");
    function setCanvasPopover(open) {
      if (!expandBtn || !canvasPopover) return;
      canvasPopover.hidden = !open;
      expandBtn.setAttribute("aria-expanded", String(open));
    }
    expandBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      setCanvasPopover(canvasPopover?.hidden);
    });
    document.addEventListener("pointerdown", (event) => {
      if (canvasPopover && !canvasPopover.hidden
          && !event.target.closest("#mobile-canvas-popover, #mobile-canvas-expand")) {
        setCanvasPopover(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && canvasPopover && !canvasPopover.hidden) setCanvasPopover(false);
    });

    // 标签页切换（节点详情 / 历史主题）
    mobileWorkspaceEl()?.addEventListener("click", (event) => {
      const tab = event.target.closest(".mobile-tab");
      if (tab?.dataset.mobileTab) setMobileWorkspaceTab(tab.dataset.mobileTab);
    });

    // 查看 / 编辑切换
    document.querySelector("#mobile-mode-view")?.addEventListener("click", exitMobileEditMode);
    document.querySelector("#mobile-mode-edit")?.addEventListener("click", enterMobileEditMode);

    // 定位辅助：回到根 / 聚焦当前
    document.querySelector("#mobile-root-button")?.addEventListener("click", centerOnRoot);
    document.querySelector("#mobile-focus-button")?.addEventListener("click", () => {
      if (State.currentNodeId) centerOnNode(State.currentNodeId);
    });

    // 长按进入编辑：手指移动 / 抬起即取消
    window.addEventListener("pointermove", (event) => {
      if (mobileHold && event.pointerId === mobileHold.pointerId
          && Math.hypot(event.clientX - mobileHold.x, event.clientY - mobileHold.y) > 10) clearMobileHold();
    });
    window.addEventListener("pointerup", (event) => { if (mobileHold && event.pointerId === mobileHold.pointerId) clearMobileHold(); });
    window.addEventListener("pointercancel", (event) => { if (mobileHold && event.pointerId === mobileHold.pointerId) clearMobileHold(); });

    // 跨宽度边界搬移面板（防抖）
    window.addEventListener("resize", () => {
      window.clearTimeout(syncMobileLayoutTimer);
      syncMobileLayoutTimer = window.setTimeout(syncMobileLayout, 150);
    });
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
    State.sessionId = result.session?.id || null;
    syncReplayHref(State.sessionId);
    if (State.sessionId) activateFoldSession(State.sessionId);
    else State.foldedBranches = new Set();
    State.pendingEmptySession = false;
    State.maxBranches = result.max_branches || 3;
    applyBranchLabels(result.branch_labels);
    applyLayoutPrefs(result.layout_prefs);
    State.sessionTitle = result.session?.title || result.session?.root_question || "";
    State.sessionPersona = result.session?.persona || "";
    setQuota(result.quota); renderInitialNodes(result.nodes);
    refreshPersonaTag();
    // 移动端空树：先打开工作台「提问」页，再聚焦输入框（隐藏容器内聚焦无效）
    if (isMobile() && !result.session) {
      setMobileWorkspace("half");
      setMobileWorkspaceTab("qa");
    }
    setComposerActive(!result.session);  // 空树显示输入框，有树收起
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
    State.pendingEmptySession = false;
    State.sessionId = result.session.id; activateFoldSession(State.sessionId); State.maxBranches = result.max_branches || State.maxBranches;
    syncReplayHref(State.sessionId);
    applyBranchLabels(result.branch_labels);
    applyLayoutPrefs(result.layout_prefs);
    State.sessionTitle = result.session.title || result.session.root_question || "";
    State.sessionPersona = result.session.persona || "";
    setQuota(result.quota); renderInitialNodes(result.nodes);
    refreshPersonaTag();
    setComposerActive(false);  // 有树主题默认收起输入框
    resumeActiveJobs(result);
    chooseInteractionType("question"); await loadSessionHistory();
  }

  function downloadNameFrom(response) {
    // 从 Content-Disposition 取文件名：优先 RFC 5987 的 filename*（可带中文），
    // 否则退回到 filename，再退回到 "export"。
    const disposition = response.headers.get("Content-Disposition") || "";
    const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (star) {
      try { return decodeURIComponent(star[1]); } catch (_) { /* 回退到 filename */ }
    }
    const plain = disposition.match(/filename="?([^";]+)"?/i);
    if (plain) return plain[1].trim();
    return "export";
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
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadNameFrom(response);
      document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    } catch (error) {
      appendError(error.message || "导出失败，请稍后重试。");
    } finally { DOM.exportButton.disabled = false; }
  }
  function personaNameFor(text) {
    if (!text) return "春宁";  // 未指定 = 默认春宁
    const match = State.personaPresets.find((preset) => preset.id === text);
    return match ? match.name : "自定义人设";
  }

  function refreshPersonaTag() {
    if (!DOM.personaTag) return;
    if (!State.sessionId) { DOM.personaTag.hidden = true; return; }
    DOM.personaTag.hidden = false;
    DOM.personaTagLabel.textContent = personaNameFor(State.sessionPersona);
  }

  function renderPersonaOptions() {
    if (!DOM.personaOptions) return;
    DOM.personaOptions.innerHTML = "";
    // 默认选中：当前树的陪伴者；未指定 = 春宁（默认）
    const current = State.sessionPersona || "chunyu";
    const add = (preset, checked) => {
      const label = document.createElement("label");
      label.className = "persona-option";
      const input = document.createElement("input");
      input.type = "radio"; input.name = "persona-choice"; input.value = preset.id; input.checked = checked;
      const nameSpan = document.createElement("span"); nameSpan.className = "persona-option-name"; nameSpan.textContent = preset.name;
      const noteSpan = document.createElement("span"); noteSpan.className = "persona-option-note"; noteSpan.textContent = preset.note || "";
      label.append(input, nameSpan, noteSpan);
      DOM.personaOptions.append(label);
    };
    for (const preset of State.personaPresets) {
      add(preset, preset.id === current);
    }
  }

  function openPersonaModal(mode) {
    State.pendingPersonaMode = mode;
    if (!DOM.personaModal) return;
    if (DOM.personaModalTitle) {
      DOM.personaModalTitle.textContent = mode === "switch" ? "切换这棵树的陪伴者" : "新主题：选一位陪伴者";
    }
    renderPersonaOptions();
    DOM.personaModal.hidden = false;
  }

  function closePersonaModal() {
    if (DOM.personaModal) DOM.personaModal.hidden = true;
    State.pendingPersonaMode = null;
  }

  function selectedPersonaValue() {
    const selected = DOM.personaOptions ? DOM.personaOptions.querySelector('input[name="persona-choice"]:checked') : null;
    return selected ? selected.value : "";
  }

  async function loadPersonaPresets() {
    try {
      const result = await API.getPersonaPresets();
      State.personaPresets = Array.isArray(result.presets) ? result.presets : [];
    } catch (_) {
      State.personaPresets = [];
    }
  }

  async function startNewSession(persona) {
    const result = await API.createSession(persona);
    State.sessionGeneration += 1;
    clearPendingJobs();
    State.sessionId = result.session.id; activateFoldSession(State.sessionId); State.maxBranches = result.max_branches || State.maxBranches;
    syncReplayHref(State.sessionId);
    applyBranchLabels(result.branch_labels);
    applyLayoutPrefs(result.layout_prefs);
    State.sessionTitle = "";
    State.sessionPersona = result.session.persona || "";
    State.pendingEmptySession = true;  // 空主题也进入树状态，标题区/陪伴者标签立即可见
    renderInitialNodes([]); setQuota(result.quota); DOM.messageInput.value = ""; chooseInteractionType("question"); setComposerActive(true); await loadSessionHistory();
    refreshPersonaTag();
  }

  function createNewSession() {
    if (State.pendingJobs.size > 0 && !window.confirm("仍有学习请求处理中，确定开始新主题吗？")) return;
    // 新主题 = 选一棵树的陪伴者：先弹人设选择，确认后建树
    openPersonaModal("new");
  }
  DOM.messageForm.addEventListener("submit", submitMessage);
  DOM.messageInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); DOM.messageForm.requestSubmit(); } });
  document.querySelectorAll("[data-interaction]").forEach((button) => button.addEventListener("click", () => chooseInteraction(button)));
  DOM.readerFocusButton.addEventListener("click", () => {
    if (State.readerNodeId) {
      // 移动端：收起工作台露出画布，再定位到该节点
      if (isMobile()) setMobileWorkspace("collapsed");
      setCurrentNode(State.readerNodeId);
      centerOnNode(State.readerNodeId);
    }
  });
  if (DOM.readerRevealButton) DOM.readerRevealButton.addEventListener("click", () => {
    if (State.readerNodeId) revealNode(State.readerNodeId);
  });
  DOM.readerFoldButton?.addEventListener("click", () => {
    if (detailSourceNodeId) return;  // 详情工作台内收起/展开无效化
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
  DOM.newSessionButton.addEventListener("click", () => { try { createNewSession(); } catch (error) { appendError(error.message); } });
  // 人设选择对话框：新主题建树 / 已开树切人设共用
  DOM.personaModalConfirm?.addEventListener("click", async () => {
    const persona = selectedPersonaValue();
    const mode = State.pendingPersonaMode;
    closePersonaModal();
    try {
      if (mode === "switch" && State.sessionId) {
        await API.updateSession(State.sessionId, { persona });
        State.sessionPersona = persona;
        refreshPersonaTag();
      } else if (mode === "new") {
        await startNewSession(persona);
      }
    } catch (error) { appendError(error.message); }
  });
  DOM.personaModalCancel?.addEventListener("click", () => closePersonaModal());
  DOM.personaModalBackdrop?.addEventListener("click", (event) => {
    if (event.target === DOM.personaModal) closePersonaModal();
  });
  DOM.personaTag?.addEventListener("click", () => {
    if (State.sessionId) openPersonaModal("switch");
  });
  if (DOM.railCollapseToggle) {
    DOM.railCollapseToggle.addEventListener("click", () => {
      const collapsed = DOM.studyApp.classList.toggle("is-rail-collapsed");
      DOM.railCollapseToggle.setAttribute("aria-expanded", String(!collapsed));
      const label = collapsed ? "展开左侧栏" : "收起左侧栏";
      DOM.railCollapseToggle.setAttribute("aria-label", label);
      DOM.railCollapseToggle.setAttribute("title", label);
      // 画布随 grid 自动扩大，保持当前缩放与平移，不做强制适配
    });
  }
  // 登出与配置链接权限
  const logoutBtn = document.querySelector("#logout-button");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try { await fetch("/api/auth/logout", { method: "POST" }); } catch (_) { /* ignore */ }
      window.location.href = "/login";
    });
  }
  // 配置入口对所有登录用户开放：每人管理自己的 persona/命名/拆解；
  // 管理员入口仅 admin 角色可见（/admin 路由也有守卫兜底）。
  fetch("/api/auth/me")
    .then((r) => r.json())
    .then((d) => {
      const adminLink = document.querySelector("#admin-link");
      if (adminLink && d?.authenticated && d?.user?.role === "admin") {
        adminLink.hidden = false;
      }
    })
    .catch(() => {});

  // 心跳：每 60 秒上报一次活跃，页面打开期间保持「在线」状态。
  // 服务端根据 last_seen_at（5 分钟窗口）判定在线/离线。
  setInterval(() => {
    fetch("/api/auth/ping", { method: "GET", cache: "no-store" }).catch(() => {});
  }, 60000);

  loadPersonaPresets();
  setupCanvas(); setupResponsivePanels(); setupMobileWorkspace(); renderGraph();

  // 生长回放入口：当前画布上盖一层全屏剧场（openReplayOverlay 内会守卫无主题）
  document.querySelector("#replay-link")?.addEventListener("click", openReplayOverlay);

  // 深链接：/?session=<id> 直达指定主题（回放页「继续学」的落地地址）
  const urlSession = new URLSearchParams(location.search).get("session");
  if (urlSession) {
    loadSessionById(urlSession).catch(() => loadSession());
  } else {
    loadSession();
  }
})();
