(() => {
  "use strict";
  const loginView = document.getElementById("login-view");
  const registerView = document.getElementById("register-view");
  const errorEl = document.getElementById("login-error");
  const registerError = document.getElementById("register-error");

  // 登录页是否显示注册入口/忘记密码：首启建管理员 或 开放注册开启
  // registration_mode: open（自由注册）/ invite（需邀请码）/ closed（关闭）
  fetch("/api/auth/status").then((r) => r.json()).then((d) => {
    const mode = d.registration_mode || (d.open_registration ? "open" : "closed");
    const hint = document.getElementById("register-hint");
    const closed = document.getElementById("register-closed");
    const inviteField = document.getElementById("invite-code-field");
    if (d.has_users && mode === "closed") {
      if (hint) hint.hidden = true;
      if (closed) closed.hidden = false;
    } else if (hint) {
      hint.hidden = false;
      // invite 模式：注册表单显示邀请码输入框，并作为必填
      if (mode === "invite" && inviteField) {
        inviteField.hidden = false;
        const inviteInput = document.getElementById("reg-invite-code");
        if (inviteInput) inviteInput.setAttribute("required", "");
      }
    }
    // 有用户存在时，登录框显示「忘记密码」入口
    const forgotLink = document.getElementById("forgot-link");
    const sep = document.getElementById("forgot-sep");
    if (d.has_users && forgotLink) {
      forgotLink.hidden = false;
      if (sep) sep.hidden = false;
    }
  }).catch(() => {});

  document.getElementById("go-register")?.addEventListener("click", (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    loginView.hidden = true;
    registerView.hidden = false;
    document.getElementById("reg-username").focus();
  });
  document.getElementById("go-login")?.addEventListener("click", (e) => {
    e.preventDefault();
    registerError.textContent = "";
    registerView.hidden = true;
    loginView.hidden = false;
    document.getElementById("login-username").focus();
  });

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    const btn = e.currentTarget.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "登录中…";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: document.getElementById("login-username").value.trim(),
          password: document.getElementById("login-password").value,
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { errorEl.textContent = d.error || "登录失败"; return; }
      location.href = "/";
    } catch (_) {
      errorEl.textContent = "无法连接服务，请重试";
    } finally {
      btn.disabled = false; btn.textContent = "登录";
    }
  });

  document.getElementById("register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    registerError.textContent = "";
    const u = document.getElementById("reg-username").value.trim();
    const p1 = document.getElementById("reg-password").value;
    const p2 = document.getElementById("reg-password2").value;
    const regEmail = document.getElementById("reg-email").value.trim();
    if (!u || !p1) { registerError.textContent = "请填写用户名和密码"; return; }
    if (p1.length < 8 || p1.length > 64) { registerError.textContent = "密码需为 8-64 位"; return; }
    if (p1 !== p2) { registerError.textContent = "两次输入的密码不一致"; return; }
    if (regEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(regEmail)) {
      registerError.textContent = "邮箱格式不正确"; return;
    }
    const btn = e.currentTarget.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "注册中…";
    try {
      const inviteCode = document.getElementById("reg-invite-code")?.value.trim() || "";
    const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p1, email: regEmail, invite_code: inviteCode }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { registerError.textContent = d.error || "注册失败"; return; }
      location.href = "/";
    } catch (_) {
      registerError.textContent = "无法连接服务，请重试";
    } finally {
      btn.disabled = false; btn.textContent = "注册并进入";
    }
  });
})();
