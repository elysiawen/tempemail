"""MailHub —— 临时邮箱聚合台后端入口。"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    from curl_cffi.requests.exceptions import RequestException
except ImportError:  # curl_cffi 新版把它命名为 RequestsException
    from curl_cffi.requests.exceptions import RequestsException as RequestException

from .captcha import solve_challenge, start_challenge
from .database import Database
from .providers.base import ProviderError
from .providers.registry import all_providers, get_provider
from .sessions import SessionManager, mailbox_payload

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("mailhub")

app = FastAPI(title="MailHub", version="1.0.0", docs_url="/api/docs", redoc_url=None)

db = Database(DATA_DIR / "mailhub.db")
manager = SessionManager(db)


# ---------- 请求模型 ----------


class CreateMailboxRequest(BaseModel):
    provider: str
    name: str | None = None
    domain: str | None = None


class ChangeDomainRequest(BaseModel):
    domain: str


class CaptchaSolveRequest(BaseModel):
    id: str
    answer: str


# ---------- 错误处理 ----------


@app.exception_handler(ProviderError)
async def provider_error_handler(request: Request, exc: ProviderError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


@app.exception_handler(RequestException)
async def network_error_handler(request: Request, exc: RequestException) -> JSONResponse:
    logger.warning("上游网络异常 %s: %s", request.url.path, exc)
    return JSONResponse(
        status_code=504,
        content={"error": {"code": "network_error", "message": "连接平台超时或网络异常，请稍后重试"}},
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("未处理的异常: %s", exc)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "internal_error", "message": "服务器内部错误，请查看后端日志"}},
    )


@app.middleware("http")
async def no_store_api(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


# ---------- 平台元信息 ----------


@app.get("/api/providers")
def list_providers() -> dict[str, Any]:
    return {"providers": [provider.capabilities() for provider in all_providers()]}


@app.get("/api/domains/{provider_id}")
def list_domains(provider_id: str) -> dict[str, Any]:
    provider = get_provider(provider_id)
    if not provider:
        raise ProviderError("未知的平台", code="unknown_provider", status=404)
    if not (provider.supports_domain or provider.supports_domain_switch):
        return {"domains": [], "supports_switch": False}
    return {
        "domains": provider.list_domains(),
        "supports_switch": provider.supports_domain_switch,
    }


# ---------- 人机验证（用户手动输入） ----------


@app.get("/api/captcha")
def get_captcha() -> dict[str, Any]:
    return start_challenge()


@app.post("/api/captcha/verify")
def verify_captcha(payload: CaptchaSolveRequest) -> dict[str, Any]:
    solve_challenge(payload.id, payload.answer)
    return {"success": True}


# ---------- 邮箱 ----------


@app.get("/api/mailboxes")
def list_mailboxes() -> dict[str, Any]:
    return {"mailboxes": manager.list_mailboxes()}


@app.post("/api/mailboxes")
def create_mailbox(payload: CreateMailboxRequest) -> dict[str, Any]:
    name = (payload.name or "").strip() or None
    domain = (payload.domain or "").strip() or None
    runtime = manager.create(payload.provider, name, domain)
    data = mailbox_payload(runtime)
    data["capabilities"] = runtime.provider.capabilities()
    return data


@app.delete("/api/mailboxes/{handle}")
def delete_mailbox(handle: str, local_only: bool = Query(default=False)) -> dict[str, Any]:
    runtime = manager.get(handle)
    if not local_only:
        if not runtime.provider.supports_delete:
            raise ProviderError(
                "该平台不提供删除邮箱接口，邮箱会由平台自动过期回收",
                code="unsupported",
                status=400,
            )
        manager.call(runtime, runtime.provider.delete_mailbox)
    manager.remove(handle)
    return {"success": True}


@app.post("/api/mailboxes/{handle}/change-domain")
def change_domain(handle: str, payload: ChangeDomainRequest) -> dict[str, Any]:
    runtime = manager.get(handle)
    domain = payload.domain.strip()
    if not domain:
        raise ProviderError("请选择要切换的域名", code="bad_request", status=400)
    box = manager.change_domain(runtime, domain)
    data = mailbox_payload(runtime)
    data["address"] = box.address
    return data


# ---------- 邮件 ----------


@app.get("/api/mailboxes/{handle}/messages")
def list_messages(handle: str) -> dict[str, Any]:
    runtime = manager.get(handle)
    messages = manager.call(runtime, runtime.provider.list_messages)
    db.touch(handle)
    return {
        "mailbox": runtime.box.address,
        "messages": messages,
        "fetched_at": time.time(),
    }


@app.get("/api/mailboxes/{handle}/messages/{message_id}")
def get_message(
    handle: str,
    message_id: str,
    gmail: bool = Query(default=False),
) -> dict[str, Any]:
    runtime = manager.get(handle)
    detail = manager.call(
        runtime,
        runtime.provider.get_message,
        message_id,
        {"gmail": gmail},
    )
    db.touch(handle)
    return {"message": detail}


@app.delete("/api/mailboxes/{handle}/messages/{message_id}")
def delete_message(handle: str, message_id: str) -> dict[str, Any]:
    runtime = manager.get(handle)
    manager.call(runtime, runtime.provider.delete_message, message_id)
    db.touch(handle)
    return {"success": True}


@app.get("/api/mailboxes/{handle}/messages/{message_id}/eml")
def download_eml(handle: str, message_id: str) -> Response:
    runtime = manager.get(handle)
    content, filename = manager.call(runtime, runtime.provider.get_raw, message_id)
    return _binary_response(content, filename, "message/rfc822")


@app.get("/api/mailboxes/{handle}/messages/{message_id}/attachments/{attachment_id}")
def download_attachment(handle: str, message_id: str, attachment_id: str) -> Response:
    runtime = manager.get(handle)
    content, filename, content_type = manager.call(
        runtime,
        runtime.provider.get_attachment,
        message_id,
        attachment_id,
    )
    return _binary_response(content, filename, content_type)


def _binary_response(content: bytes, filename: str, content_type: str) -> Response:
    safe_ascii = filename.encode("ascii", "ignore").decode().strip() or "download"
    encoded = quote(filename)
    headers = {
        "Content-Disposition": f"attachment; filename=\"{safe_ascii}\"; filename*=UTF-8''{encoded}",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
    }
    return Response(content=content, media_type=content_type, headers=headers)


# ---------- 静态前端 ----------


app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server.main:app", host="127.0.0.1", port=8000, reload=False)
