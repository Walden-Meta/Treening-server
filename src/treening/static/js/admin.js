(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);

  const usersError = $("#users-error");
  const settingsError = $("#settings-error");
  const regToggle = $("#open-reg-toggle");
  const regState = $("#open-reg-state");

  function showError(el, msg) { if (el) el.textContent = msg || ""; }

  async function api(path, method = "GET", body) {
    const res = await fetch("/api/admin" + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function renderUsers() {
    const data = await api("/users");
    $("#user-count").textContent = String(data.users.length);
    const onlineCount = data.users.filter((u) => u.online).length;
    $("#online-count").textContent = `（在线 ${onlineCount}）`;
    const tbody = $("#user-table-body");
    tbody.innerHTML = data.users.map((u) => {
      const roleBadge = u.role === "admin"
        ? '<span class="role-badge role-admin">管理员</span>'
        : '<span class="role-badge role-user">用户</span>';
      let status;
      if (!u.is_active) {
        status = '<span class="off-badge"><i class="status-dot dot-disabled"></i>已禁用</span>';
      } else if (u.online) {
        status = '<span style="color:#16a34a"><i class="status-dot dot-online"></i>在线</span>';
      } else {
        status = '<span style="color:var(--quiz-faint)"><i class="status-dot dot-offline"></i>离线</span>';
      }
      const self = u.id === window.__selfId;
      const btnToggle = u.is_active
        ? `<button class="mini-btn danger" data-act="disable" data-id="${u.id}">禁用</button>`
        : `<button class="mini-btn" data-act="enable" data-id="${u.id}">启用</button>`;
      const btnRole = u.role === "admin"
        ? `<button class="mini-btn" data-act="demote" data-id="${u.id}"${self ? " disabled" : ""}>降为普通</button>`
        : `<button class="mini-btn" data-act="promote" data-id="${u.id}">设为管理员</button>`;
      const btnReset = `<button class="mini-btn" data-act="resetpw" data-id="${u.id}">改密</button>`;
      const btnEmail = `<button class="mini-btn" data-act="setemail" data-id="${u.id}" data-email="${esc(u.email || "")}">邮箱</button>`;
      const btnQuota = `<button class="mini-btn" data-act="quota" data-id="${u.id}" data-quota="${u.quota_limit === null || u.quota_limit === undefined ? "" : u.quota_limit}" data-role="${u.role}">配额</button>`;
      const btnDelete = self
        ? ""
        : `<button class="mini-btn danger" data-act="delete" data-id="${u.id}">删除</button>`;
      const seenCell = `<div>${fmtTime(u.last_seen_at)}</div><div class="ip-sub">${esc(u.last_seen_ip || "—")}</div>`;
      const loginCell = `<div>${fmtTime(u.last_login_at)}</div><div class="ip-sub">${esc(u.last_login_ip || "—")}</div>`;
      let quotaCell;
      if (u.quota_max === null) {
        quotaCell = '<span class="quota-unlimited">∞ 不限</span>';
      } else if (u.quota_limit === null || u.quota_limit === undefined) {
        quotaCell = `<span class="quota-default">${u.quota_used} / ${u.quota_max}（默认）</span>`;
      } else {
        quotaCell = `<span>${u.quota_used} / ${u.quota_max}</span>`;
      }
      return `<tr data-id="${u.id}">
        <td>${esc(u.username)}${self ? " <span class='off-badge'>(我)</span>" : ""}</td>
        <td>${roleBadge}</td>
        <td>${status}</td>
        <td class="email-cell" title="${esc(u.email || "")}">${u.email ? esc(u.email) : "—"}</td>
        <td>${u.session_count}</td>
        <td>${u.node_count}</td>
        <td class="quota-cell">${quotaCell}</td>
        <td>${seenCell}</td>
        <td>${loginCell}</td>
        <td style="white-space:nowrap">${btnReset} ${btnEmail} ${btnQuota} ${btnRole} ${btnToggle} ${btnDelete}</td>
      </tr>`;
    }).join("");
  }

  function bindActions() {
    $("#user-table-body").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn || btn.disabled) return;
      const { act, id } = btn.dataset;
      const username = btn.closest("tr").querySelector("td").textContent.trim();
      try {
        if (act === "resetpw") {
          const pw = prompt(`为 ${username} 设置新密码（8-64 位）：`);
          if (pw === null) return;
          if (pw.length < 8 || pw.length > 64) { alert("密码需为 8-64 位"); return; }
          await api(`/users/${id}`, "PATCH", { password: pw });
        } else if (act === "disable" || act === "enable") {
          if (act === "disable" && !confirm(`确定禁用 ${username}？其会话将立即失效。`)) return;
          await api(`/users/${id}`, "PATCH", { is_active: act === "enable" });
        } else if (act === "promote" || act === "demote") {
          if (act === "demote" && !confirm(`确定将 ${username} 降为普通用户？`)) return;
          await api(`/users/${id}`, "PATCH", { role: act === "promote" ? "admin" : "user" });
        } else if (act === "setemail") {
          const current = btn.dataset.email || "";
          const email = prompt(
            `为 ${username} 设置绑定邮箱（用于忘记密码找回，留空解除）：`,
            current
          );
          if (email === null) return;
          const value = email.trim().toLowerCase();
          if (value && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(value)) {
            alert("邮箱格式不正确"); return;
          }
          await api(`/users/${id}`, "PATCH", { email: value });
        } else if (act === "quota") {
          const isAdmin = btn.dataset.role === "admin";
          if (isAdmin) { alert("管理员不限额，无需设置配额。"); return; }
          const cur = btn.dataset.quota || "";
          const hint = cur === "" ? "全局默认" : (cur === "0" ? "不限额" : `每日 ${cur} 次`);
          const input = prompt(
            `为 ${username} 设置每日提问配额：\n留空 = 全局默认，0 = 不限额，数字 = 每日 N 次\n当前：${hint}`,
            cur
          );
          if (input === null) return;
          const val = input.trim();
          if (val === "") {
            await api(`/users/${id}`, "PATCH", { quota_limit: null });
          } else {
            const n = Number(val);
            if (!Number.isInteger(n) || n < 0 || n > 100000) {
              alert("配额需为 0、正整数，或留空（默认）"); return;
            }
            await api(`/users/${id}`, "PATCH", { quota_limit: n });
          }
        } else if (act === "delete") {
          if (!confirm(`确定删除用户 ${username}？其全部学习数据将被清空，不可恢复。`)) return;
          await api(`/users/${id}`, "DELETE");
        }
        showError(usersError, "");
        await renderUsers();
      } catch (err) {
        showError(usersError, err.message);
      }
    });
  }

  async function loadSettings() {
    const d = await api("/settings");
    regToggle.checked = d.open_registration;
    regState.textContent = d.open_registration ? "已开启，登录页显示注册入口" : "已关闭，仅管理员可添加用户";
  }

  function bindSettings() {
    regToggle.addEventListener("change", async () => {
      regToggle.disabled = true;
      showError(settingsError, "");
      try {
        await api("/settings", "POST", { open_registration: regToggle.checked });
        await loadSettings();
      } catch (err) {
        showError(settingsError, err.message);
        regToggle.checked = !regToggle.checked;
      } finally {
        regToggle.disabled = false;
      }
    });
  }

  function bindCreate() {
    $("#create-user-btn").addEventListener("click", async () => {
      const username = $("#new-username").value.trim();
      const password = $("#new-password").value;
      const password2 = $("#new-password2").value;
      const email = $("#new-email").value.trim().toLowerCase();
      const role = $("#new-role").value;
      showError(usersError, "");
      if (!username || !password) { showError(usersError, "请填写用户名和密码"); return; }
      if (password.length < 8 || password.length > 64) { showError(usersError, "密码需为 8-64 位"); return; }
      if (password !== password2) { showError(usersError, "两次输入的密码不一致"); return; }
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) { showError(usersError, "邮箱格式不正确"); return; }
      try {
        await api("/users", "POST", { username, password, role, email });
        $("#new-username").value = "";
        $("#new-password").value = "";
        $("#new-password2").value = "";
        $("#new-email").value = "";
        await renderUsers();
      } catch (err) {
        showError(usersError, err.message);
      }
    });
  }

  // ── SMTP 发信配置 ──
  function loadSmtp() {
    return api("/smtp").then((d) => {
      $("#smtp-host").value = d.host || "";
      $("#smtp-port").value = d.port || 465;
      $("#smtp-ssl").checked = d.use_ssl !== false;
      if (d.username) {
        $("#smtp-username").value = d.username;
        $("#smtp-username").placeholder = d.username_hint || "";
      }
      $("#smtp-password").placeholder = d.password === "已保存" ? "已保存，留空保持不变" : "授权码（QQ 需在邮箱设置中生成）";
      $("#smtp-from").value = d.from_name || "Treening";
    });
  }

  function bindSmtp() {
    const errEl = $("#smtp-error");
    const saveBtn = $("#smtp-save-btn");
    const testBtn = $("#smtp-test-btn");

    saveBtn.addEventListener("click", async () => {
      errEl.textContent = "";
      saveBtn.disabled = true; saveBtn.textContent = "保存中…";
      try {
        const d = await api("/smtp", "POST", {
          host: $("#smtp-host").value.trim(),
          port: $("#smtp-port").value,
          use_ssl: $("#smtp-ssl").checked,
          username: $("#smtp-username").value.trim(),
          password: $("#smtp-password").value,
          from_name: $("#smtp-from").value.trim(),
        });
        $("#smtp-password").value = "";
        errEl.textContent = d.ok ? "✓ 已保存" : (d.error || "保存失败");
        await loadSmtp();
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        saveBtn.disabled = false; saveBtn.textContent = "保存配置";
      }
    });

    testBtn.addEventListener("click", async () => {
      const to = $("#smtp-test-email").value.trim();
      errEl.textContent = "";
      if (!to) { errEl.textContent = "请填写测试收件邮箱"; return; }
      testBtn.disabled = true; testBtn.textContent = "测试中…";
      try {
        const d = await api("/smtp/test", "POST", {
          host: $("#smtp-host").value.trim(),
          port: $("#smtp-port").value,
          use_ssl: $("#smtp-ssl").checked,
          username: $("#smtp-username").value.trim(),
          password: $("#smtp-password").value || undefined,
          to_email: to,
        });
        errEl.textContent = d.message || (d.ok ? "✓ 已发送" : "测试失败");
        if (d.ok) errEl.style.color = "inherit";
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        testBtn.disabled = false; testBtn.textContent = "发送测试邮件";
      }
    });
  }

  async function init() {
    try {
      const me = await fetch("/api/auth/me").then((r) => r.json());
      if (!me?.authenticated) { location.href = "/login"; return; }
      if (me.user.role !== "admin") { location.href = "/"; return; }
      window.__selfId = me.user.id;
      await loadSettings();
      await renderUsers();
      bindSettings();
      bindCreate();
      bindActions();
      bindSmtp();
      await loadSmtp();
      // 每 30 秒自动刷新用户列表，保持在线/离线状态新鲜
      setInterval(() => {
        renderUsers().catch(() => {});
      }, 30000);
    } catch (_) {
      // 网络或权限问题：回登录页重试
      location.href = "/login";
    }
  }

  init();
})();
