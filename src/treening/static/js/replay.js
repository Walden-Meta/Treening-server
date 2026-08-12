/* ============================================================
 * Treening · 生长回放（Growth Replay）— 可挂载的剧场引擎
 *
 * createReplayTheater(container, opts) 在给定容器里搭建整座剧场：
 *   独立页   → container = #replay-app，   opts.picker = true（带主题选择）
 *   画布内嵌 → container = #replay-overlay，opts.sessionId = 当前主题
 *
 * 卡片尺寸统一；内容可在「摘要 / 全文」间切换（控制条二选一）。
 * 摘要默认展示「隐藏后」的摘要（metadata.summary，缺则本地首句兜底；
 * 摘要模式遇无摘要节点会提示一键补生成——走幂等接口，不计问答配额）。
 * 点击卡片弹出全文详情。
 * 镜头跟随「生长前线」（不会随树变大缩成蚂蚁），可拖动平移 / 滚轮缩放，
 * 播完拉到全貌，并提供「回到这棵树继续学」。
 *
 * opts: { sessionId, picker, onExit, onContinue }
 * 返回: { destroy, getSessionId }
 * ============================================================ */
(() => {
  "use strict";

  const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NS = "http://www.w3.org/2000/svg";
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  const BRANCH_LABEL = { check: "验收", followup: "追问", custom: "其他", question: "起点" };
  const BRANCH_COLOR = { check: "#fbbf24", followup: "#38bdf8", custom: "#c084fc", question: "#7dd3a8" };

  function branchOf(node) {
    const b = node.branch_type || "";
    return BRANCH_COLOR[b] ? b : "question";
  }
  function chronoCmp(a, b) {
    const ta = a.created_at || "", tb = b.created_at || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ── 剧场模板：独立页与画布内嵌共用同一份舞台 ── */
  const STAGE_HTML = `
<div class="replay-stage">
  <div class="replay-ambient" id="replay-ambient" aria-hidden="true"></div>
  <header class="replay-header">
    <button class="replay-back" id="replay-close" type="button" title="返回学习空间">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>
      <span>返回学习空间</span>
    </button>
    <div class="replay-titleblock">
      <p class="replay-eyebrow">GROWTH REPLAY</p>
      <h1 id="replay-title">生长回放</h1>
      <p class="replay-subtitle" id="replay-subtitle">看这棵树如何一点点长出路径</p>
    </div>
    <div class="replay-counter" aria-hidden="true">
      <b id="replay-counter-now">0</b><span> / </span><b id="replay-counter-total">0</b><span class="replay-counter-unit">个节点</span>
    </div>
  </header>
  <main class="replay-theater" id="replay-theater" aria-label="知识树生长剧场">
    <div class="replay-world" id="replay-world">
      <svg class="replay-scene" id="replay-scene" aria-hidden="true"></svg>
      <div class="replay-nodes" id="replay-nodes"></div>
    </div>
    <div class="replay-hint" id="replay-hint"><p>点击下方 ▶，看这棵树从一颗种子开始生长</p></div>
    <div class="replay-missing" id="replay-missing" hidden>
      <span>有 <b id="replay-missing-count">0</b> 个节点还没有语义摘要</span>
      <button class="replay-missing-btn" id="replay-missing-go" type="button">生成本树摘要</button>
    </div>
    <div class="replay-detail" id="replay-detail" hidden>
      <button class="replay-detail-close" id="replay-detail-close" type="button" aria-label="关闭详情" title="关闭">×</button>
      <div class="replay-detail-head">
        <span class="replay-detail-role" id="replay-detail-role"></span>
        <span class="replay-detail-tag" id="replay-detail-tag"></span>
      </div>
      <div class="replay-detail-body" id="replay-detail-body"></div>
    </div>
  </main>
  <footer class="replay-controls">
    <label class="replay-picker" id="replay-picker-wrap">
      <span class="replay-picker-label">主题</span>
      <select id="replay-session-select" aria-label="选择回放主题"><option value="">加载中…</option></select>
    </label>
    <div class="replay-playback">
      <div class="replay-mode" role="group" aria-label="卡片内容模式">
        <button class="replay-mode-btn is-active" id="replay-mode-summary" type="button" title="卡片显示隐藏后的摘要">摘要</button>
        <button class="replay-mode-btn" id="replay-mode-full" type="button" title="卡片显示完整内容（点击卡片可看全文）">全文</button>
      </div>
      <button class="replay-btn replay-btn-play" id="replay-play" type="button" title="播放 / 暂停" aria-label="播放 / 暂停">
        <svg id="replay-play-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>
        <svg id="replay-pause-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" hidden><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.6z"/></svg>
      </button>
      <button class="replay-btn" id="replay-restart" type="button" title="重新播放" aria-label="重新播放">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/></svg>
      </button>
      <button class="replay-btn replay-btn-follow" id="replay-follow" type="button" title="镜头跟随生长的前线" aria-label="镜头跟随生长的前线">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
      </button>
      <div class="replay-timeline" id="replay-timeline" role="slider" tabindex="0" aria-label="回放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="replay-progress" id="replay-progress"></div>
        <div class="replay-knob" id="replay-knob"></div>
      </div>
      <label class="replay-speed">
        <select id="replay-speed" aria-label="回放速度">
          <option value="0.5">0.5×</option>
          <option value="1" selected>1×</option>
          <option value="2">2×</option>
          <option value="4">4×</option>
        </select>
      </label>
      <button class="replay-continue" id="replay-continue" type="button" hidden>回到这棵树继续学 →</button>
    </div>
  </footer>
</div>
<div class="replay-empty" id="replay-empty" hidden>
  <p>你还没有种下任何知识树。<br>先回 <a href="/">学习空间</a>，让一个问题长出它的路径。</p>
</div>
`;

  /* ═══════════ 摘要（与主界面「隐藏内容」同一套逻辑） ═══════════ */
  function cleanSummary(raw) {
    let t = String(raw || "").trim();
    const pull = (s) => {
      const m = s.match(/"?(summary|answer_summary|recall_hint|answer)"?\s*[:=]\s*"?([^",}\s][^",}\n]*)/);
      return m ? m[2].trim() : s;
    };
    if (t.startsWith("```")) {
      t = t.replace(/^```[a-zA-Z]*\s*/i, "").trim();
      const brace = t.indexOf("{");
      if (brace >= 0) { const close = t.lastIndexOf("}"); t = close > brace ? t.slice(brace, close + 1) : t.slice(brace); }
      t = pull(t);
    } else if (/^json\s/i.test(t)) {
      t = t.replace(/^json\s*/i, "").replace(/^[{:"']+\s*/, "");
      t = pull(t);
    } else if (/^[{]/.test(t)) {
      t = pull(t);
    }
    return t.replace(/^`+|`+$/g, "").replace(/\s+/g, " ").trim();
  }
  function summaryOf(node) {
    if (node && node.metadata && typeof node.metadata.summary === "string") {
      const cleaned = cleanSummary(node.metadata.summary);
      if (cleaned) {
        return cleaned.length <= 60 ? cleaned
          : cleaned.slice(0, 57).replace(/[，、：；: ]+$/g, "") + "…";
      }
    }
    // 兜底：首句（纯本地，不触发模型、不写库）
    const plain = String(node.content || "").replace(/[`,*_#>\[\]()]/g, "").replace(/\s+/g, " ").trim();
    const first = plain.split(/(?<=[。！？!?；;.])\s*/).find(Boolean) || plain;
    return first.length <= 50 ? first : first.slice(0, 49).replace(/[，、：；: ]+$/g, "") + "…";
  }
  function hasRealSummary(node) {
    return !!(node && node.metadata && typeof node.metadata.summary === "string"
      && cleanSummary(node.metadata.summary));
  }
  function contentTextFor(node, full) {
    if (!node) return "";
    return full ? String(node.content || "") : summaryOf(node);
  }

  /* ═══════════ 工厂：搭建一座剧场 ═══════════ */
  function createReplayTheater(container, opts = {}) {
    container.innerHTML = STAGE_HTML;
    const $ = (sel) => container.querySelector(sel);
    const dom = {
      ambient: $("#replay-ambient"),
      world: $("#replay-world"),
      scene: $("#replay-scene"),
      nodesLayer: $("#replay-nodes"),
      theater: $("#replay-theater"),
      hint: $("#replay-hint"),
      missing: $("#replay-missing"),
      missingCount: $("#replay-missing-count"),
      missingGo: $("#replay-missing-go"),
      modeSummary: $("#replay-mode-summary"),
      modeFull: $("#replay-mode-full"),
      title: $("#replay-title"),
      subtitle: $("#replay-subtitle"),
      select: $("#replay-session-select"),
      pickerWrap: $("#replay-picker-wrap"),
      play: $("#replay-play"),
      playIcon: $("#replay-play-icon"),
      pauseIcon: $("#replay-pause-icon"),
      restart: $("#replay-restart"),
      follow: $("#replay-follow"),
      timeline: $("#replay-timeline"),
      progress: $("#replay-progress"),
      knob: $("#replay-knob"),
      speed: $("#replay-speed"),
      counterNow: $("#replay-counter-now"),
      counterTotal: $("#replay-counter-total"),
      empty: $("#replay-empty"),
      close: $("#replay-close"),
      continueBtn: $("#replay-continue"),
      detail: $("#replay-detail"),
      detailClose: $("#replay-detail-close"),
      detailRole: $("#replay-detail-role"),
      detailTag: $("#replay-detail-tag"),
      detailBody: $("#replay-detail-body"),
    };
    if (!opts.picker && dom.pickerWrap) dom.pickerWrap.hidden = true;
    const exit = opts.onExit || (() => { location.href = "/"; });
    const cont = opts.onContinue || exit;

    /* ── 状态 ── */
    const S = {
      sessions: [],
      sessionId: null,
      nodes: new Map(),
      roots: [],
      seq: [],
      edges: new Map(),
      cards: new Map(),
      worldW: 0,
      worldH: 0,
      clock: 0,
      duration: 0,
      playing: false,
      pausedByUser: false,
      speed: 1,
      raf: 0,
      lastTs: 0,
      bloomed: new Set(),
      lastBloomId: null,
      cam: { wx: 0, wy: 0, s: 1 },
      camTarget: null,
      follow: true,
      panning: false,
      panStart: null,
      panMoved: false,
      contentMode: "summary",
      missingNodes: [],
      backfillRunning: false,
      backfillSession: null,
    };

    let V_GAP = 200;
    const LEAF_GAP = 310;
    const NODE_DUR = 700;
    const NODE_GAP = 150;
    const EDGE_DUR = 380;
    const EDGE_DELAY = 90;
    const PAN_DRAG_PX = 6;

    /* ── 卡片内容模式（摘要 / 全文）── */
    function refreshCardContent(nid) {
      const c = S.cards.get(nid);
      const n = S.nodes.get(nid);
      if (!c || !n) return;
      const el = c.el.querySelector(".r-content");
      if (el) el.textContent = contentTextFor(n, S.contentMode === "full");
    }
    function applyContentMode(mode) {
      S.contentMode = mode === "full" ? "full" : "summary";
      dom.modeSummary.classList.toggle("is-active", S.contentMode === "summary");
      dom.modeFull.classList.toggle("is-active", S.contentMode === "full");
      if (S.cards) for (const id of S.cards.keys()) refreshCardContent(id);
      scanMissingSummaries();
    }

    /* ── 无摘要节点的补生成（幂等接口，不计问答配额）── */
    function scanMissingSummaries() {
      S.missingNodes = [];
      if (S.contentMode === "summary") {
        for (const n of S.nodes.values()) if (!hasRealSummary(n)) S.missingNodes.push(n.id);
      }
      updateMissingBanner();
    }
    function updateMissingBanner() {
      if (!dom.missing) return;
      const n = S.missingNodes ? S.missingNodes.length : 0;
      dom.missing.hidden = S.contentMode !== "summary" || n === 0;
      if (dom.missing.hidden) return;
      dom.missingCount.textContent = String(n);
      dom.missingGo.textContent = S.backfillRunning
        ? "生成中…"
        : (n > 50 ? "生成一批摘要（≤ 50）" : "生成本树摘要");
      dom.missingGo.disabled = S.backfillRunning;
    }
    async function startBackfill() {
      if (S.backfillRunning || !S.missingNodes.length || !S.sessionId) return;
      // 每批 ≤ 50：避免大棵老树一次触发数百次模型调用，可分批继续
      const BATCH = 50;
      const jobs = S.missingNodes.slice(0, BATCH);
      const total = jobs.length;
      S.backfillRunning = true;
      S.backfillSession = S.sessionId;
      dom.missingGo.disabled = true;
      dom.missingGo.textContent = "生成中 0/" + total;
      let done = 0;
      const tick = () => {
        done++;
        if (S.sessionId === S.backfillSession) {
          dom.missingGo.textContent = "生成中 " + done + "/" + total;
        }
      };
      const CONC = 3;
      let next = 0;
      async function worker() {
        while (next < total) {
          const nid = jobs[next++];
          try {
            const res = await fetch(
              "/api/quiz/sessions/" + encodeURIComponent(S.sessionId)
              + "/nodes/" + encodeURIComponent(nid) + "/summary",
              { method: "POST" }
            );
            if (res.ok) {
              const data = await res.json();
              const node = S.nodes.get(nid);
              if (node && typeof data.summary === "string") {
                if (!node.metadata) node.metadata = {};
                node.metadata.summary = data.summary;
                refreshCardContent(nid);
              }
            }
          } catch (err) { /* 单个失败不中断整体 */ }
          tick();
        }
      }
      await Promise.all([worker(), worker(), worker()]);
      S.backfillRunning = false;
      if (S.sessionId === S.backfillSession) scanMissingSummaries();
    }

    /* ── 数据加载 ── */
    async function loadSessions() {
      try {
        const res = await fetch("/api/quiz/sessions");
        const data = await res.json();
        S.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      } catch (err) {
        console.error("replay: load sessions failed", err);
        S.sessions = [];
      }
      if (!S.sessions.length) {
        dom.empty.hidden = false;
        dom.select.innerHTML = '<option value="">暂无主题</option>';
        return;
      }
      const qs = new URLSearchParams(location.search).get("session");
      const target = S.sessions.find((s) => s.id === qs) || S.sessions[0];
      dom.select.innerHTML = S.sessions.map((s) => {
        const label = String(s.title || s.root_question || "未命名主题").slice(0, 36);
        return '<option value="' + s.id + '">' + escapeHtml(label) + "</option>";
      }).join("");
      dom.select.value = target.id;
      dom.select.addEventListener("change", () => loadSession(dom.select.value));
      await loadSession(target.id);
    }

    async function loadSession(id) {
      resetPlayback();
      const res = await fetch("/api/quiz/sessions/" + encodeURIComponent(id));
      if (!res.ok) return;
      const data = await res.json();
      S.sessionId = id;
      const sess = data.session || {};
      const title = sess.title || sess.root_question || "未命名主题";
      dom.title.textContent = title;
      const total = (data.nodes || []).length;
      dom.subtitle.textContent = "共 " + total + " 个节点" + (sess.persona ? " · " + sess.persona : "");
      dom.counterTotal.textContent = String(total);
      buildWorld(data.nodes || []);
      scanMissingSummaries();
    }

    /* ── 建树 + 布局 ── */
    function buildWorld(rawNodes) {
      if (!rawNodes.length) return;
      rawNodes.sort(chronoCmp);
      const map = new Map();
      for (const n of rawNodes) map.set(n.id, Object.assign({ children: [] }, n));
      const roots = [];
      for (const n of map.values()) {
        if (n.parent_id && map.has(n.parent_id)) map.get(n.parent_id).children.push(n);
        else roots.push(n);
      }
      for (const n of map.values()) n.children.sort(chronoCmp);
      roots.sort(chronoCmp);
      S.nodes = map;
      S.roots = roots;

      // 先生成卡片（隐藏）量出真实高度
      const cards = new Map();
      let idx = 0;
      for (const n of rawNodes) {
        const el = document.createElement("div");
        el.className = "r-node " + (n.role === "user" ? "is-user" : "is-assistant");
        if (!n.parent_id) el.classList.add("is-root");
        el.dataset.branch = branchOf(n);
        const tag = n.parent_id ? (BRANCH_LABEL[branchOf(n)] || "分支") : "起点";
        const roleText = n.role === "user" ? "你的问题" : "回应";
        el.innerHTML =
          '<div class="r-role"><span class="r-dot"></span><span>' + roleText + "</span>" +
          '<span class="r-tag">' + tag + "</span></div>" +
          '<div class="r-content"></div>' +
          '<span class="r-index">' + String(idx + 1).padStart(2, "0") + "</span>";
        el.querySelector(".r-content").textContent = contentTextFor(n, S.contentMode === "full");
        el.title = n.content || "";
        el.dataset.id = n.id;
        // 真实点击经 pointerdown/up 检测（见 endPan）；这里兜底键盘/合成点击
        el.addEventListener("click", () => {
          if (S.panMoved) return;
          showDetail(n);
          if (S.playing) focusNode(n.id);
        });
        dom.nodesLayer.append(el);
        const w = el.offsetWidth, h = el.offsetHeight;
        cards.set(n.id, { el, w, h });
        n._w = w; n._h = h;
        n._n = idx++;
      }
      S.cards = cards;

      // 叶子按中序排 x，内部节点居中于子树两端叶子
      let leafIdx = 0;
      function inOrder(n) {
        if (!n.children.length) {
          n._leafPos = leafIdx++;
          n._firstLeaf = n;
          n._lastLeaf = n;
        } else {
          n.children.forEach(inOrder);
          n._firstLeaf = n.children[0]._firstLeaf;
          n._lastLeaf = n.children[n.children.length - 1]._lastLeaf;
        }
      }
      roots.forEach(inOrder);
      const leaves = [];
      map.forEach((n) => { if (!n.children.length) leaves.push(n); });
      leaves.sort((a, b) => a._leafPos - b._leafPos);
      leaves.forEach((leaf, i) => { leaf._x = i * LEAF_GAP; });
      function centerX(n) {
        if (n.children.length) {
          n.children.forEach(centerX);
          n._x = (n._firstLeaf._x + n._lastLeaf._x) / 2;
        }
      }
      roots.forEach(centerX);
      function maxDepth(n, d) {
        return n.children.length ? Math.max.apply(null, n.children.map((c) => maxDepth(c, d + 1))) : d;
      }
      const deepest = Math.max.apply(null, roots.map((r) => maxDepth(r, 0)));
      const theaterH = dom.theater.getBoundingClientRect().height || 700;
      V_GAP = clamp(theaterH / (deepest + 2), 130, 200);
      function assignY(n, depth) {
        n._y = depth * V_GAP;
        n.children.forEach((c) => assignY(c, depth + 1));
      }
      roots.forEach((r) => assignY(r, 0));

      // 轮廓碰撞消解：相邻子树按每层左右轮廓互推
      const MIN_SEP = 36;
      function contourOf(n, depth, arr) {
        if (!arr[depth]) arr[depth] = [n._x - n._w / 2, n._x + n._w / 2];
        else {
          arr[depth][0] = Math.min(arr[depth][0], n._x - n._w / 2);
          arr[depth][1] = Math.max(arr[depth][1], n._x + n._w / 2);
        }
        n.children.forEach((c) => contourOf(c, depth + 1, arr));
        return arr;
      }
      function shiftSubtree(n, dx) {
        n._x += dx;
        n.children.forEach((c) => shiftSubtree(c, dx));
      }
      function resolveNode(n, recenterSelf) {
        if (!n.children.length) return;
        n.children.forEach((c) => resolveNode(c, true));
        for (let i = 0; i < n.children.length - 1; i++) {
          const L = n.children[i], R = n.children[i + 1];
          const cl = contourOf(L, 0, {});
          const cr = contourOf(R, 0, {});
          let shift = 0;
          const depths = new Set(
            Object.keys(cl).concat(Object.keys(cr)).map(Number)
          );
          depths.forEach((d) => {
            if (cl[d] && cr[d]) {
              shift = Math.max(shift, cl[d][1] - cr[d][0] + MIN_SEP);
            }
          });
          if (shift > 0) shiftSubtree(R, shift);
        }
        if (recenterSelf && n._firstLeaf) {
          n._x = (n._firstLeaf._x + n._lastLeaf._x) / 2;
        }
      }
      resolveNode({ children: roots, _w: 0, _h: 0, _x: 0 }, false);

      // 世界范围
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      map.forEach((n) => {
        const card = cards.get(n.id);
        const hw = card.w / 2, hh = card.h / 2;
        minX = Math.min(minX, n._x - hw); maxX = Math.max(maxX, n._x + hw);
        minY = Math.min(minY, n._y - hh); maxY = Math.max(maxY, n._y + hh);
      });
      const PAD = 140;
      const originX = minX - PAD, originY = minY - PAD;
      S.worldW = (maxX - minX) + PAD * 2;
      S.worldH = (maxY - minY) + PAD * 2;
      dom.world.style.width = S.worldW + "px";
      dom.world.style.height = S.worldH + "px";
      dom.scene.setAttribute("viewBox", "0 0 " + S.worldW + " " + S.worldH);
      dom.scene.setAttribute("width", S.worldW);
      dom.scene.setAttribute("height", S.worldH);
      dom.scene.style.width = S.worldW + "px";
      dom.scene.style.height = S.worldH + "px";

      // 先定位全部卡片（确保父坐标就绪，再画边）
      map.forEach((n) => {
        const card = cards.get(n.id);
        n._sx = n._x - originX;
        n._sy = n._y - originY;
        n._w = card.w;
        n._h = card.h;
        card.el.style.left = (n._sx - card.w / 2) + "px";
        card.el.style.top = (n._sy - card.h / 2) + "px";
      });
      map.forEach((n) => {
        if (n.parent_id && map.has(n.parent_id)) drawEdge(n, map.get(n.parent_id));
      });

      // 生长顺序与时间表（DFS 先序保证「父先于子」）
      const seq = [];
      const seen = new Set();
      function visit(n) {
        if (seen.has(n.id)) return;
        seen.add(n.id);
        seq.push(n);
        n.children.forEach(visit);
      }
      roots.forEach(visit);
      let t = 0;
      seq.forEach((n) => {
        n._start = t;
        n._dur = REDUCED ? 220 : NODE_DUR + (Math.random() * 120 - 60);
        t += n._dur + NODE_GAP;
      });
      S.duration = t;
      S.seq = seq;

      // 初始相机：对准根的落地位置（微距特写）
      const root = seq[0];
      const rc = cards.get(root.id);
      S.camTarget = fitCamera({
        x0: root._sx - rc.w / 2 - 70,
        y0: root._sy - rc.h / 2 - 70,
        x1: root._sx + rc.w / 2 + 70,
        y1: root._sy + rc.h / 2 + 70,
      });
      Object.assign(S.cam, S.camTarget);
      applyCamera();

      hintShow("种子已经落地。按 ▶ 让这棵树的枝长出来");
      bloomNode(root);
    }

    function drawEdge(child, parent) {
      const color = BRANCH_COLOR[branchOf(child)] || "#8fb4ff";
      function makePath(cls, attrs) {
        const p = document.createElementNS(NS, "path");
        p.setAttribute("class", cls);
        p.setAttribute("stroke", color);
        p.setAttribute("fill", "none");
        if (attrs) Object.keys(attrs).forEach((k) => p.setAttribute(k, attrs[k]));
        return p;
      }
      const glow = makePath("r-edge-glow", { "stroke-width": 7, "stroke-opacity": 0.16 });
      const main = makePath("r-edge", {
        "stroke-width": 2, "pathLength": 1,
        "stroke-dasharray": "1 1", "stroke-dashoffset": 1,
      });
      const spark = document.createElementNS(NS, "circle");
      spark.setAttribute("class", "r-spark");
      spark.setAttribute("r", 3.2);
      spark.setAttribute("fill", color);
      spark.style.filter = "drop-shadow(0 0 6px " + color + ")";
      const g = document.createElementNS(NS, "g");
      g.append(glow, main, spark);
      dom.scene.append(g);

      const px = parent._sx, py = parent._sy + parent._h / 2;
      const cx = child._sx, cy = child._sy - child._h / 2;
      const d = "M " + px + " " + py + " C " + px + " " + (py + cy) / 2 + ", " +
        cx + " " + (py + cy) / 2 + ", " + cx + " " + cy;
      main.setAttribute("d", d);
      glow.setAttribute("d", d);
      spark.setAttribute("cx", px);
      spark.setAttribute("cy", py);
      const len = main.getTotalLength();
      S.edges.set(child.id, { main, glow, spark, len, color });
    }

    function hintShow(text) {
      dom.hint.innerHTML = "<p>" + text + "</p>";
      dom.hint.classList.remove("is-hidden");
      dom.hint.classList.add("is-visible");
    }
    function hintHide() {
      dom.hint.classList.remove("is-visible");
      dom.hint.classList.add("is-hidden");
    }

    /* ── 生长动画 ── */
    function bloomNode(node) {
      if (S.bloomed.has(node.id)) return;
      S.bloomed.add(node.id);
      S.lastBloomId = node.id;
      const card = S.cards.get(node.id);
      card.el.classList.add("is-appearing");
      // 有父节点：描边 + 火花
      const edge = S.edges.get(node.id);
      if (edge) {
        edge.main.classList.add("is-drawn");
        edge.glow.classList.add("is-drawn");
        edge.spark.style.opacity = "1";
        edge._start = S.clock + EDGE_DELAY;
        edge._progress = -1;
      }
      // 镜头跟随生长前线（用户手动平移/缩放后暂停跟随，可点 ◎ 重新跟随）
      if (S.follow) {
        const fc = frontierCam();
        S.camTarget = fc || fitCamera(grownBBox());
      }
      // 计数
      dom.counterNow.textContent = String(S.bloomed.size);
      if (S.bloomed.size === S.seq.length) finishReplay();
    }

    // 框住「最近开花节点 + 父节点 + 邻近」，保持可读缩放，
    // 而不是随整树变大一直拉远到看不清。
    function frontierCam() {
      const n = S.nodes.get(S.lastBloomId);
      if (!n) return null;
      const pts = [n];
      const parent = n.parent_id ? S.nodes.get(n.parent_id) : null;
      if (parent) pts.push(parent);
      const recent = Array.from(S.bloomed).slice(-2);
      recent.forEach((id) => {
        const nd = S.nodes.get(id);
        if (nd && nd !== n && nd !== parent) pts.push(nd);
      });
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      pts.forEach((nd) => {
        const hw = nd._w / 2, hh = nd._h / 2;
        x0 = Math.min(x0, nd._sx - hw); x1 = Math.max(x1, nd._sx + hw);
        y0 = Math.min(y0, nd._sy - hh); y1 = Math.max(y1, nd._sy + hh);
      });
      const rect = dom.theater.getBoundingClientRect();
      const pad = 250;
      const w = (x1 - x0) + pad * 2;
      const h = (y1 - y0) + pad * 2;
      let s = Math.min(rect.width / w, rect.height / h);
      s = clamp(s, 0.45, 1.9);
      return { wx: (x0 + x1) / 2, wy: (y0 + y1) / 2, s };
    }

    function advance(now) {
      for (const n of S.seq) {
        if (S.bloomed.has(n.id)) continue;
        if (n._start <= now) bloomNode(n);
      }
      // 火花 / 描边进度
      S.edges.forEach((edge) => {
        if (edge._start === undefined || edge._progress === 1) return;
        const p = clamp((now - edge._start) / EDGE_DUR, 0, 1);
        edge._progress = p;
        const e = easeInOut(p);
        edge.main.setAttribute("stroke-dashoffset", (1 - e).toFixed(4));
        const pt = edge.main.getPointAtLength(edge.len * e);
        edge.spark.setAttribute("cx", pt.x);
        edge.spark.setAttribute("cy", pt.y);
        if (p >= 1) {
          edge.spark.style.opacity = "0";
          edge.glow.setAttribute("stroke-opacity", "0.1");
        }
      });
    }

    function grownBBox() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      S.bloomed.forEach((id) => {
        const n = S.nodes.get(id);
        const hw = n._w / 2, hh = n._h / 2;
        x0 = Math.min(x0, n._sx - hw); x1 = Math.max(x1, n._sx + hw);
        y0 = Math.min(y0, n._sy - hh); y1 = Math.max(y1, n._sy + hh);
      });
      if (x0 === Infinity) x0 = y0 = 0, x1 = y1 = 1;
      return { x0, y0, x1, y1 };
    }

    function finishReplay() {
      // 全部长成后：镜头缓缓拉到全貌（fitCamera 自带呼吸空间），
      // 随后可滚轮推近任意角落；同时露出「回到这棵树继续学」。
      S.follow = false;
      syncFollowBtn();
      S.camTarget = fitCamera(grownBBox());
      hintHide();
      if (dom.continueBtn) dom.continueBtn.hidden = false;
    }

    /* ── 相机 ── */
    function fitCamera(bbox, extra) {
      const rect = dom.theater.getBoundingClientRect();
      const vw = rect.width, vh = rect.height;
      const pad = 90;
      const w = (bbox.x1 - bbox.x0) + pad * 2;
      const h = (bbox.y1 - bbox.y0) + pad * 2;
      let s = Math.min(vw / w, vh / h) * (extra || 1);
      s = clamp(s, 0.18, 2.4);
      return { wx: (bbox.x0 + bbox.x1) / 2, wy: (bbox.y0 + bbox.y1) / 2, s };
    }

    function applyCamera() {
      const rect = dom.theater.getBoundingClientRect();
      const vw = rect.width, vh = rect.height;
      const tx = vw / 2 - S.cam.wx * S.cam.s;
      const ty = vh / 2 - S.cam.wy * S.cam.s;
      dom.world.style.transform =
        "translate3d(" + tx.toFixed(2) + "px," + ty.toFixed(2) + "px,0) scale(" + S.cam.s.toFixed(4) + ")";
    }

    function easeCamera() {
      if (!S.camTarget) return;
      const k = REDUCED ? 1 : 0.09;
      S.cam.wx += (S.camTarget.wx - S.cam.wx) * k;
      S.cam.wy += (S.camTarget.wy - S.cam.wy) * k;
      S.cam.s += (S.camTarget.s - S.cam.s) * k;
      if (Math.abs(S.camTarget.s - S.cam.s) < 0.001 &&
          Math.abs(S.camTarget.wx - S.cam.wx) < 0.5 &&
          Math.abs(S.camTarget.wy - S.cam.wy) < 0.5) {
        Object.assign(S.cam, S.camTarget);
        S.camTarget = null;
      }
      applyCamera();
    }

    function focusNode(id) {
      if (!S.playing) return;
      const n = S.nodes.get(id);
      if (!n) return;
      const bbox = grownBBox();
      S.camTarget = fitCamera(bbox);
      // 让被点击的节点靠近镜头中央、略微放大
      S.camTarget.wx = n._sx;
      S.camTarget.wy = n._sy - 20;
      S.camTarget.s = Math.max(S.camTarget.s * 1.25, 0.9);
    }

    /* ── 主循环 ── */
    function frame(ts) {
      if (S.playing) {
        const dt = S.lastTs ? (ts - S.lastTs) : 0;
        S.lastTs = ts;
        S.clock += dt * S.speed;
        if (S.clock >= S.duration) {
          // 自然播完：停钟但不要冻结动画——
          // 若此时加了 is-paused，最后一颗节点刚被 advance 开花就会停在第一帧
          // （这正是「最后一个节点总是渲染不出来」的根源）。
          S.clock = S.duration;
          S.playing = false;
          S.pausedByUser = false;
          syncPlayIcon(false);
        }
      } else {
        S.lastTs = ts;
      }
      advance(S.clock);
      easeCamera();
      updateProgress();
      S.raf = requestAnimationFrame(frame);
    }

    function updateProgress() {
      const p = S.duration ? clamp(S.clock / S.duration, 0, 1) : 0;
      dom.progress.style.width = (p * 100).toFixed(2) + "%";
      dom.knob.style.left = (p * 100).toFixed(2) + "%";
    }

    /* ── 控制 ── */
    function syncPlayIcon(on) {
      dom.playIcon.hidden = on;
      dom.pauseIcon.hidden = !on;
      dom.play.setAttribute("aria-label", on ? "暂停" : "播放");
    }
    function syncFollowBtn() {
      if (dom.follow) dom.follow.classList.toggle("is-active", S.follow);
    }
    function setPlaying(on) {
      S.playing = on;
      S.pausedByUser = !on;
      syncPlayIcon(on);
      // 仅「用户主动暂停」才冻结 CSS 动画；自然播完不冻结
      dom.world.classList.toggle("is-paused", !on && S.pausedByUser);
      if (on) {
        hintHide();
        if (!S.bloomed.size && S.seq.length) bloomNode(S.seq[0]);
      }
    }

    function resetPlayback() {
      // 切换主题：清空整棵树的 DOM 与状态（下一条 buildWorld 会重建）
      S.missingNodes = [];
      S.backfillRunning = false;
      S.backfillSession = null;
      if (dom.missing) dom.missing.hidden = true;
      resetTreeView();
      S.edges.clear();
      S.cards.clear();
      S.nodes.clear();
      S.seq = [];
      S.duration = 0;
      dom.nodesLayer.innerHTML = "";
      dom.scene.innerHTML = "";
    }

    function resetTreeView() {
      // 同一棵树重播：保留卡片与边的 DOM，只把动画状态拨回种子时刻
      S.playing = false;
      S.pausedByUser = false;
      S.clock = 0;
      S.lastTs = 0;
      S.bloomed.clear();
      S.lastBloomId = null;
      S.camTarget = null;
      dom.progress.style.width = "0%";
      dom.knob.style.left = "0%";
      dom.counterNow.textContent = "0";
      dom.knob.classList.remove("is-idle");
      dom.world.classList.remove("is-paused");
      syncPlayIcon(false);
      if (dom.continueBtn) dom.continueBtn.hidden = true;
      // 卡片回到隐藏态、边回到未画态
      S.cards.forEach((card) => {
        card.el.classList.remove("is-appearing", "is-settled");
      });
      S.edges.forEach((edge) => {
        edge.main.classList.remove("is-drawn");
        edge.glow.classList.remove("is-drawn");
        edge.spark.style.opacity = "0";
        edge.main.setAttribute("stroke-dashoffset", "1");
        edge._start = undefined;
        edge._progress = -1;
      });
    }

    function replay() {
      // 重新从种子开始：不重建 DOM，直接重播动画
      resetTreeView();
      if (S.seq.length) {
        S.follow = true;
        syncFollowBtn();
        bloomNode(S.seq[0]);
        setPlaying(true);
      }
    }

    function seekTo(p) {
      const t = clamp(p, 0, 1) * S.duration;
      // 重置所有节点，再按新时钟快照状态
      S.bloomed.clear();
      S.nodes.forEach((n) => {
        const card = S.cards.get(n.id);
        card.el.classList.remove("is-appearing", "is-settled");
      });
      S.edges.forEach((edge) => {
        edge.main.classList.remove("is-drawn");
        edge.glow.classList.remove("is-drawn");
        edge.spark.style.opacity = "0";
        edge.main.setAttribute("stroke-dashoffset", "1");
        edge._start = undefined;
        edge._progress = -1;
      });
      S.clock = t;
      S.follow = false;
      syncFollowBtn();
      if (dom.continueBtn) dom.continueBtn.hidden = true;
      // 先描边（无动画），再让节点直接落地
      S.seq.forEach((n) => {
        if (n._start > t) return;
        S.bloomed.add(n.id);
        S.lastBloomId = n.id;
        const card = S.cards.get(n.id);
        card.el.classList.add("is-settled");
        const edge = S.edges.get(n.id);
        if (edge) {
          edge.main.classList.add("is-drawn");
          edge.glow.classList.add("is-drawn");
          edge.main.setAttribute("stroke-dashoffset", "0");
        }
      });
      dom.counterNow.textContent = String(S.bloomed.size);
      const bbox = grownBBox();
      Object.assign(S.cam, fitCamera(bbox));
      S.camTarget = null;
      applyCamera();
      updateProgress();
    }

    function onPlayClick() {
      if (S.playing) {
        setPlaying(false);
      } else {
        if (!S.seq.length) return;
        if (S.clock >= S.duration) {
          // 播完了：重放
          replay();
          return;
        }
        setPlaying(true);
      }
    }

    /* ── 详情弹卡 ── */
    function showDetail(n) {
      if (!dom.detail) return;
      dom.detailRole.textContent = n.role === "user" ? "你的问题" : "回应";
      dom.detailTag.textContent = n.parent_id ? (BRANCH_LABEL[branchOf(n)] || "分支") : "起点";
      dom.detailBody.textContent = n.content || "";
      dom.detail.hidden = false;
    }
    function hideDetail() {
      if (dom.detail) dom.detail.hidden = true;
    }

    /* ── 事件：控制条 ── */
    dom.play.addEventListener("click", onPlayClick);
    dom.restart.addEventListener("click", replay);
    dom.follow.addEventListener("click", () => {
      S.follow = true;
      syncFollowBtn();
      const n = S.lastBloomId ? S.nodes.get(S.lastBloomId) : null;
      if (n) {
        const fc = frontierCam();
        if (fc) S.camTarget = fc;
      }
    });
    dom.speed.addEventListener("change", () => { S.speed = parseFloat(dom.speed.value) || 1; });
    dom.modeSummary.addEventListener("click", () => applyContentMode("summary"));
    dom.modeFull.addEventListener("click", () => applyContentMode("full"));
    dom.missingGo.addEventListener("click", startBackfill);

    dom.timeline.addEventListener("click", (e) => {
      const rect = dom.timeline.getBoundingClientRect();
      const p = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      seekTo(p);
    });
    dom.timeline.addEventListener("keydown", (e) => {
      const cur = S.duration ? S.clock / S.duration : 0;
      if (e.key === "ArrowRight") { seekTo(cur + 0.1); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { seekTo(cur - 0.1); e.preventDefault(); }
      else if (e.key === " " || e.key === "Enter") { e.preventDefault(); onPlayClick(); }
    });

    function onKeyDown(e) {
      if (e.key === "Escape") { hideDetail(); return; }
      if (e.key === " " && e.target !== dom.select && e.target !== dom.speed) {
        if (!dom.timeline.matches(":focus")) { e.preventDefault(); onPlayClick(); }
      }
    }
    window.addEventListener("keydown", onKeyDown);

    /* ── 事件：画布手势（拖动平移，不选中文字；滚轮缩放） ── */
    dom.detail.addEventListener("pointerdown", (e) => e.stopPropagation());
    dom.detailClose.addEventListener("click", hideDetail);
    dom.theater.addEventListener("pointerdown", (e) => {
      if (dom.detail && !dom.detail.hidden) hideDetail();
      e.preventDefault();
      S.panning = true;
      S.panMoved = false;
      S.panStart = { x: e.clientX, y: e.clientY, wx: S.cam.wx, wy: S.cam.wy };
      dom.theater.classList.add("is-panning");
      dom.theater.setPointerCapture(e.pointerId);
    });
    dom.theater.addEventListener("pointermove", (e) => {
      if (!S.panning) return;
      const dx = e.clientX - S.panStart.x;
      const dy = e.clientY - S.panStart.y;
      if (Math.abs(dx) > PAN_DRAG_PX || Math.abs(dy) > PAN_DRAG_PX) S.panMoved = true;
      S.cam.wx = S.panStart.wx - dx / S.cam.s;
      S.cam.wy = S.panStart.wy - dy / S.cam.s;
      if (S.follow) { S.follow = false; syncFollowBtn(); }
      S.camTarget = null;
      applyCamera();
    });
    const endPan = (e) => {
      if (!S.panning) return;
      S.panning = false;
      dom.theater.classList.remove("is-panning");
      // pointer capture 会把 click 目标重定向到共同祖先（theater），卡片收不到；
      // 这里在 pointerup 用 elementFromPoint 直接命中检测：未拖动 = 单击卡片 → 弹详情。
      if (!e || e.clientX === undefined || S.panMoved) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      // 剧场内的交互按钮（补生成）同样被 pointer capture 重定向，这里手动派发
      const missBtn = el && el.closest ? el.closest("#replay-missing-go") : null;
      if (missBtn) { startBackfill(); return; }
      const cardEl = el && el.closest ? el.closest(".r-node") : null;
      if (cardEl && cardEl.dataset && cardEl.dataset.id) {
        const n = S.nodes.get(cardEl.dataset.id);
        if (n) {
          showDetail(n);
          if (S.playing) focusNode(n.id);
        }
      }
    };
    dom.theater.addEventListener("pointerup", endPan);
    dom.theater.addEventListener("pointercancel", endPan);
    dom.theater.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = dom.theater.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const vw = rect.width, vh = rect.height;
      const wx = S.cam.wx + (mx - vw / 2) / S.cam.s;
      const wy = S.cam.wy + (my - vh / 2) / S.cam.s;
      const ns = clamp(S.cam.s * (e.deltaY < 0 ? 1.16 : 1 / 1.16), 0.18, 3.6);
      S.cam.wx = wx - (mx - vw / 2) / ns;
      S.cam.wy = wy - (my - vh / 2) / ns;
      S.cam.s = ns;
      if (S.follow) { S.follow = false; syncFollowBtn(); }
      S.camTarget = null;
      applyCamera();
    }, { passive: false });

    function onResize() {
      if (S.seq.length) {
        const bbox = grownBBox();
        Object.assign(S.cam, fitCamera(bbox));
        S.camTarget = null;
        applyCamera();
      }
    }
    window.addEventListener("resize", onResize);

    /* ── 退出 / 继续 ── */
    dom.close.addEventListener("click", () => exit());
    dom.continueBtn.addEventListener("click", () => cont(S.sessionId));

    /* ── 悬浮尘埃 ── */
    function buildAmbient() {
      if (REDUCED) return;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 42; i++) {
        const p = document.createElement("i");
        const size = 1.5 + Math.random() * 3;
        const dur = 11 + Math.random() * 16;
        const delay = Math.random() * -dur;
        const driftX = (Math.random() - 0.5) * 160;
        p.style.width = size + "px";
        p.style.height = size + "px";
        p.style.left = Math.random() * 100 + "%";
        p.style.top = 50 + Math.random() * 60 + "%";
        p.style.setProperty("--r-drift", dur + "s");
        p.style.setProperty("--r-delay", delay + "s");
        p.style.setProperty("--r-op", (0.16 + Math.random() * 0.4).toFixed(2));
        p.style.setProperty("--r-drift-x", driftX.toFixed(0) + "px");
        frag.append(p);
      }
      dom.ambient.append(frag);
    }

    /* ── 销毁：画布内嵌模式退出时调用 ── */
    function destroy() {
      cancelAnimationFrame(S.raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      container.innerHTML = "";
    }

    /* ── 启动 ── */
    buildAmbient();
    syncFollowBtn();
    if (opts.sessionId) loadSession(opts.sessionId);
    else loadSessions();
    S.raf = requestAnimationFrame(frame);

    return { destroy, getSessionId: () => S.sessionId };
  }

  window.createReplayTheater = createReplayTheater;

  // 独立页 /replay：页面上有 #replay-app 就自动搭建剧场（带主题选择）。
  // 画布内嵌模式（tree.html）不触发——由 tree.js 调 createReplayTheater 挂到 #replay-overlay。
  const appEl = document.getElementById("replay-app");
  if (appEl) {
    createReplayTheater(appEl, {
      picker: true,
      onExit: () => { location.href = "/"; },
      onContinue: (id) => { location.href = id ? "/?session=" + encodeURIComponent(id) : "/"; },
    });
  }
})();
