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
#   qa_gap      问答对内部间距（发问卡↔回答卡的缝隙，横细线居中，可拖拽分配高度）
#   branch_gap  不同问答之间衔接的线长（回答→分支问题）
#   node_width  卡片默认宽（问答对共享宽度）
#   node_height 卡片默认高（问答对按各自高度排布，缩放保持比例）
LAYOUT_PREFS_DEFAULTS: dict[str, float] = {
    "qa_gap": 24,
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

        # 日志（请求日志在 app.py 按此级别输出，默认 INFO）
        self.LOG_LEVEL: str = _env("LOG_LEVEL", "INFO")

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
        # 随包默认人设（春宁）：data/persona.md 为空或缺失时兜底，保证"底座人设"永远存在
        self.DEFAULT_PERSONA_FILE: Path = Path(__file__).resolve().parent / "default_persona.md"
        self.PERSONA_MAX_CHARS: int = int(_env("PERSONA_MAX_CHARS", "4000"))
        self.PROVIDER_TIMEOUT_SECONDS: int = int(_env("PROVIDER_TIMEOUT_SECONDS", "45"))
        # 推理模型的思考预算（Anthropic Messages 兼容接口）。为 0 时不发送 thinking 参数。
        # deepseek-v4 等推理模型默认思考极长，会把输出预算（max_tokens）吃光，
        # 导致正文/摘要/拆解字段缺失或直接无文本返回，故默认给一个上限。
        self.THINKING_BUDGET_TOKENS: int = int(_env("THINKING_BUDGET_TOKENS", "512"))
        self.MAX_QUESTION_CHARS: int = int(_env("MAX_QUESTION_CHARS", "2000"))
        self.MAX_CONTEXT_MESSAGES: int = int(_env("MAX_CONTEXT_MESSAGES", "12"))
        self.MAX_INFLIGHT: int = int(_env("MAX_INFLIGHT", "2"))

        # ── 任务可靠性（重试 / 租约 / 并发上限） ──
        # 可重试的 provider 错误（超时/连接/5xx/429）最多自动重试次数（第 1 次为首次执行）
        self.JOB_MAX_ATTEMPTS: int = int(_env("JOB_MAX_ATTEMPTS", "3"))
        # 指数退避基数/上限（秒），每次重试 = min(base * 2^(attempts-1), max) * 随机抖动
        self.JOB_RETRY_BASE_DELAY: int = int(_env("JOB_RETRY_BASE_DELAY", "10"))
        self.JOB_RETRY_MAX_DELAY: int = int(_env("JOB_RETRY_MAX_DELAY", "120"))
        # 任务租约 TTL（秒）：running 超过该时长未完成且无心跳 → 视为 worker 崩溃，由清扫器重新领取
        self.JOB_LEASE_TTL: int = int(_env("JOB_LEASE_TTL", "180"))
        # 后台清扫器轮询间隔（秒）；设为 0 或 false 关闭（测试用）
        self.JOB_SWEEPER_INTERVAL: int = int(_env("JOB_SWEEPER_INTERVAL", "10"))
        self.JOB_SWEEPER_ENABLED: bool = _env("JOB_SWEEPER_ENABLED", "true").lower() in {"1", "true", "yes"}
        # 全局在途任务上限（pending+running），防止线程池排队无限积压
        self.MAX_GLOBAL_INFLIGHT: int = int(_env("MAX_GLOBAL_INFLIGHT", "6"))

        # 配额（默认启用；普通用户每人每日默认 20 次，管理员不限，可在管理面板按人覆盖）
        self.QUOTA_ENABLED: bool = _env("QUOTA_ENABLED", "true").lower() in {"1", "true", "yes"}
        self.MAX_QUESTIONS: int = int(_env("MAX_QUESTIONS", "20"))

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

        # ── 生产加固 ──
        # 环境标识（仅用于 Sentry 等第三方打标签，不影响行为）
        self.ENV: str = _env("ENV", "production")
        # HTTPS 下启用 Secure Cookie（默认关闭以便本地 http 开发；Dockerfile 生产置 true）
        self.COOKIE_SECURE: bool = _env("COOKIE_SECURE", "false").lower() in {"1", "true", "yes"}
        # 是否位于可信反向代理（nginx）之后：启用 ProxyFix 读取真实 IP / 协议 / Host
        self.BEHIND_PROXY: bool = _env("BEHIND_PROXY", "false").lower() in {"1", "true", "yes"}
        # 额外放行的 Origin（逗号分隔；缺省只允许同源请求）
        self.ALLOWED_ORIGINS: str = _env("ALLOWED_ORIGINS", "")
        # Sentry DSN：配置后自动初始化错误聚合（sentry-sdk 需另行安装）
        self.SENTRY_DSN: str = _env("SENTRY_DSN", "")
        # 性能追踪采样率：0~1。引导验证阶段可设 1.0（全量 traces），
        # 平时 0.05 足够看趋势又不烧 Sentry 配额
        self.SENTRY_TRACES_SAMPLE_RATE: float = float(
            _env("SENTRY_TRACES_SAMPLE_RATE", "0.05")
        )
        # 注册模式（settings.json 优先，环境变量兜底）：open / invite / closed
        self.REGISTRATION_MODE: str = _env("REGISTRATION_MODE", "open")

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

        春宁是底座人设，永远兜底：PERSONA_FILE（配置页编辑，动态读取）
        > TREENING_PERSONA / settings.persona（临时覆盖）
        > 随包默认人设 default_persona.md（春宁）。
        因此不会出现"没有通用风格"的空人设：用户未配置时就是春宁。
        """
        try:
            text = self.PERSONA_FILE.read_text(encoding="utf-8").strip()
            if text:
                return text
        except OSError:
            pass
        if self.PERSONA:
            return self.PERSONA
        try:
            return self.DEFAULT_PERSONA_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            return ""

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
