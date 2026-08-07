(() => {
  "use strict";
  // 重置令牌在 URL query（/reset?token=...），等价于模板里的 {{ token|tojson }}
  const token = new URLSearchParams(window.location.search).get("token") || "";
  if (!token) {
    document.getElementById("reset-error").textContent = "重置链接无效：缺少令牌，请重新发起找回密码。";
    document.getElementById("reset-form").querySelector("button").disabled = true;
  }
  const form = document.getElementById("reset-form");
  const errorEl = document.getElementById("reset-error");
  const successBox = document.getElementById("reset-success");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    const p1 = document.getElementById("reset-password").value;
    const p2 = document.getElementById("reset-password2").value;
    if (p1.length < 8 || p1.length > 64) { errorEl.textContent = "密码需为 8-64 位"; return; }
    if (p1 !== p2) { errorEl.textContent = "两次输入的新密码不一致"; return; }
    const btn = e.currentTarget.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "重置中…";
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: p1 }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { errorEl.textContent = d.error || "重置失败"; return; }
      form.hidden = true;
      successBox.hidden = false;
    } catch (_) {
      errorEl.textContent = "无法连接服务，请重试";
    } finally {
      btn.disabled = false; btn.textContent = "重置密码";
    }
  });
})();
