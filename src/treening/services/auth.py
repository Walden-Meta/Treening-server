"""认证工具：密码哈希 + 登录/注册/找回限流 + 重置令牌（内存实现，单进程够用）。

登录限流按「用户名|IP」记录失败时间戳；连续失败超过阈值锁定 15 分钟。
注册限流按 IP 限制单位时间内的新账号数，防批量注册刷 API Key。
找回密码限流按「用户名|IP」，防止拿已知邮箱刷重置邮件。
内存状态在重启后归零，对本地/小团队场景是可接受的。
"""
from __future__ import annotations

import hashlib
import re
import secrets
import time
from typing import Any

from werkzeug.security import check_password_hash, generate_password_hash

MAX_FAILURES = 5
LOCK_WINDOW_SECONDS = 15 * 60

# 每 IP 失败上限：防「同 IP 对大量用户名做字典尝试」——按 IP 维度累计，
# 与「用户名|IP」维度的 5 次锁定互补（后者挡单账号爆破，前者挡批量探测）。
MAX_IP_FAILURES = 40
IP_LOCK_SECONDS = 15 * 60

# 密码策略：只限长短，不强制复杂度（限流已兜底暴力破解）
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 64

# 注册限流：同一 IP 每小时最多创建 N 个账号。
# 注意本地/局域网部署时多人共用同一出口 IP（如 127.0.0.1 / NAT），
# 阈值太紧会误伤正常用户；10/小时既能挡批量刷号，又不卡真人小群体。
MAX_REGISTRATIONS_PER_IP = 10
REGISTER_WINDOW_SECONDS = 60 * 60

# 邮箱校验：宽松规则（本地/小团队场景，不苛求 RFC）
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")

# 密码重置令牌：30 分钟有效，sha256 后入库（与密码同待遇，库泄露也不可重放）
RESET_TOKEN_TTL_SECONDS = 30 * 60
RESET_TOKEN_BYTES = 32

# 忘记密码限流：同一「用户名|IP」每小时最多发 N 次重置请求，防刷邮件
FORGOT_MAX_PER_HOUR = 3
FORGOT_WINDOW_SECONDS = 60 * 60

# key("user|ip") -> {"failures": [...timestamps], "locked_until": float}
_login_state: dict[str, dict[str, Any]] = {}
# ip -> {"failures": [...timestamps], "locked_until": float}（跨用户名的 IP 级探测防护）
_ip_failure_state: dict[str, dict[str, Any]] = {}
# ip -> [注册成功时间戳...]
_registration_state: dict[str, list[float]] = {}
# key("user|ip") -> [忘记密码请求时间戳...]
_forgot_state: dict[str, list[float]] = {}


def hash_password(password: str) -> str:
    return generate_password_hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    return check_password_hash(password_hash, password)


def validate_password(password: str) -> str | None:
    """校验新密码。返回错误消息，或 None（合法）。"""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"密码至少 {MIN_PASSWORD_LENGTH} 位"
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"密码最多 {MAX_PASSWORD_LENGTH} 位"
    return None


def _key(username: str, ip: str) -> str:
    return f"{username}|{ip}"


def registration_allowed(ip: str) -> bool:
    """该 IP 当前是否仍可注册新账号。"""
    now = time.time()
    recent = [t for t in _registration_state.get(ip, []) if now - t < REGISTER_WINDOW_SECONDS]
    return len(recent) < MAX_REGISTRATIONS_PER_IP


def record_registration(ip: str) -> None:
    now = time.time()
    ts = _registration_state.setdefault(ip, [])
    ts[:] = [t for t in ts if now - t < REGISTER_WINDOW_SECONDS]
    ts.append(now)


def is_locked(username: str, ip: str) -> bool:
    """登录是否被锁：单账号（用户名|IP）5 次失败 或 该 IP 累计 40 次失败。"""
    state = _login_state.get(_key(username, ip))
    if state and state.get("locked_until") and state["locked_until"] > time.time():
        return True
    ip_state = _ip_failure_state.get(ip)
    if ip_state and ip_state.get("locked_until") and ip_state["locked_until"] > time.time():
        return True
    return False


def record_failure(username: str, ip: str) -> None:
    now = time.time()
    k = _key(username, ip)
    state = _login_state.setdefault(k, {"failures": [], "locked_until": 0.0})
    state["failures"] = [t for t in state["failures"] if now - t < LOCK_WINDOW_SECONDS]
    state["failures"].append(now)
    if len(state["failures"]) >= MAX_FAILURES:
        state["locked_until"] = now + LOCK_WINDOW_SECONDS
        state["failures"] = []

    # IP 级累计（跨用户名）：防止同 IP 对多个账号做字典尝试
    ip_state = _ip_failure_state.setdefault(ip, {"failures": [], "locked_until": 0.0})
    ip_state["failures"] = [t for t in ip_state["failures"] if now - t < IP_LOCK_SECONDS]
    ip_state["failures"].append(now)
    if len(ip_state["failures"]) >= MAX_IP_FAILURES:
        ip_state["locked_until"] = now + IP_LOCK_SECONDS
        ip_state["failures"] = []


def clear_failures(username: str, ip: str) -> None:
    _login_state.pop(_key(username, ip), None)
    _ip_failure_state.pop(ip, None)


def validate_email(email: str) -> str | None:
    """校验邮箱格式。空字符串表示未绑定，返回 None（合法）。"""
    if not email:
        return None
    if len(email) > 254 or not EMAIL_RE.fullmatch(email):
        return "邮箱格式不正确"
    return None


def forgot_allowed(username: str, ip: str) -> bool:
    now = time.time()
    recent = [
        t for t in _forgot_state.get(_key(username, ip), [])
        if now - t < FORGOT_WINDOW_SECONDS
    ]
    return len(recent) < FORGOT_MAX_PER_HOUR


def record_forgot(username: str, ip: str) -> None:
    now = time.time()
    ts = _forgot_state.setdefault(_key(username, ip), [])
    ts[:] = [t for t in ts if now - t < FORGOT_WINDOW_SECONDS]
    ts.append(now)


def new_reset_token() -> tuple[str, str]:
    """生成 (明文令牌, 入库哈希)。明文只在邮件链接里出现一次。"""
    raw = secrets.token_urlsafe(RESET_TOKEN_BYTES)
    return raw, hash_token(raw)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
