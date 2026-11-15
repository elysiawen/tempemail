"""平台适配层公共定义：统一错误、邮箱状态、文本归一化工具。"""

from __future__ import annotations

import html as html_lib
import json
import re
from dataclasses import dataclass, field
from typing import Any


class ProviderError(Exception):
    """可预期的上游错误，会被 main.py 转成结构化 JSON。"""

    def __init__(self, message: str, *, code: str = "provider_error", status: int = 502):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


@dataclass
class BoxState:
    """一个临时邮箱在平台侧的最小状态。"""

    address: str
    token: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class BaseProvider:
    """所有平台适配器的统一接口，不支持的操作用默认实现报错。"""

    id: str = ""
    name: str = ""
    site: str = ""
    accent: str = "#6366f1"
    tagline: str = ""

    supports_name: bool = False
    supports_domain: bool = False
    supports_domain_switch: bool = False
    supports_delete: bool = False
    supports_eml: bool = False
    supports_attachments: bool = False

    poll_interval_ms: int = 8000
    suggest_auto_refresh: bool = True
    note: str = ""

    # ---------- 元信息 ----------

    def capabilities(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "site": self.site,
            "accent": self.accent,
            "tagline": self.tagline,
            "custom_name": self.supports_name,
            "custom_domain": self.supports_domain,
            "domain_switch": self.supports_domain_switch,
            "delete_mailbox": self.supports_delete,
            "eml": self.supports_eml,
            "attachments": self.supports_attachments,
            "poll_interval_ms": self.poll_interval_ms,
            "auto_refresh": self.suggest_auto_refresh,
            "note": self.note,
        }

    # ---------- 邮箱生命周期 ----------

    def create(self, session, name: str | None = None, domain: str | None = None) -> BoxState:
        raise ProviderError("该平台不支持创建邮箱", code="unsupported", status=400)

    def change_domain(self, session, box: BoxState, domain: str) -> BoxState:
        raise ProviderError("该平台不支持更换域名", code="unsupported", status=400)

    def delete_mailbox(self, session, box: BoxState) -> None:
        raise ProviderError("该平台不提供删除邮箱接口", code="unsupported", status=400)

    def list_domains(self) -> list[dict[str, Any]]:
        return []

    # ---------- 邮件 ----------

    def list_messages(self, session, box: BoxState) -> list[dict[str, Any]]:
        raise ProviderError("该平台不支持读取邮件列表", code="unsupported", status=400)

    def get_message(
        self,
        session,
        box: BoxState,
        message_id: str,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raise ProviderError("该平台不支持读取邮件详情", code="unsupported", status=400)

    def delete_message(self, session, box: BoxState, message_id: str) -> None:
        raise ProviderError("该平台不支持删除邮件", code="unsupported", status=400)

    def get_raw(self, session, box: BoxState, message_id: str) -> tuple[bytes, str]:
        raise ProviderError("该平台不支持导出 EML", code="unsupported", status=400)

    def get_attachment(
        self, session, box: BoxState, message_id: str, attachment_id: str
    ) -> tuple[bytes, str, str]:
        raise ProviderError("该平台不支持附件下载", code="unsupported", status=400)


# ---------- 工具函数 ----------

_SENDER_RE = re.compile(r'^\s*(?:"?(?P<name>[^"<]*?)"?\s*)?<(?P<email>[^>]+)>\s*$')
_SCRIPT_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S | re.I)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t\r\f\v]+")
_CONTENT_DISPOSITION_RE = re.compile(
    r"filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?", re.I
)


def split_sender(raw: str) -> tuple[str, str]:
    """把 `"名字" <地址>` 拆成 (显示名, 邮箱)。"""
    raw = (raw or "").strip()
    match = _SENDER_RE.match(raw)
    if match:
        email = match.group("email").strip()
        name = (match.group("name") or "").strip() or email
        return name, email
    if "@" in raw:
        return raw, raw
    return raw, ""


def normalize_html_body(value: str) -> str:
    """部分平台会把 HTML 再 JSON 转义一层，这里还原；正常 HTML 原样返回。"""
    if not value:
        return ""
    text = value.strip()
    escaped_tags = text.count("\\u003c")
    if escaped_tags < 3 or "<" in text:
        return text
    try:
        return json.loads(f'"{text}"')
    except Exception:  # noqa: BLE001
        text = re.sub(
            r"\\u([0-9a-fA-F]{4})",
            lambda match: chr(int(match.group(1), 16)),
            text,
        )
        return (
            text.replace("\\/", "/")
            .replace('\\"', '"')
            .replace("\\n", "\n")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
        )


def html_to_text(html: str) -> str:
    """粗略把 HTML 正文转成纯文本，用于前端「纯文本」视图。"""
    if not html:
        return ""
    text = _SCRIPT_RE.sub(" ", html)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|tr|li|h[1-6]|blockquote)>", "\n", text, flags=re.I)
    text = re.sub(r"</t[dh]>", " ", text, flags=re.I)
    text = _TAG_RE.sub(" ", text)
    text = html_lib.unescape(text)
    text = _WS_RE.sub(" ", text)
    text = re.sub(r"[ \t]*\n[ \t]*", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def filename_from_headers(headers: Any, fallback: str) -> str:
    value = headers.get("content-disposition") or headers.get("Content-Disposition") or ""
    match = _CONTENT_DISPOSITION_RE.search(value)
    if not match:
        return fallback
    name = match.group(1).strip()
    try:
        from urllib.parse import unquote

        return unquote(name) or fallback
    except Exception:
        return name or fallback
