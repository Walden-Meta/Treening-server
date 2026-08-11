"""Sentry 噪声过滤：健康探测 / 停机连接被杀 不应上报，真实错误照常上报。"""
from __future__ import annotations

from treening.app import _sentry_before_send


class TestSentryBeforeSend:
    """_sentry_before_send 只放行真实错误事件。"""

    def test_health_check_log_dropped(self):
        event = {
            "level": "error",
            "logentry": {"message": "health check failed: database probe error"},
        }
        assert _sentry_before_send(event, {}) is None

    def test_health_path_event_dropped(self):
        event = {"level": "error", "logentry": {"message": "GET /api/health failed"}}
        assert _sentry_before_send(event, {}) is None

    def test_connection_reset_dropped(self):
        event = {"level": "error", "exception": {"values": [{"type": "RuntimeError"}]}}
        hint = {"exc_info": (ConnectionResetError, ConnectionResetError("reset"), None)}
        assert _sentry_before_send(event, hint) is None

    def test_broken_pipe_dropped(self):
        event = {"level": "fatal", "exception": {"values": [{"type": "RuntimeError"}]}}
        hint = {"exc_info": (BrokenPipeError, BrokenPipeError("pipe"), None)}
        assert _sentry_before_send(event, hint) is None

    def test_real_error_passes_through(self):
        event = {"level": "error", "logentry": {"message": "unexpected boom"}, "event_id": "x"}
        hint = {"exc_info": (ValueError, ValueError("boom"), None)}
        assert _sentry_before_send(event, hint) == event

    def test_info_level_not_filtered(self):
        event = {"level": "info", "logentry": {"message": "health check failed: ignored"}}
        assert _sentry_before_send(event, {}) == event

    def test_malformed_event_does_not_crash(self):
        # 过滤逻辑自身异常时放行，不阻塞上报
        assert _sentry_before_send({"level": "error"}, None) is not None
