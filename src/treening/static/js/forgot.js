(() => {
  "use strict";
  const form = document.getElementById("forgot-form");
  const errorEl = document.getElementById("forgot-error");
  const successBox = document.getElementById("forgot-success");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    successBox.hidden = true;
    const username = document.getElementById("forgot-username").value.trim();
    const email = document.getElementById("forgot-email").value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) { errorEl.textContent = "邮箱格式不正确"; return; }
    const btn = e.currentTarget.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "发送中…";
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { errorEl.textContent = d.error || "发送失败，请稍后再试"; return; }
      form.hidden = true;
      successBox.hidden = false;
    } catch (_) {
      errorEl.textContent = "无法连接服务，请重试";
    } finally {
      btn.disabled = false; btn.textContent = "发送重置邮件";
    }
  });
})();
