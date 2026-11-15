"""temp-mail.io —— 后端 https://api.internal.temp-mail.io/api，基本无鉴权。"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any
from urllib.parse import quote

from .base import (
    BaseProvider,
    BoxState,
    ProviderError,
    filename_from_headers,
    html_to_text,
    normalize_html_body,
    split_sender,
)

API = "https://api.internal.temp-mail.io/api"
JSON_HEADERS = {
    "Origin": "https://temp-mail.io",
    "Referer": "https://temp-mail.io/",
    "Content-Type": "application/json",
    "application-name": "web",
    "application-version": "4.0.0",
}


def _check(resp) -> None:
    status = resp.status_code
    if status < 400:
        return
    payload: dict[str, Any] = {}
    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {}
    code = payload.get("code")
    message = payload.get("message") or ""
    if code == 101 or message == "Email not found":
        raise ProviderError("邮箱已失效或被平台回收，请新建邮箱", code="mailbox_gone", status=404)
    if code == 102 or message == "Attachment not found":
        raise ProviderError("附件不存在或已过期", code="attachment_gone", status=404)
    if code == 106:
        raise ProviderError("删除凭证无效，请重新创建邮箱", code="token_invalid", status=401)
    if status == 404 or "message not found" in message:
        raise ProviderError("邮件不存在或已被删除", code="message_gone", status=404)
    if status == 415:
        raise ProviderError("平台拒绝了请求格式", code="bad_request", status=400)
    if status == 429:
        raise ProviderError("该平台请求过于频繁，请稍后再试", code="rate_limited", status=429)
    if status == 403:
        raise ProviderError("请求被平台拦截，请稍后重试", code="cloudflare_blocked", status=502)
    detail = message or f"HTTP {status}"
    raise ProviderError(f"平台返回错误：{detail}", code="upstream_error", status=502)


def _json(resp):
    _check(resp)
    try:
        return resp.json()
    except Exception as exc:  # noqa: BLE001
        raise ProviderError("平台返回了无法解析的响应", code="bad_response", status=502) from exc


def _epoch(value: str | None) -> int:
    if not value:
        return 0
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return int(parsed.timestamp())
    except Exception:  # noqa: BLE001
        return 0


def _attachments(item: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for att in item.get("attachments") or []:
        result.append(
            {
                "id": att.get("id") or "",
                "name": att.get("name") or "attachment",
                "size": int(att.get("size") or 0),
                "type": att.get("type") or "application/octet-stream",
            }
        )
    return result


def _summary(item: dict[str, Any]) -> dict[str, Any]:
    from_raw = item.get("from") or ""
    name, email = split_sender(from_raw)
    body_text = item.get("body_text") or html_to_text(normalize_html_body(item.get("body_html") or ""))
    preview = " ".join(body_text.split())[:180]
    return {
        "id": item.get("id") or "",
        "from": from_raw,
        "from_name": name,
        "from_email": email,
        "subject": item.get("subject") or "(无主题)",
        "preview": preview,
        "received_at": _epoch(item.get("created_at")),
        "attachments_count": len(item.get("attachments") or []),
        "is_read": None,
        "has_html": bool(item.get("body_html")),
        "gmail": False,
    }


class Provider(BaseProvider):
    id = "tempmail_io"
    name = "temp-mail.io"
    site = "https://temp-mail.io/zh"
    accent = "#a78bfa"
    tagline = "自定义前缀/域名 · 正文直出"

    supports_name = True
    supports_domain = True
    supports_domain_switch = False
    supports_delete = True
    supports_eml = True
    supports_attachments = True

    poll_interval_ms = 9000
    suggest_auto_refresh = True
    note = "支持自定义前缀和域名；删除整箱受平台隐性配额影响，可能失败。"

    def create(self, session, name=None, domain=None) -> BoxState:
        payload: dict[str, Any] = {}
        if name:
            payload["name"] = name
        else:
            payload["min_name_length"] = 10
            payload["max_name_length"] = 10
        if domain:
            payload["domain"] = domain

        resp = session.post(
            f"{API}/v3/email/new",
            data=json.dumps(payload),
            headers=JSON_HEADERS,
            timeout=30,
        )
        data = _json(resp)
        address = data.get("email")
        token = data.get("token")
        if not address:
            raise ProviderError("平台未能返回有效邮箱", code="bad_response", status=502)
        return BoxState(address=address, token=token)

    def list_messages(self, session, box: BoxState) -> list[dict[str, Any]]:
        resp = session.get(
            f"{API}/v3/email/{quote(box.address, safe='@')}/messages",
            timeout=30,
        )
        data = _json(resp)
        if not isinstance(data, list):
            raise ProviderError("平台返回了意外的邮件列表结构", code="bad_response", status=502)
        return [_summary(item) for item in data]

    def get_message(self, session, box, message_id, context=None) -> dict[str, Any]:
        resp = session.get(f"{API}/v3/message/{message_id}", timeout=30)
        data = _json(resp)
        detail = _summary(data)
        body_html = normalize_html_body(data.get("body_html") or "")
        detail.update(
            {
                "body_html": body_html,
                "body_text": data.get("body_text") or html_to_text(body_html),
                "attachments": _attachments(data),
                "raw_available": True,
                "can_download_attachments": True,
            }
        )
        return detail

    def delete_message(self, session, box, message_id) -> None:
        resp = session.request(
            "DELETE",
            f"{API}/v3/message/{message_id}",
            data=json.dumps({"token": box.token}),
            headers=JSON_HEADERS,
            timeout=30,
        )
        _check(resp)

    def delete_mailbox(self, session, box) -> None:
        resp = session.request(
            "DELETE",
            f"{API}/v3/email/{quote(box.address, safe='@')}",
            data=json.dumps({"token": box.token}),
            headers=JSON_HEADERS,
            timeout=30,
        )
        _check(resp)

    def get_raw(self, session, box, message_id) -> tuple[bytes, str]:
        resp = session.get(
            f"{API}/v3/message/{message_id}/source_code",
            params={"download": 1},
            timeout=30,
        )
        _check(resp)
        return resp.content, f"{message_id}.eml"

    def get_attachment(self, session, box, message_id, attachment_id) -> tuple[bytes, str, str]:
        resp = session.get(
            f"{API}/v3/attachment/{attachment_id}",
            params={"download": 1},
            timeout=60,
        )
        _check(resp)
        content_type = resp.headers.get("content-type") or "application/octet-stream"
        filename = filename_from_headers(resp.headers, attachment_id)
        return resp.content, filename, content_type

    def list_domains(self) -> list[dict[str, Any]]:
        from curl_cffi import requests

        session = requests.Session(impersonate="chrome")
        try:
            resp = session.get(f"{API}/v4/domains", timeout=30)
            data = _json(resp)
        finally:
            session.close()
        return [
            {
                "domain": item.get("name") or "",
                "type": item.get("type") or "public",
                "vip": False,
            }
            for item in data.get("domains") or []
            if item.get("name")
        ]
