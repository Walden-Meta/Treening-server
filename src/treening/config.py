"""treening 独立配置。

优先级：环境变量 TREENING_* > data/settings.json > 默认值
"""
from __future__ import annotations

import json
import os
from pathlib import Path

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
        self.PROVIDER_TIMEOUT_SECONDS: int = int(_env("PROVIDER_TIMEOUT_SECONDS", "45"))
        self.MAX_QUESTION_CHARS: int = int(_env("MAX_QUESTION_CHARS", "2000"))
        self.MAX_CONTEXT_MESSAGES: int = int(_env("MAX_CONTEXT_MESSAGES", "12"))
        self.MAX_INFLIGHT: int = int(_env("MAX_INFLIGHT", "2"))

        # 配额（BYO-Key 默认不限额；托管代缴费模式再启用）
        self.QUOTA_ENABLED: bool = _env("QUOTA_ENABLED", "false").lower() in {"1", "true", "yes"}
        self.MAX_QUESTIONS: int = int(_env("MAX_QUESTIONS", "8"))

        # 分支（运行时覆盖值；默认来自 methodology/rules.yaml）
        self.MAX_BRANCHES: int = int(_env("MAX_BRANCHES", "3"))

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


config = Config()
