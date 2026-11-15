"""邮箱运行时管理：内存 Session + SQLite 持久化。"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

from curl_cffi import requests

from .database import Database
from .providers.base import BoxState, ProviderError
from .providers.registry import get_provider

T = TypeVar("T")


def _build_http(cookies: dict[str, str] | None = None) -> requests.Session:
    http = requests.Session(impersonate="chrome")
    http.headers.update(
        {
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
    )
    if cookies:
        for name, value in cookies.items():
            try:
                http.cookies.set(name, value)
            except Exception:  # noqa: BLE001
                continue
    return http


@dataclass
class Runtime:
    handle: str
    provider_id: str
    provider: Any
    box: BoxState
    http: requests.Session
    created_at: int
    lock: threading.Lock

    def cookies_dict(self) -> dict[str, str]:
        try:
            return {k: v for k, v in self.http.cookies.get_dict().items()}
        except Exception:  # noqa: BLE001
            return {}


class SessionManager:
    def __init__(self, db: Database):
        self.db = db
        self._runtimes: dict[str, Runtime] = {}
        self._lock = threading.Lock()

    # ---------- 创建 / 获取 ----------

    def create(self, provider_id: str, name: str | None, domain: str | None) -> Runtime:
        provider = get_provider(provider_id)
        if not provider:
            raise ProviderError("未知的平台", code="unknown_provider", status=400)

        http = _build_http()
        try:
            box = provider.create(http, name, domain)
            if domain and provider.supports_domain_switch:
                box = provider.change_domain(http, box, domain)
        except Exception:
            http.close()
            raise

        handle = uuid.uuid4().hex
        now = int(time.time())
        runtime = Runtime(
            handle=handle,
            provider_id=provider_id,
            provider=provider,
            box=box,
            http=http,
            created_at=now,
            lock=threading.Lock(),
        )
        self.db.insert(
            handle=handle,
            provider=provider_id,
            address=box.address,
            token=box.token,
            extra=box.extra,
            cookies=runtime.cookies_dict(),
        )
        with self._lock:
            self._runtimes[handle] = runtime
        return runtime

    def get(self, handle: str) -> Runtime:
        with self._lock:
            runtime = self._runtimes.get(handle)
        if runtime:
            return runtime

        row = self.db.get(handle)
        if not row:
            raise ProviderError("邮箱不存在或已被清理", code="mailbox_not_found", status=404)
        provider = get_provider(row["provider"])
        if not provider:
            raise ProviderError("该平台已下线", code="unknown_provider", status=400)

        runtime = Runtime(
            handle=handle,
            provider_id=row["provider"],
            provider=provider,
            box=BoxState(
                address=row["address"],
                token=row.get("token"),
                extra=row.get("extra") or {},
            ),
            http=_build_http(row.get("cookies") or {}),
            created_at=int(row["created_at"]),
            lock=threading.Lock(),
        )
        with self._lock:
            self._runtimes[handle] = runtime
        return runtime

    def call(self, runtime: Runtime, fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        """串行化同一邮箱的上游请求，并回写 Cookie。"""
        with runtime.lock:
            try:
                result = fn(runtime.http, runtime.box, *args, **kwargs)
            finally:
                self._save_cookies(runtime)
        return result

    def change_domain(self, runtime: Runtime, domain: str) -> BoxState:
        with runtime.lock:
            try:
                box = runtime.provider.change_domain(runtime.http, runtime.box, domain)
                runtime.box = box
                self.db.update_box(runtime.handle, box.address, box.token, box.extra)
            finally:
                self._save_cookies(runtime)
        return box

    def remove(self, handle: str) -> None:
        with self._lock:
            runtime = self._runtimes.pop(handle, None)
        if runtime:
            try:
                runtime.http.close()
            except Exception:  # noqa: BLE001
                pass
        self.db.delete(handle)

    def list_mailboxes(self) -> list[dict[str, Any]]:
        result = []
        for row in self.db.list():
            provider = get_provider(row["provider"])
            result.append(
                {
                    "handle": row["handle"],
                    "provider": row["provider"],
                    "provider_name": provider.name if provider else row["provider"],
                    "accent": provider.accent if provider else "#64748b",
                    "address": row["address"],
                    "created_at": int(row["created_at"]),
                    "last_used_at": int(row["last_used_at"]),
                    "can_delete": bool(provider and provider.supports_delete),
                }
            )
        return result

    def _save_cookies(self, runtime: Runtime) -> None:
        try:
            self.db.update_cookies(runtime.handle, runtime.cookies_dict())
        except Exception:  # noqa: BLE001
            pass


def mailbox_payload(runtime: Runtime) -> dict[str, Any]:
    provider = runtime.provider
    return {
        "handle": runtime.handle,
        "provider": runtime.provider_id,
        "provider_name": provider.name,
        "address": runtime.box.address,
        "created_at": runtime.created_at,
        "capabilities": provider.capabilities(),
    }
