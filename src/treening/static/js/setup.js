(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const form = $("#setup-form");
  const keyInput = $("#setup-api-key");
  const urlInput = $("#setup-api-url");
  const modelInput = $("#setup-model");
  const errorEl = $("#setup-error");
  const testBtn = $("#setup-test");
  const keyHint = $("#setup-key-hint");
  const backLink = $("#setup-back");
  const skipLink = $("#setup-skip");
  const personaInput = $("#setup-persona");
  const personaError = $("#persona-error");
  const personaSaveBtn = $("#setup-persona-save");
  const labelInputs = {
    check: $("#label-check"),
    followup: $("#label-followup"),
    custom: $("#label-custom"),
  };
  const branchLabelsError = $("#branch-labels-error");
  const branchLabelsSaveBtn = $("#setup-branch-labels-save");
  const deconBoxes = Array.from(document.querySelectorAll('input[type="checkbox"][id^="decon-"]'));
  const deconError = $("#deconstruction-error");
  const deconSaveBtn = $("#setup-deconstruction-save");
  const layoutPrefsInputs = {
    qa_gap: $("#layout-qa-gap"),
    branch_gap: $("#layout-branch-gap"),
    node_width: $("#layout-node-width"),
    node_height: $("#layout-node-height"),
  };
  const layoutPrefsError = $("#layout-prefs-error");
  const layoutPrefsSaveBtn = $("#setup-layout-prefs-save");

  let hasExistingKey = false;

  // 预填当前配置（Key 只给掩码提示，不回传明文）
  fetch("/api/setup")
    .then((r) => r.json())
    .then((d) => {
      if (d.api_url) urlInput.value = d.api_url;
      if (d.model) modelInput.value = d.model;
      hasExistingKey = Boolean(d.configured);
      if (typeof d.persona === "string") personaInput.value = d.persona;
      if (d.branch_labels && typeof d.branch_labels === "object") {
        for (const slot of ["check", "followup", "custom"]) {
          const el = labelInputs[slot];
          if (el && typeof d.branch_labels[slot] === "string") el.value = d.branch_labels[slot];
        }
      }
      if (Array.isArray(d.deconstruction_enabled)) {
        for (const box of deconBoxes) box.checked = d.deconstruction_enabled.includes(box.value);
      }
      if (d.layout_prefs && typeof d.layout_prefs === "object") {
        for (const key of Object.keys(layoutPrefsInputs)) {
          const el = layoutPrefsInputs[key];
          if (el && typeof d.layout_prefs[key] === "number") el.value = d.layout_prefs[key];
        }
      }
      // 绑定邮箱回填 + 邮件服务状态提示
      const emailInput = $("#setup-email");
      if (emailInput && typeof d.email === "string") emailInput.value = d.email;
      const mailStatus = $("#email-mail-status");
      if (mailStatus) {
        mailStatus.textContent = d.smtp_configured
          ? ""
          : "（管理员尚未配置邮件服务，忘记密码功能暂不可用）";
      }
      if (hasExistingKey) {
        keyHint.hidden = false;
        keyHint.textContent = d.key_hint ? "已配置 " + d.key_hint + "，留空则保持不变" : "已配置，留空则保持不变";
        keyInput.placeholder = "留空保持当前 Key";
        backLink.hidden = false;
        skipLink.hidden = true;
      }
      // 首启：无任何用户时只显示创建管理员账号
      const hasUsers = Boolean(d.has_users);
      const isAdmin = Boolean(d.is_admin);
      const registerSection = $("#setup-register");
      if (registerSection) registerSection.hidden = hasUsers;
      if (!hasUsers) {
        for (const el of document.querySelectorAll("#setup-global, .persona-editor, #setup-nonadmin-note")) {
          el.hidden = true;
        }
      } else if (!isAdmin) {
        // 普通用户：隐藏全局模型配置区，保留个性化配置
        $("#setup-global").hidden = true;
        const note = $("#setup-nonadmin-note");
        if (note) note.hidden = false;
        backLink.hidden = false;
        skipLink.hidden = true;
      }
    })
    .catch(() => {});

  function showError(msg) { errorEl.textContent = msg || ""; }

  testBtn.addEventListener("click", async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey && !hasExistingKey) { showError("请先填写 API Key"); keyInput.focus(); return; }
    testBtn.disabled = true; testBtn.textContent = "测试中…"; showError("");
    try {
      const res = await fetch("/api/setup/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          api_url: urlInput.value.trim(),
          model: modelInput.value.trim(),
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { showError(d.error || "测试失败"); return; }
      showError("✓ 连接成功");
    } catch (_) {
      showError("无法连接服务，请重试");
    } finally {
      testBtn.disabled = false; testBtn.textContent = "测试连接";
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const apiKey = keyInput.value.trim();
    if (!apiKey && !hasExistingKey) { showError("API Key 不能为空"); keyInput.focus(); return; }
    try {
      const res = await fetch("/api/setup/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          api_url: urlInput.value.trim(),
          model: modelInput.value.trim(),
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { showError(d.error || "保存失败"); return; }
      location.href = "/";
    } catch (_) {
      showError("保存失败，请重试");
    }
  });

  personaSaveBtn.addEventListener("click", async () => {
    const persona = personaInput.value.trim();
    personaSaveBtn.disabled = true;
    personaSaveBtn.textContent = "保存中…";
    personaError.textContent = "";
    try {
      const res = await fetch("/api/setup/persona", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { personaError.textContent = d.error || "保存失败"; return; }
      personaError.textContent = "✓ 人设已保存，立即生效";
    } catch (_) {
      personaError.textContent = "保存失败，请重试";
    } finally {
      personaSaveBtn.disabled = false;
      personaSaveBtn.textContent = "保存人设";
    }
  });

  branchLabelsSaveBtn.addEventListener("click", async () => {
    const branch_labels = {
      check: labelInputs.check.value.trim(),
      followup: labelInputs.followup.value.trim(),
      custom: labelInputs.custom.value.trim(),
    };
    branchLabelsSaveBtn.disabled = true;
    branchLabelsSaveBtn.textContent = "保存中…";
    branchLabelsError.textContent = "";
    try {
      const res = await fetch("/api/setup/branch-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_labels }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { branchLabelsError.textContent = d.error || "保存失败"; return; }
      branchLabelsError.textContent = "✓ 命名已保存，立即生效";
    } catch (_) {
      branchLabelsError.textContent = "保存失败，请重试";
    } finally {
      branchLabelsSaveBtn.disabled = false;
      branchLabelsSaveBtn.textContent = "保存命名";
    }
  });

  if (layoutPrefsSaveBtn) {
    layoutPrefsSaveBtn.addEventListener("click", async () => {
      const layout_prefs = {};
      for (const key of Object.keys(layoutPrefsInputs)) {
        const el = layoutPrefsInputs[key];
        const value = el ? el.value.trim() : "";
        if (value === "") continue;
        const num = Number(value);
        if (!Number.isFinite(num)) { layoutPrefsError.textContent = "线长与卡片尺寸需为有效数字"; return; }
        layout_prefs[key] = num;
      }
      layoutPrefsSaveBtn.disabled = true;
      layoutPrefsSaveBtn.textContent = "保存中…";
      layoutPrefsError.textContent = "";
      try {
        const res = await fetch("/api/setup/layout-prefs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ layout_prefs }),
        });
        const d = await res.json();
        if (!res.ok || !d.ok) { layoutPrefsError.textContent = d.error || "保存失败"; return; }
        for (const key of Object.keys(layoutPrefsInputs)) {
          const el = layoutPrefsInputs[key];
          if (el && typeof d.layout_prefs[key] === "number") el.value = d.layout_prefs[key];
        }
        layoutPrefsError.textContent = d.layout_reset
          ? `✓ 布局已保存，全部节点已按新规则重排（${d.layout_reset_nodes} 个旧位置已重置）`
          : "✓ 布局已保存（值未变化，未重置节点位置）";
      } catch (_) {
        layoutPrefsError.textContent = "保存失败，请重试";
      } finally {
        layoutPrefsSaveBtn.disabled = false;
        layoutPrefsSaveBtn.textContent = "保存布局";
      }
    });
  }

  deconSaveBtn.addEventListener("click", async () => {
    const enabled = deconBoxes.filter((box) => box.checked).map((box) => box.value);
    deconSaveBtn.disabled = true;
    deconSaveBtn.textContent = "保存中…";
    deconError.textContent = "";
    try {
      const res = await fetch("/api/setup/deconstruction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { deconError.textContent = d.error || "保存失败"; return; }
      deconError.textContent = "✓ 拆解设置已保存，立即生效";
    } catch (_) {
      deconError.textContent = "保存失败，请重试";
    } finally {
      deconSaveBtn.disabled = false;
      deconSaveBtn.textContent = "保存拆解设置";
    }
  });

  const regSubmitBtn = $("#register-submit");
  if (regSubmitBtn) {
    regSubmitBtn.addEventListener("click", async () => {
      const username = $("#reg-username").value.trim();
      const password = $("#reg-password").value;
      const password2 = $("#reg-password2").value;
      const regError = $("#register-error");
      regError.textContent = "";
      if (!username || !password) { regError.textContent = "请填写用户名和密码"; return; }
      if (password.length < 8 || password.length > 64) { regError.textContent = "密码需为 8-64 位"; return; }
      if (password !== password2) { regError.textContent = "两次输入的密码不一致"; return; }
      regSubmitBtn.disabled = true;
      regSubmitBtn.textContent = "创建中…";
      try {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const d = await res.json();
        if (!res.ok || !d.ok) { regError.textContent = d.error || "创建失败"; return; }
        location.href = "/";
      } catch (_) {
        regError.textContent = "创建失败，请重试";
      } finally {
        regSubmitBtn.disabled = false;
        regSubmitBtn.textContent = "创建并进入";
      }
    });
  }

  // 绑定邮箱
  const emailSaveBtn = $("#setup-email-save");
  if (emailSaveBtn) {
    emailSaveBtn.addEventListener("click", async () => {
      const email = $("#setup-email").value.trim().toLowerCase();
      const password = $("#email-password").value;
      const emailError = $("#email-error");
      emailError.textContent = "";
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
        emailError.textContent = "邮箱格式不正确"; return;
      }
      if (!password) { emailError.textContent = "请输入当前密码验证身份"; return; }
      emailSaveBtn.disabled = true;
      emailSaveBtn.textContent = "保存中…";
      try {
        const res = await fetch("/api/setup/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const d = await res.json();
        if (!res.ok || !d.ok) { emailError.textContent = d.error || "保存失败"; return; }
        $("#email-password").value = "";
        emailError.textContent = "✓ 邮箱已" + (email ? "绑定" : "解除") + "（" + (email || "未绑定") + "）";
      } catch (_) {
        emailError.textContent = "保存失败，请重试";
      } finally {
        emailSaveBtn.disabled = false;
        emailSaveBtn.textContent = "保存邮箱";
      }
    });
  }

  // 修改密码
  const pwdSaveBtn = $("#setup-password-save");
  if (pwdSaveBtn) {
    pwdSaveBtn.addEventListener("click", async () => {
      const oldPassword = $("#old-password").value;
      const newPassword = $("#new-password").value;
      const newPassword2 = $("#new-password2").value;
      const pwdError = $("#password-error");
      pwdError.textContent = "";
      if (!oldPassword || !newPassword) { pwdError.textContent = "请填写当前密码和新密码"; return; }
      if (newPassword.length < 8 || newPassword.length > 64) { pwdError.textContent = "新密码需为 8-64 位"; return; }
      if (newPassword !== newPassword2) { pwdError.textContent = "两次输入的新密码不一致"; return; }
      pwdSaveBtn.disabled = true;
      pwdSaveBtn.textContent = "修改中…";
      try {
        const res = await fetch("/api/auth/password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
        });
        const d = await res.json();
        if (!res.ok || !d.ok) { pwdError.textContent = d.error || "修改失败"; return; }
        pwdError.textContent = "✓ 密码已修改";
        $("#old-password").value = "";
        $("#new-password").value = "";
        $("#new-password2").value = "";
      } catch (_) {
        pwdError.textContent = "修改失败，请重试";
      } finally {
        pwdSaveBtn.disabled = false;
        pwdSaveBtn.textContent = "修改密码";
      }
    });
  }
})();

