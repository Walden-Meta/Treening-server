"""Agent tools for treening desktop（本机单用户）。

每个工具 = {name, description, parameters(JSON Schema), handler}。
handler 由 _run_job 注入 store/user_id，保证只操作当前主人的数据。
"""
from __future__ import annotations

import ast
import operator
import re

import requests

_MAX_TOOL_OUTPUT = 2000


def _safe_calc(expression: str) -> str:
    """极小安全的算术求值器：只允许数字/四则/幂/括号/常见常量。"""
    expr = (expression or "").strip()
    if not expr or len(expr) > 200:
        return "错误：表达式为空或过长"
    allowed = {
        ast.Expression, ast.Constant, ast.BinOp, ast.UnaryOp,
        ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.USub, ast.UAdd,
        ast.Mod, ast.FloorDiv,
    }
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError:
        return "错误：表达式无法解析（仅支持算术：数字、+ - * / ** % 与括号）"
    for node in ast.walk(tree):
        if type(node) not in allowed:
            return "错误：仅支持纯算术，禁止函数/变量/属性访问"
        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float)):
            return "错误：仅支持数字常量"
    ops = {
        ast.Add: operator.add, ast.Sub: operator.sub,
        ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.Pow: operator.pow, ast.Mod: operator.mod,
        ast.FloorDiv: operator.floordiv,
        ast.USub: operator.neg, ast.UAdd: operator.pos,
    }
    try:
        result = eval(compile(tree, "<calc>", "eval"), {"__builtins__": {}}, {})
    except ZeroDivisionError:
        return "错误：除以零"
    except Exception as exc:  # noqa: BLE001
        return f"错误：{exc}"
    if isinstance(result, float):
        return f"{result:.6g}"
    return str(result)


def _fetch_url(url: str) -> str:
    """抓取一个网页/文本 URL 的前面部分，去掉脚本样式标签。"""
    url = (url or "").strip()
    if not url.startswith(("http://", "https://")):
        return "错误：只支持 http/https 地址"
    try:
        resp = requests.get(
            url, timeout=15,
            headers={"User-Agent": "Mozilla/5.0 (Treening desktop)"},
        )
        resp.raise_for_status()
    except requests.exceptions.Timeout:
        return "错误：获取超时"
    except requests.exceptions.HTTPError as exc:
        return f"错误：HTTP {exc.response.status_code if exc.response else '?'}"
    except requests.RequestException as exc:
        return f"错误：请求失败 {exc}"
    text = resp.text
    text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return "该页面没有可提取的文本"
    return text[:_MAX_TOOL_OUTPUT]


def build_agent_tools(store, user_id: str) -> list[dict]:
    """构造本机 agent 的工具集。store 必须支持 search_nodes。"""

    def knowledge_search(query: str) -> str:
        hits = store.search_nodes(user_id, query, limit=6)
        if not hits:
            return "在你的知识树中没有找到相关内容。"
        lines = []
        for hit in hits:
            role_label = "提问" if hit.get("role") == "user" else "回答"
            content = re.sub(r"\s+", " ", str(hit.get("content", ""))).strip()
            lines.append(
                f"[{role_label} · 主题：{hit.get('session_title', '')}]\n{content[:300]}"
            )
        return "\n\n".join(lines)[:_MAX_TOOL_OUTPUT]

    def read_url(url: str) -> str:
        return _fetch_url(url)

    def calculate(expression: str) -> str:
        return _safe_calc(expression)

    return [
        {
            "name": "knowledge_search",
            "description": (
                "在你自己的学习知识树（所有历史主题的节点内容）中检索与关键词相关的"
                "记录。当问题与你以前学过的内容相关、或需要调用既往结论时使用。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "要检索的关键词或短语",
                    }
                },
                "required": ["query"],
            },
            "handler": knowledge_search,
        },
        {
            "name": "read_url",
            "description": (
                "读取一个网页地址并返回其纯文本内容。当回答需要引用网页资料、"
                "查阅在线文档或新闻时使用。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "http/https 开头的完整网址",
                    }
                },
                "required": ["url"],
            },
            "handler": read_url,
        },
        {
            "name": "calculate",
            "description": "做纯算术计算（数字与 + - * / ** % 括号），返回数值结果。",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "算术表达式，如 (12*8+4)/2",
                    }
                },
                "required": ["expression"],
            },
            "handler": calculate,
        },
    ]
