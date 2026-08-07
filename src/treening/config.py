"""treening 独立配置。

优先级：环境变量 TREENING_* > data/settings.json > 默认值
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import yaml

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # 仓库根


def _load_settings() -> dict:
    path = BASE_DIR / "data" / "settings.json"
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


_settings = _load_settings()


# 画布布局偏好（每用户全局生效，作用于所有主题）。
# 默认值须与前端 buildLayout / NODE_DEFAULT_* 保持一致：
#   qa_gap      一组问答之间的线长（问题→回答，可见约 qa_gap-20 px）
#   branch_gap  不同问答之间衔接的线长（回答→分支问题）
#   node_width  卡片默认宽
#   node_height 卡片默认高
LAYOUT_PREFS_DEFAULTS: dict[str, float] = {
    "qa_gap": 44,
    "branch_gap": 82,
    "node_width": 300,
    "node_height": 180,
}
LAYOUT_PREFS_RANGES: dict[str, tuple[float, float]] = {
    "qa_gap": (16, 200),
    "branch_gap": (40, 300),
    "node_width": (220, 640),   # 同前端 NODE_MIN/MAX_WIDTH
    "node_height": (90, 4800),  # 同前端 NODE_MIN/MAX_HEIGHT
}


def layout_prefs_for(user_cfg: dict) -> dict[str, float]:
    """返回生效的布局偏好：用户覆盖（数值夹取到合法范围）+ 默认兜底。

    配置页保存的覆盖值写入 user_configs.layout_prefs；
    前端展示与学习空间读取统一走这里，保证缺键/越界时回退安全值。
    """
    merged = dict(LAYOUT_PREFS_DEFAULTS)
    stored = user_cfg.get("layout_prefs") or {}
    if isinstance(stored, dict):
        for key, (low, high) in LAYOUT_PREFS_RANGES.items():
            try:
                value = float(stored.get(key))
            except (TypeError, ValueError):
                continue
            merged[key] = max(low, min(high, value))
    return merged


def _env(key: str, default: str = "") -> str:
    value = os.environ.get(f"TREENING_{key}")
    if value:
        return value
    settings_value = _settings.get(key.lower())
    if settings_value is not None:
        return str(settings_value)
    return default


class Config:
    def __init__(self) -> None:
        # 网络
        self.HOST: str = _env("HOST", "127.0.0.1")
        self.PORT: int = int(_env("PORT", "5000"))

        # 数据
        self.DATABASE_URL: str = _env(
            "DATABASE_URL", f"sqlite:///{BASE_DIR / 'data' / 'tree.db'}"
        )
        self.METHODOLOGY_DIR: Path = Path(_env("METHODOLOGY_DIR", str(BASE_DIR / "methodology")))

        # 模型（OpenAI 兼容）
        self.API_KEY: str = _env("API_KEY", "")
        self.API_URL: str = _env("API_URL", "https://api.deepseek.com/chat/completions")
        self.MODEL: str = _env("MODEL", "deepseek-chat")
        self.PERSONA: str = _env("PERSONA", "")
        # 人设文件（配置页编辑的主存储；TREENING_PERSONA 可临时覆盖）
        self.PERSONA_FILE: Path = Path(_env("PERSONA_FILE", str(BASE_DIR / "data" / "persona.md")))
        self.PERSONA_MAX_CHARS: int = int(_env("PERSONA_MAX_CHARS", "4000"))
        self.PROVIDER_TIMEOUT_SECONDS: int = int(_env("PROVIDER_TIMEOUT_SECONDS", "45"))
        self.MAX_QUESTION_CHARS: int = int(_env("MAX_QUESTION_CHARS", "2000"))
        self.MAX_CONTEXT_MESSAGES: int = int(_env("MAX_CONTEXT_MESSAGES", "12"))
        self.MAX_INFLIGHT: int = int(_env("MAX_INFLIGHT", "2"))

        # 配额（BYO-Key 默认不限额；托管代缴费模式再启用）
        self.QUOTA_ENABLED: bool = _env("QUOTA_ENABLED", "false").lower() in {"1", "true", "yes"}
        self.MAX_QUESTIONS: int = int(_env("MAX_QUESTIONS", "8"))

        # 分支（运行时覆盖值；默认来自 methodology/rules.yaml）
        self.MAX_BRANCHES: int = int(_env("MAX_BRANCHES", "3"))
        # 分支节点命名（用户可配置，默认来自 methodology/rules.yaml）
        self.BRANCH_LABEL_MAX_CHARS: int = int(_env("BRANCH_LABEL_MAX_CHARS", "6"))

        # 拆解模块开关（默认全开；存 settings.json deconstruction_enabled）
        # 空列表 = 全部关闭；缺省 = 全部开启。
        self.ALL_DECONSTRUCTION_BLOCKS: tuple[str, ...] = (
            "contradiction", "practice",
            "check_question", "reflect_question", "inspire_question",
        )
        stored_decon = _settings.get("deconstruction_enabled")
        self.DECONSTRUCTION_ENABLED: list[str] = (
            [k for k in stored_decon if k in self.ALL_DECONSTRUCTION_BLOCKS]
            if isinstance(stored_decon, list)
            else list(self.ALL_DECONSTRUCTION_BLOCKS)
        )

        # 单用户固定身份
        self.OWNER_ID: str = "local-owner"

    def reload(self) -> None:
        """重新读取 settings.json（向导保存后调用，免重启生效）。"""
        global _settings
        _settings = _load_settings()
        self.__init__()

    def ensure_dirs(self) -> None:
        (BASE_DIR / "data").mkdir(parents=True, exist_ok=True)
        self.METHODOLOGY_DIR.mkdir(parents=True, exist_ok=True)

    def persona(self) -> str:
        """返回当前生效的人设内容。

        优先级：PERSONA_FILE（配置页编辑的主存储，动态读取、保存即生效）
        > TREENING_PERSONA / settings.persona（临时覆盖）。
        返回空字符串表示不注入，使用通用 system.md。
        """
        try:
            text = self.PERSONA_FILE.read_text(encoding="utf-8").strip()
            if text:
                return text
        except OSError:
            pass
        return self.PERSONA

    def _default_branch_labels(self) -> dict[str, str]:
        """默认节点命名，来自 methodology/rules.yaml（唯一事实来源）。"""
        path = self.METHODOLOGY_DIR / "rules.yaml"
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except (OSError, yaml.YAMLError):
            data = {}
        return {
            s.get("id", ""): s.get("label", s.get("id", ""))
            for s in data.get("branch_slots", [])
            if s.get("id")
        }

    def branch_labels(self) -> dict[str, str]:
        """返回生效的分支节点命名：settings 用户覆盖 + rules.yaml 默认兜底。

        配置页保存的覆盖值写入 settings.json 的 branch_labels 键；
        前端展示与配置页预填统一走这里，保证缺键时回退默认。
        """
        overrides = {
            k: v.strip()
            for k, v in dict(_settings.get("branch_labels") or {}).items()
            if v and str(v).strip()
        }
        return {**self._default_branch_labels(), **overrides}


config = Config()
