"""Provider adapter for treening（树状学习）。

prompt 从 methodology/ 加载（单一事实来源），v1 保持与原 quiz_provider 行为一致。
"""
from __future__ import annotations

import json
import re
from typing import Any

import requests

from .methodology import Methodology


class TreeProviderError(RuntimeError):
    """Expected provider failure that is safe to show as a generic API error."""


def _is_anthropic_url(url: str) -> bool:
    """按 URL 判断 API 格式：Anthropic Messages 或 OpenAI 兼容。"""
    low = url.lower()
    return "anthropic" in low or "/v1/messages" in low


def _normalize_api_url(url: str) -> str:
    """Anthropic 基础地址自动补全 /v1/messages（如 …/anthropic → …/anthropic/v1/messages）。"""
    url = url.strip()
    if _is_anthropic_url(url) and not url.rstrip("/").endswith("/messages"):
        url = url.rstrip("/") + "/v1/messages"
    return url


def _extract_api_error(exc: requests.HTTPError) -> str:
    """从 HTTP 错误响应里尽量取出 API 的真实原因（模型名错误、鉴权失败等）。"""
    status = exc.response.status_code if exc.response is not None else "?"
    try:
        data = exc.response.json()
    except Exception:
        text = getattr(exc.response, "text", "") or ""
        if text:
            return f"接口返回 {status}：{text[:200]}"
        return f"接口返回 {status}"
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            msg = error.get("message") or error.get("type") or error.get("code")
            if msg:
                return f"接口错误：{msg}"
        if data.get("message"):
            return f"接口错误：{data['message']}"
    return f"接口返回 {status}"


