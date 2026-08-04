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

  let hasExistingKey = false;

  // 预填当前配置（Key 只给掩码提示，不回传明文）
  fetch("/api/setup")
    .then((r) => r.json())
    .then((d) => {
      if (d.api_url) urlInput.value = d.api_url;
      if (d.model) modelInput.value = d.model;
      hasExistingKey = Boolean(d.configured);
      if (hasExistingKey) {
        keyHint.hidden = false;
        keyHint.textContent = d.key_hint ? "已配置 " + d.key_hint + "，留空则保持不变" : "已配置，留空则保持不变";
        keyInput.placeholder = "留空保持当前 Key";
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
})();

