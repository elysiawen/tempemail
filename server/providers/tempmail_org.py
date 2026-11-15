"""temp-mail.org —— 后端 https://web2.temp-mail.org，JWT 鉴权。"""

from __future__ import annotations

from typing import Any

from .base import (
    BaseProvider,
    BoxState,
    ProviderError,
    filename_from_headers,
    html_to_text,
    normalize_html_body,
    split_sender,
)

API = "https://web2.temp-mail.org"
JSON_HEADERS = {
    "Origin": "https://temp-mail.org",
    "Referer": "https://temp-mail.org/",
    "Content-Type": "application/json",
}


def _check(resp) -> None:
    status = resp.status_code
    if status < 400:
        return
    if status == 401:
        raise ProviderError("邮箱会话已失效，请重新创建邮箱", code="unauthorized", status=401)
    if status == 403:
        raise ProviderError("请求被 Cloudflare 拦截，请稍后重试", code="cloudflare_blocked", status=502)
    if status == 410:
        raise ProviderError("邮件不存在或已被删除", code="message_gone", status=404)
    if status == 429:
        raise ProviderError("该平台请求过于频繁，请稍后再试", code="rate_limited", status=429)
    raise ProviderError(f"平台返回错误（HTTP {status}）", code="upstream_error", status=502)


def _json(resp) -> dict[str, Any]:
    _check(resp)
    try:
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise ProviderError("平台返回了无法解析的响应", code="bad_response", status=502) from exc
    if not isinstance(data, dict):
        raise ProviderError("平台返回了意外的数据结构", code="bad_response", status=502)
    return data


def _summary(item: dict[str, Any]) -> dict[str, Any]:
    from_raw = item.get("from") or ""
    name, email = split_sender(from_raw)
    return {
        "id": item.get("_id") or item.get("id") or "",
        "from": from_raw,
        "from_name": name,
        "from_email": email,
        "subject": item.get("subject") or "(无主题)",
        "preview": (item.get("bodyPreview") or "").strip(),
        "received_at": int(item.get("receivedAt") or 0),
        "attachments_count": int(item.get("attachmentsCount") or 0),
        "is_read": None,
        "has_html": True,
        "gmail": False,
    }


def _attachments(item: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for att in item.get("attachments") or []:
        result.append(
            {
                "id": att.get("attachmentId") or att.get("id") or "",
                "name": att.get("filename") or att.get("name") or "attachment",
                "size": int(att.get("size") or 0),
                "type": att.get("mimeType") or att.get("type") or "application/octet-stream",
            }
        )
    return result


class Provider(BaseProvider):
    id = "tempmail_org"
    name = "temp-mail.org"
    site = "https://temp-mail.org"
    accent = "#2dd4bf"
    tagline = "JWT 会话 · EML 导出"

    supports_name = False
    supports_domain = False
    supports_domain_switch = False
    supports_delete = False
    supports_eml = True
    supports_attachments = True

    poll_interval_ms = 6000
    suggest_auto_refresh = True
    note = "创建后邮箱由平台随机分配，不能自定义前缀或域名。"

    def create(self, session, name=None, domain=None) -> BoxState:
        resp = session.post(f"{API}/mailbox", headers=JSON_HEADERS, timeout=30)
        data = _json(resp)
        address = data.get("mailbox")
        token = data.get("token")
        if not address or not token:
            raise ProviderError("平台未能返回有效邮箱", code="bad_response", status=502)
        return BoxState(address=address, token=token)

    def list_messages(self, session, box: BoxState) -> list[dict[str, Any]]:
        resp = session.get(
            f"{API}/messages",
            headers={"Authorization": f"Bearer {box.token}"},
            timeout=30,
        )
        data = _json(resp)
        return [_summary(item) for item in data.get("messages") or []]

    def get_message(self, session, box, message_id, context=None) -> dict[str, Any]:
        resp = session.get(
            f"{API}/messages/{message_id}",
            headers={"Authorization": f"Bearer {box.token}"},
            timeout=30,
        )
        data = _json(resp)
        detail = _summary(data)
        body_html = normalize_html_body(data.get("bodyHtml") or "")
        body_text = html_to_text(body_html) or (data.get("bodyPreview") or "").strip()
        detail.update(
            {
                "body_html": body_html,
                "body_text": body_text,
                "attachments": _attachments(data),
                "raw_available": True,
                "can_download_attachments": True,
            }
        )
        return detail

    def delete_message(self, session, box, message_id) -> None:
        resp = session.delete(
            f"{API}/messages/{message_id}",
            headers={"Authorization": f"Bearer {box.token}"},
            timeout=30,
        )
        _check(resp)

    def get_raw(self, session, box, message_id) -> tuple[bytes, str]:
        resp = session.get(
            f"{API}/messages/{message_id}/source",
            headers={"Authorization": f"Bearer {box.token}"},
            timeout=30,
        )
        _check(resp)
        return resp.content, f"{message_id}.eml"

    def get_attachment(self, session, box, message_id, attachment_id) -> tuple[bytes, str, str]:
        resp = session.get(
            f"{API}/messages/{message_id}/attachment/{attachment_id}",
            headers={"Authorization": f"Bearer {box.token}"},
            timeout=60,
        )
        _check(resp)
        content_type = resp.headers.get("content-type") or "application/octet-stream"
        filename = filename_from_headers(resp.headers, attachment_id)
        return resp.content, filename, content_type