class TreeProvider:
    def __init__(
        self,
        methodology: Methodology,
        api_key: str,
        api_url: str,
        model: str,
        timeout: int,
        max_context_messages: int = 14,
        persona: str = "",
        deconstruction_enabled: list[str] | None = None,
    ):
        self.methodology = methodology
        self.api_key = api_key.strip()
        self.api_url = _normalize_api_url(api_url)
        self.anthropic = _is_anthropic_url(self.api_url)
        self.model = model.strip()
        self.timeout = timeout
        self.max_context_messages = max(1, int(max_context_messages))
        self.system_prompt = methodology.prompt("system.md")
        # 个性化人设单独保存，在 _messages 拼接到 system 最末尾（效力最强）
        self.persona = persona.strip() if persona else ""
        self.interaction_guidance = methodology.interaction_guidance()
        self.summaries_instructions = methodology.prompt("summaries.md")
        self.deconstruction_blocks = methodology.deconstruction_blocks()
        self.deconstruction_enabled = set(deconstruction_enabled or ())
        self.node_summary_instructions = methodology.prompt("node-summary.md")

    def _messages(
        self,
        path: list[dict[str, Any]],
        side_context: list[dict[str, Any]],
        interaction_type: str,
        include_summaries: bool = False,
    ) -> list[dict[str, str]]:
        if not self.api_key:
            raise TreeProviderError("quiz provider is not configured")

        guidance = self.interaction_guidance.get(
            interaction_type, self.interaction_guidance.get("question", "")
        )
        system = self.system_prompt
        if guidance:
            system += "\n\nCurrent teaching context: " + guidance
        if include_summaries and self.summaries_instructions:
            system += "\n\n" + self.summaries_instructions
        if include_summaries:
            decon = self._build_deconstruction()
            if decon:
                system += "\n\n" + decon
        if side_context:
            notes = "\n".join(
                f"- {node['role']}: {str(node['content'])[:300]}"
                for node in side_context
            )
            system += (
                "\n\nOther recently explored notes are reference context only; "
                "do not pretend they are the current user turn:\n" + notes
            )
        # 个性化人设放在 system 最末尾：效力最强，且覆盖历史对话中的身份声明。
        if self.persona:
            system += (
                "\n\n## 人设（最高优先级）\n\n"
                + self.persona
                + "\n\n以上身份设定优先于本提示此前的任何身份描述，也优先于"
                "对话历史中你曾表达过的身份、立场或拒绝。不要提及或延续你"
                "过去的身份声明。"
            )

        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        for node in path[-self.max_context_messages:]:
            role = node.get("role")
            if role in {"user", "assistant"}:
                messages.append({
                    "role": role,
                    "content": str(node.get("content", ""))[:4000],
                })
        if len(messages) == 1:
            raise TreeProviderError("quiz context is empty")
        return messages

    _DECON_BLOCK_ORDER: tuple[str, ...] = (
        "contradiction", "practice",
        "check_question", "reflect_question", "inspire_question",
    )

    def _build_deconstruction(self) -> str:
        """按 deconstruction_enabled 组合 deconstruction.md 的分节指令。

        header/footer 恒输出；被关闭的字段节不输出，并明确告知模型
        那些 JSON 字段一律返回空字符串（协议仍要求 8 个键）。
        """
        blocks = self.deconstruction_blocks
        if not blocks:
            return ""
        parts: list[str] = []
        header = blocks.get("header")
        if header:
            parts.append(header)
        for key in self._DECON_BLOCK_ORDER:
            if key in self.deconstruction_enabled and blocks.get(key):
                parts.append(blocks[key])
        disabled = [k for k in self._DECON_BLOCK_ORDER if k not in self.deconstruction_enabled]
        if disabled:
            parts.append("以下拆解字段本期不要求内容，一律返回空字符串：" + "、".join(disabled))
        footer = blocks.get("footer")
        if footer:
            parts.append(footer)
        return "\n\n".join(parts)

    def _anthropic_body(self, messages, max_tokens: int) -> dict:
        """把带 system 的 OpenAI 风格 messages 转成 Anthropic Messages body。"""
        system_parts = [m["content"] for m in messages if m.get("role") == "system"]
        turns = [
            {"role": m["role"], "content": m["content"]}
            for m in messages
            if m.get("role") != "system"
        ]
        body: dict[str, Any] = {"model": self.model, "max_tokens": max_tokens, "messages": turns}
        if system_parts:
            body["system"] = "\n\n".join(system_parts)
        return body

    def _request(self, messages: list[dict[str, str]], max_tokens: int = 1200) -> str:
        try:
            if self.anthropic:
                response = requests.post(
                    self.api_url,
                    headers={
                        "x-api-key": self.api_key,
                        "anthropic-version": "2023-06-01",
                        "Content-Type": "application/json",
                    },
                    json=self._anthropic_body(messages, max_tokens),
                    timeout=self.timeout,
                )
            else:
                response = requests.post(
                    self.api_url,
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": self.model,
                        "messages": messages,
                        "temperature": 0.65,
                        "max_tokens": max_tokens,
                    },
                    timeout=self.timeout,
                )
            response.raise_for_status()
            body = response.json()
            if self.anthropic:
                answer = "".join(
                    block.get("text", "")
                    for block in body.get("content", [])
                    if block.get("type") == "text"
                )
            else:
                answer = body.get("choices", [{}])[0].get("message", {}).get("content")
            if not isinstance(answer, str) or not answer.strip():
                raise TreeProviderError("provider returned an empty answer")
            return answer.strip()
        except TreeProviderError:
            raise
        except requests.exceptions.Timeout as exc:
            raise TreeProviderError("provider timeout") from exc
        except requests.HTTPError as exc:
            raise TreeProviderError(_extract_api_error(exc)) from exc
        except (requests.RequestException, ValueError, KeyError, IndexError) as exc:
            raise TreeProviderError("provider request failed") from exc

    @classmethod
    def test_connection(cls, api_key: str, api_url: str, model: str, timeout: int = 20):
        """最小连通性测试：发一条 ping，验证 key/url/model 可用。

        自动识别 OpenAI 兼容 / Anthropic Messages 两种格式；
        Anthropic 基础地址自动补全 /v1/messages。
        """
        url = _normalize_api_url(api_url)
        anthropic = _is_anthropic_url(url)
        try:
            if anthropic:
                response = requests.post(
                    url,
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "Content-Type": "application/json",
                    },
                    json={"model": model, "max_tokens": 5, "messages": [{"role": "user", "content": "ping"}]},
                    timeout=timeout,
                )
            else:
                response = requests.post(
                    url,
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 5},
                    timeout=timeout,
                )
            response.raise_for_status()
            return True, None
        except requests.exceptions.Timeout:
            return False, "连接超时，请检查网络或接口地址"
        except requests.HTTPError as exc:
            return False, _extract_api_error(exc)
        except requests.RequestException as exc:
            return False, f"请求失败：{exc}"
        except (ValueError, KeyError, IndexError):
            return False, "响应格式不符合接口约定"

    _ESCAPE_MAP = {
        "n": "\n",
        "t": "\t",
        "r": "\r",
        "b": "\b",
        "f": "\f",
        '"': '"',
        "'": "'",
        chr(92): chr(92),
    }

    @classmethod
    def _unescape_escapes(cls, value: Any) -> str:
        """把模型输出里残留的字面量转义序列还原为真实字符。

        兜底两条泄露路径：json.loads 只还原一层的残留转义，以及
        _scan_keys 兜底提取到的未还原转义文本。真实换行（无反斜杠前缀）
        不受影响。
        """
        if not isinstance(value, str) or chr(92) not in value:
            return value if isinstance(value, str) else ""
        out: list[str] = []
        i, n = 0, len(value)
        while i < n:
            ch = value[i]
            if ch == chr(92) and i + 1 < n and value[i + 1] in cls._ESCAPE_MAP:
                out.append(cls._ESCAPE_MAP[value[i + 1]])
                i += 2
                continue
            out.append(ch)
            i += 1
        return "".join(out)

    @staticmethod
    def _normalize_summary(value: Any) -> str:
        if not isinstance(value, str):
            return ""
        summary = TreeProvider._unescape_escapes(value).strip()
        # Strip code fences and JSON markers before anything else: a model
        # that echoes "```json {...}" must never leak structural text into
        # the recall hint users see on a concealed card.
        if summary.startswith("```"):
            summary = summary.strip("`").strip()
            if summary.lower().startswith("json"):
                summary = summary[4:].strip()
        # If the value is still an object literal, pull the summary-ish key.
        stripped = summary.lstrip()
        if stripped.startswith("{") or stripped.lower().startswith("json {"):
            for key in ("summary", "answer_summary", "recall_hint", "answer"):
                marker = f'"{key}"'
                idx = stripped.find(marker)
                if idx >= 0:
                    tail = stripped[idx + len(marker):].lstrip()
                    if tail.startswith(":"):
                        tail = tail[1:].lstrip()
                        if tail.startswith('"'):
                            # consume the quoted value up to its closing quote
                            close = tail.find('"', 1)
                            tail = tail[1:] if close < 0 else tail[1:close]
                        else:
                            # unquoted value: cut at the next structural marker
                            for stop in ('",', "}", '"}', ",\n"):
                                cut = tail.find(stop)
                                if cut >= 0:
                                    tail = tail[:cut]
                                    break
                        summary = tail.strip()
                        break
        summary = " ".join(summary.split()).strip("`*_#\"'。；; ")
        if not summary or len(summary) > 50:
            return ""
        if summary in {"回忆", "提示", "验收", "追问", "其他", "显示", "隐藏"}:
            return ""
        if summary.lower().startswith("json"):
            return ""
        return summary

    @staticmethod
    def _normalize_block(value: Any, max_len: int) -> str:
        """Tolerant cleaner for the deconstruction blocks (contradiction /
        practice / three questions). Same fence + JSON-literal defense as
        _normalize_summary, but truncates at max_len instead of rejecting.
        """
        if not isinstance(value, str):
            return ""
        summary = TreeProvider._unescape_escapes(value).strip()
        if summary.startswith("```"):
            summary = summary.strip("`").strip()
            if summary.lower().startswith("json"):
                summary = summary[4:].strip()
        stripped = summary.lstrip()
        if stripped.startswith("{") or stripped.lower().startswith("json {"):
            for key in (
                "contradiction", "practice", "check_question",
                "reflect_question", "inspire_question",
                "summary", "answer_summary", "recall_hint", "answer",
            ):
                marker = f'"{key}"'
                idx = stripped.find(marker)
                if idx >= 0:
                    tail = stripped[idx + len(marker):].lstrip()
                    if tail.startswith(":"):
                        tail = tail[1:].lstrip()
                        if tail.startswith('"'):
                            close = tail.find('"', 1)
                            tail = tail[1:] if close < 0 else tail[1:close]
                        else:
                            for stop in ('",', "}", '"}', ",\n"):
                                cut = tail.find(stop)
                                if cut >= 0:
                                    tail = tail[:cut]
                                    break
                        summary = tail.strip()
                        break
        summary = " ".join(summary.split()).strip("`*_#\"'。；; ")
        if not summary:
            return ""
        if len(summary) > max_len:
            return summary[: max_len - 1].rstrip("，、：；: ") + "…"
        if summary in {"回忆", "提示", "验收", "追问", "其他", "显示", "隐藏"}:
            return ""
        if summary.lower().startswith("json"):
            return ""
        return summary

    @staticmethod
    def fallback_summary(content: Any) -> str:
        """Produce a deterministic short summary when a provider omits one."""
        text = re.sub(r"[`*_#>\[\]()]", "", str(content or ""))
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            return "暂无摘要"
        sentences = re.split(r"(?<=[。！？!?；;\.])\s*", text)
        candidate = next((part.strip() for part in sentences if part.strip()), text)
        if len(candidate) <= 50:
            return candidate
        return candidate[:49].rstrip("，、：；: ") + "…"

    _BLOCK_KEYS = (
        "answer", "question_summary", "answer_summary",
        "contradiction", "practice",
        "check_question", "reflect_question", "inspire_question",
    )

    @classmethod
    def _scan_keys(cls, body: str) -> dict[str, Any]:
        """Tolerant key-by-key scan for truncated/loose JSON output.

        json.loads is tried first; when the closing brace is cut off, this
        extracts every fully-emitted quoted value so the teaching answer and
        as many blocks as possible still survive a provider truncation.
        """
        result: dict[str, Any] = {}
        for key in cls._BLOCK_KEYS:
            for marker in (f'"{key}"', f"'{key}'", f"{key} "):
                idx = body.find(marker)
                if idx < 0:
                    continue
                after = body[idx + len(marker):].lstrip()
                if not after.startswith(":"):
                    continue
                after = after[1:].lstrip()
                if after.startswith('"'):
                    close = after.find('"', 1)
                    result[key] = after[1:] if close < 0 else after[1:close]
                elif after.startswith("'"):
                    close = after.find("'", 1)
                    result[key] = after[1:] if close < 0 else after[1:close]
                else:
                    stop = len(after)
                    for stopmark in (",", "}"):
                        cut = after.find(stopmark)
                        if 0 <= cut < stop:
                            stop = cut
                    result[key] = after[:stop].strip().strip('"\'')
                break
        return result

    @classmethod
    def _decode_answer_blocks(cls, raw: str) -> dict[str, str] | None:
        """Decode the single-call 8-block JSON with graceful degradation."""
        candidate = raw.strip()
        if candidate.startswith("```"):
            candidate = candidate.strip("`").strip()
            if candidate.lower().startswith("json"):
                candidate = candidate[4:].strip()
        payload: Any = None
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                payload = parsed
        except ValueError:
            payload = None
        if payload is None:
            start = candidate.find("{")
            end = candidate.rfind("}")
            body = candidate[start + 1:end] if start >= 0 and end > start else candidate
            payload = cls._scan_keys(body)
        if not isinstance(payload, dict):
            return None
        answer = cls._unescape_escapes(payload.get("answer"))
        if not isinstance(answer, str) or not answer.strip():
            return None
        question_summary = cls._normalize_summary(payload.get("question_summary"))
        answer_summary = cls._normalize_summary(payload.get("answer_summary"))
        # Legacy responses carried a single recall_hint instead of the two
        # summaries; keep reading them so old provider replies still degrade.
        if not question_summary and not answer_summary:
            legacy_hint = cls._normalize_summary(payload.get("recall_hint"))
            if legacy_hint:
                answer_summary = legacy_hint
        return {
            "answer": answer.strip(),
            "question_summary": question_summary,
            "answer_summary": answer_summary,
            "contradiction": cls._normalize_block(payload.get("contradiction"), 100),
            "practice": cls._normalize_block(payload.get("practice"), 100),
            "check_question": cls._normalize_block(payload.get("check_question"), 60),
            "reflect_question": cls._normalize_block(payload.get("reflect_question"), 60),
            "inspire_question": cls._normalize_block(payload.get("inspire_question"), 60),
        }

    @classmethod
    def _decode_answer_with_hint(cls, raw: str) -> tuple[str, str] | None:
        decoded = cls._decode_answer_blocks(raw)
        if not decoded:
            return None
        return decoded["answer"], decoded["answer_summary"] or decoded["question_summary"]

    def answer(
        self,
        path: list[dict[str, Any]],
        side_context: list[dict[str, Any]],
        interaction_type: str,
    ) -> str:
        return self._request(self._messages(path, side_context, interaction_type))

    def answer_with_blocks(
        self,
        path: list[dict[str, Any]],
        side_context: list[dict[str, Any]],
        interaction_type: str,
    ) -> dict[str, str]:
        raw = self._request(
            self._messages(path, side_context, interaction_type, include_summaries=True),
            max_tokens=1900,
        )
        decoded = self._decode_answer_blocks(raw)
        if decoded:
            return decoded
        # 解析失败时的兜底：先尝试从 JSON 对象里提取 answer，避免把整段
        # JSON/fence 原文暴露给用户；提取不到才回退到原文（并还原转义）。
        candidate = raw.strip()
        if candidate.startswith("```"):
            candidate = candidate.strip("`").strip()
            if candidate.lower().startswith("json"):
                candidate = candidate[4:].strip()
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start >= 0 and end > start:
            try:
                fragment = json.loads(candidate[start : end + 1])
            except ValueError:
                fragment = None
            if isinstance(fragment, dict):
                inner = fragment.get("answer")
                if isinstance(inner, str) and inner.strip():
                    return {
                        "answer": self._unescape_escapes(inner).strip(),
                        "question_summary": "", "answer_summary": "",
                        "contradiction": "", "practice": "",
                        "check_question": "", "reflect_question": "", "inspire_question": "",
                    }
        return {
            "answer": self._unescape_escapes(raw), "question_summary": "", "answer_summary": "",
            "contradiction": "", "practice": "",
            "check_question": "", "reflect_question": "", "inspire_question": "",
        }

    def answer_with_summaries(
        self,
        path: list[dict[str, Any]],
        side_context: list[dict[str, Any]],
        interaction_type: str,
    ) -> tuple[str, str, str]:
        blocks = self.answer_with_blocks(path, side_context, interaction_type)
        return blocks["answer"], blocks["question_summary"], blocks["answer_summary"]

    def answer_with_hint(
        self,
        path: list[dict[str, Any]],
        side_context: list[dict[str, Any]],
        interaction_type: str,
    ) -> tuple[str, str]:
        answer, question_summary, answer_summary = self.answer_with_summaries(
            path, side_context, interaction_type
        )
        return answer, answer_summary or question_summary

    def summarize_node(self, content: str, role: str, branch_type: str) -> str:
        messages = [
            {"role": "system", "content": self.node_summary_instructions},
            {
                "role": "user",
                "content": f"节点角色：{role}\n节点类型：{branch_type}\n节点内容：{content[:4000]}",
            },
        ]
        raw = self._request(messages, max_tokens=220)
        candidate = raw.strip()
        if candidate.startswith("```"):
            candidate = candidate.strip("`").strip()
            if candidate.lower().startswith("json"):
                candidate = candidate[4:].strip()
        try:
            payload = json.loads(candidate)
        except ValueError:
            start, end = candidate.find("{"), candidate.rfind("}")
            if start < 0 or end <= start:
                raise TreeProviderError("provider returned an invalid summary")
            try:
                payload = json.loads(candidate[start : end + 1])
            except ValueError as exc:
                raise TreeProviderError("provider returned an invalid summary") from exc
        summary = self._normalize_summary(
            payload.get("summary") if isinstance(payload, dict) else None
        )
        if not summary:
            raise TreeProviderError("provider returned an invalid summary")
        return summary
