"""Provider adapter for textree（树状学习）。

prompt 从 methodology/ 加载（单一事实来源），v1 保持与原 quiz_provider 行为一致。
"""
from __future__ import annotations

import json
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
    ):
        self.methodology = methodology
        self.api_key = api_key.strip()
        self.api_url = _normalize_api_url(api_url)
        self.anthropic = _is_anthropic_url(self.api_url)
        self.model = model.strip()
        self.timeout = timeout
        self.max_context_messages = max(1, int(max_context_messages))
        self.system_prompt = methodology.prompt("system.md")
        self.interaction_guidance = methodology.interaction_guidance()
        self.summaries_instructions = methodology.prompt("summaries.md")
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
        if side_context:
            notes = "\n".join(
                f"- {node['role']}: {str(node['content'])[:300]}"
                for node in side_context
            )
            system += (
                "\n\nOther recently explored notes are reference context only; "
                "do not pretend they are the current user turn:\n" + notes
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

    @staticmethod
    def _normalize_summary(value: Any) -> str:
        if not isinstance(value, str):
            return ""
        summary = " ".join(value.split()).strip("`*_#\"'。；; ")
        if not summary or len(summary) > 50:
            return ""
        if any(term in summary for term in ("回忆", "提示", "验收", "追问", "其他", "显示", "隐藏")):
            return ""
        return summary

    @classmethod
    def _decode_answer_with_summaries(
        cls, raw: str
    ) -> tuple[str, str, str] | None:
        candidate = raw.strip()
        if candidate.startswith("```"):
            candidate = candidate.strip("`").strip()
            if candidate.lower().startswith("json"):
                candidate = candidate[4:].strip()
        try:
            payload = json.loads(candidate)
        except ValueError:
            start = candidate.find("{")
            end = candidate.rfind("}")
            if start < 0 or end <= start:
                return None
            try:
                payload = json.loads(candidate[start : end + 1])
            except ValueError:
                return None
        if not isinstance(payload, dict):
            return None
        answer = payload.get("answer")
        if not isinstance(answer, str) or not answer.strip():
            return None
        if "question_summary" not in payload and "answer_summary" not in payload:
            legacy_hint = cls._normalize_summary(payload.get("recall_hint"))
            return answer.strip(), "", legacy_hint
        return (
            answer.strip(),
            cls._normalize_summary(payload.get("question_summary")),
            cls._normalize_summary(payload.get("answer_summary")),
        )

    @classmethod
    def _decode_answer_with_hint(cls, raw: str) -> tuple[str, str] | None:
        decoded = cls._decode_answer_with_summaries(raw)
        if not decoded:
            return None
        answer, question_summary, answer_summary = decoded
        return answer, answer_summary or question_summary

    def answer(
        self,
        path: list[dict[str, Any]],
        side_context: list[dict[str, Any]],
        interaction_type: str,
    ) -> str:
        return self._request(self._messages(path, side_context, interaction_type))

    def answer_with_summaries(
        self,
        path: list[dict[str, Any]],
        side_context: list[dict[str, Any]],
        interaction_type: str,
    ) -> tuple[str, str, str]:
        raw = self._request(
            self._messages(path, side_context, interaction_type, include_summaries=True),
            max_tokens=1400,
        )
        decoded = self._decode_answer_with_summaries(raw)
        if decoded:
            return decoded
        return raw, "", ""

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

