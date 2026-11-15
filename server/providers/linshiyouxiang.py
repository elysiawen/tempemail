"""linshiyouxiang.net —— 同域接口，Cookie + HTML 内联签名 code。"""

from __future__ import annotations

import json
import re
from typing import Any

from .base import BaseProvider, BoxState, ProviderError, html_to_text

BASE = "https://www.linshiyouxiang.net"
HTML_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

MAIL_RE = re.compile(r"const activeMail = '([^']+)'")
CODE_RE = re.compile(r"const activeMailCode = '([^']+)'")
BODY_RE = re.compile(r"const emailContent = `([\s\S]*?)`;")
WRAPPER_RE = re.compile(r'<div id="content-wrapper">([\s\S]*?)</div>')


def _decode_email_html(raw: str) -> str:
    """详情页里的邮件正文是 JSON 转义字符串，需要解码后才能当 HTML 渲染。"""
    wrapper = WRAPPER_RE.search(raw)
    content = (wrapper.group(1) if wrapper else raw).strip()
    if not any(token in content for token in ("\\u003c", "\\u0022", "\\n", '\\"')):
        return content
    try:
        return json.loads(f'"{content}"')
    except Exception:  # noqa: BLE001
        content = re.sub(
            r"\\u([0-9a-fA-F]{4})",
            lambda match: chr(int(match.group(1), 16)),
            content,
        )
        return (
            content.replace("\\/", "/")
            .replace('\\"', '"')
            .replace("\\n", "\n")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
        )


_CAPTCHA_MARKERS = (
    'id="rateCaptchaForm"',
    "captcha-card",
    "安全验证",
    "检测到请求过于频繁",
)


def _captcha_error() -> ProviderError:
    return ProviderError(
        "该平台触发了人机验证，请输入图中 4 位数字继续",
        code="captcha_required",
        status=429,
    )


def _detect_captcha(text: str) -> None:
    if not text:
        return
    if any(marker in text for marker in _CAPTCHA_MARKERS):
        raise _captcha_error()


def _check(resp) -> None:
    _detect_captcha(resp.text or "")
    if resp.status_code == 429:
        raise _captcha_error()
    if resp.status_code == 403:
        raise ProviderError("请求被平台拒绝（可能触发风控）", code="rate_limited", status=429)
    if resp.status_code >= 500:
        raise ProviderError("平台服务异常，请稍后重试", code="upstream_error", status=502)


def _json(resp):
    _check(resp)
    try:
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise ProviderError("平台返回了无法解析的响应", code="bad_response", status=502) from exc
    if isinstance(data, dict) and data.get("need_captcha"):
        raise _captcha_error()
    return data


class Provider(BaseProvider):
    id = "linshiyouxiang"
    name = "linshiyouxiang.net"
    site = "https://www.linshiyouxiang.net"
    accent = "#38bdf8"
    tagline = "打开即建箱 · 可选域名"

    supports_name = False
    supports_domain = True
    supports_domain_switch = True
    supports_delete = False
    supports_eml = False
    supports_attachments = False

    poll_interval_ms = 30000
    suggest_auto_refresh = False
    note = "限流较严（约 10 次请求触发验证码），默认关闭自动刷新；触发后按弹窗输入 4 位数字即可继续。"

    def create(self, session, name=None, domain=None) -> BoxState:
        resp = session.get(f"{BASE}/", headers=HTML_HEADERS, timeout=45)
        _check(resp)
        text = resp.text or ""
        mail_match = MAIL_RE.search(text)
        code_match = CODE_RE.search(text)
        if not mail_match or not code_match:
            raise ProviderError("无法从首页解析邮箱地址，站点可能改版或被拦截", code="parse_error", status=502)
        return BoxState(
            address=mail_match.group(1),
            token=None,
            extra={"code": code_match.group(1)},
        )

    def change_domain(self, session, box: BoxState, domain: str) -> BoxState:
        resp = session.post(f"{BASE}/change-domain", json={"domain": domain}, timeout=30)
        data = _json(resp)
        if not data.get("success"):
            raise ProviderError(
                data.get("error") or "域名切换失败，该域名可能需要会员",
                code="domain_rejected",
                status=400,
            )
        # 换域名后签名会变化，重新打开首页同步 activeMail / activeMailCode
        return self.create(session)

    def list_domains(self) -> list[dict[str, Any]]:
        from curl_cffi import requests

        session = requests.Session(impersonate="chrome")
        try:
            resp = session.get(f"{BASE}/get-domains", headers=HTML_HEADERS, timeout=30)
            groups = _json(resp)
        finally:
            session.close()

        result: list[dict[str, Any]] = []
        if isinstance(groups, list):
            for group in groups:
                if not isinstance(group, dict):
                    continue
                if group.get("type") != "normal":
                    continue
                for item in group.get("items") or []:
                    if item.get("type") != "domain" or item.get("is_vip"):
                        continue
                    domain = item.get("domain")
                    if domain:
                        result.append({"domain": domain, "type": "public", "vip": False})
        return result

    def list_messages(self, session, box: BoxState) -> list[dict[str, Any]]:
        resp = session.post(
            f"{BASE}/get-messages",
            json={"email": box.address, "code": box.extra.get("code", "")},
            timeout=30,
        )
        data = _json(resp)
        if not data.get("success"):
            raise ProviderError(data.get("error") or "获取邮件列表失败", code="upstream_error", status=502)
        messages = []
        for item in data.get("emails") or []:
            name = item.get("FromName") or item.get("FromEmail") or "未知发件人"
            email = item.get("FromEmail") or ""
            messages.append(
                {
                    "id": item.get("Code") or "",
                    "from": f"{name} <{email}>" if email else name,
                    "from_name": name,
                    "from_email": email,
                    "subject": item.get("Subject") or "(无主题)",
                    "preview": "",
                    "received_at": int(item.get("SendTime") or 0),
                    "attachments_count": 0,
                    "is_read": bool(item.get("Status")),
                    "has_html": True,
                    "gmail": bool(item.get("gmail")),
                }
            )
        return messages

    def get_message(self, session, box, message_id, context=None) -> dict[str, Any]:
        path = f"/mail/view/{message_id}"
        if context and context.get("gmail"):
            path += "/gmail"
        resp = session.get(f"{BASE}{path}", headers=HTML_HEADERS, timeout=45)
        _check(resp)
        text = resp.text or ""
        match = BODY_RE.search(text)
        if not match:
            raise ProviderError("未能从详情页解析出正文，站点可能改版", code="parse_error", status=502)
        body_html = _decode_email_html(match.group(1))
        return {
            "id": message_id,
            "body_html": body_html,
            "body_text": html_to_text(body_html),
            "attachments": [],
            "raw_available": False,
            "can_download_attachments": False,
        }

    def delete_message(self, session, box, message_id) -> None:
        resp = session.post(
            f"{BASE}/mail/delete/{message_id}",
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        data = _json(resp)
        if not data.get("success"):
            raise ProviderError(data.get("error") or "删除失败", code="upstream_error", status=502)
