"""邮件发送（忘记密码的重置链接）。

只用 Python 标准库 smtplib，无需第三方依赖。支持：
- SSL 直连（默认，QQ 用 465）
- STARTTLS（587）
配置来自 data/settings.json 的 smtp 字段，管理员在后台面板填写。
"""
from __future__ import annotations

import smtplib
import socket
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from . import settings

APP_NAME = "Treening"
RESET_TTL_MINUTES = 30


def _close_quietly(server) -> None:
    """关闭 SMTP 连接。连接可能已断开，quit 会抛错，一律忽略。"""
    if not server:
        return
    try:
        server.quit()
    except (smtplib.SMTPException, OSError):
        try:
            server.close()
        except Exception:
            pass


def _friendly_error(exc: Exception) -> str:
    """把常见 smtplib/网络异常转成中文可读提示。"""
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        return "账号或授权码不正确（QQ 邮箱需用「授权码」而非登录密码）"
    if isinstance(exc, (smtplib.SMTPServerDisconnected, ConnectionError, TimeoutError, socket.timeout)):
        return "无法连接到 SMTP 服务器：请检查服务器地址、端口、网络和防火墙（QQ 邮箱需确保已开启 SMTP 服务）"
    if isinstance(exc, smtplib.SMTPException):
        return f"SMTP 错误：{exc}"
    if isinstance(exc, OSError):
        return f"网络错误：{exc}"
    return f"发送失败：{exc}"


def _server(cfg: dict) -> smtplib.SMTP | smtplib.SMTP_SSL:
    host = cfg["host"]
    port = int(cfg.get("port") or (465 if cfg.get("use_ssl") else 587))
    use_ssl = bool(cfg.get("use_ssl"))
    if use_ssl:
        return smtplib.SMTP_SSL(host, port, timeout=15)
    server = smtplib.SMTP(host, port, timeout=15)
    server.starttls()
    return server


def _from_addr(cfg: dict) -> str:
    return str(cfg.get("from_email") or cfg.get("username") or "").strip()


def _build_message(
    to_email: str, subject: str, text: str, html: str, cfg: dict
) -> MIMEMultipart:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    from_name = str(cfg.get("from_name") or APP_NAME)
    from_addr = _from_addr(cfg)
    msg["From"] = f"{from_name} <{from_addr}>" if from_addr else from_name
    msg["To"] = to_email
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))
    return msg


def send_password_reset_email(to_email: str, reset_url: str) -> None:
    """发送密码重置邮件。配置缺失或发送失败会抛异常，由调用方兜底。"""
    cfg = settings.smtp_config()
    if not (cfg.get("host") and cfg.get("username") and cfg.get("password")):
        raise RuntimeError("邮件服务尚未配置")
    subject = f"【{APP_NAME}】密码重置"
    text = (
        f"你好：\n\n你在 {APP_NAME} 发起了密码重置。请点击下面的链接完成重置"
        f"（{RESET_TTL_MINUTES} 分钟内有效，只能使用一次）：\n\n{reset_url}\n\n"
        "如果这不是你本人操作，请忽略此邮件，你的密码不会被修改。\n"
    )
    html = (
        f"<p>你好：</p><p>你在 {APP_NAME} 发起了密码重置。"
        f"请点击下面的链接完成重置（{RESET_TTL_MINUTES} 分钟内有效，只能使用一次）：</p>"
        f"<p><a href='{reset_url}'>{reset_url}</a></p>"
        "<p>如果这不是你本人操作，请忽略此邮件，你的密码不会被修改。</p>"
    )
    server = _server(cfg)
    try:
        server.login(str(cfg["username"]), str(cfg["password"]))
        msg = _build_message(to_email, subject, text, html, cfg)
        server.sendmail(_from_addr(cfg), [to_email], msg.as_string())
    finally:
        _close_quietly(server)


def test_smtp(
    host: str,
    port: int,
    use_ssl: bool,
    username: str,
    password: str,
    to_email: str,
    from_email: str = "",
) -> tuple[bool, str]:
    """向指定地址发一封测试邮件，返回 (是否成功, 提示)。"""
    cfg = {
        "host": host,
        "port": int(port),
        "use_ssl": bool(use_ssl),
        "username": username,
        "password": password,
        "from_email": from_email or username,
    }
    server = None
    try:
        server = _server(cfg)
        server.login(username, password)
        subject = f"【{APP_NAME}】邮件发送测试"
        msg = _build_message(to_email, subject, "这是一封测试邮件。", "<p>这是一封测试邮件。</p>", cfg)
        server.sendmail(_from_addr(cfg), [to_email], msg.as_string())
    except (smtplib.SMTPException, OSError) as exc:
        return False, _friendly_error(exc)
    finally:
        _close_quietly(server)
    return True, "测试邮件已发送，请到收件箱确认"
