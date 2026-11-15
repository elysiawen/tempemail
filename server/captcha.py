"""linshiyouxiang.net 的 4 位图形验证码：交给用户手动输入，不做自动识别。"""

from __future__ import annotations

import base64
import threading
import time
import uuid

from curl_cffi import requests

from .providers.base import ProviderError

BASE = "https://www.linshiyouxiang.net"
RETURN_URL = f"{BASE}/"
TTL = 300

_lock = threading.Lock()
_challenges: dict[str, tuple[requests.Session, float]] = {}


def _purge() -> None:
    now = time.time()
    expired = [cid for cid, (_, created) in _challenges.items() if now - created > TTL]
    for challenge_id in expired:
        session, _ = _challenges.pop(challenge_id)
        try:
            session.close()
        except Exception:  # noqa: BLE001
            pass


def start_challenge() -> dict[str, str]:
    session = requests.Session(impersonate="chrome")
    session.headers.update({"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"})
    try:
        page = session.get(
            f"{BASE}/rate-captcha/page",
            params={"return_url": RETURN_URL},
            timeout=30,
        )
        if page.status_code >= 400:
            raise ProviderError("无法打开验证码页面，请稍后重试", code="captcha_error", status=502)

        image = session.get(f"{BASE}/rate-captcha/image", timeout=30)
        content_type = image.headers.get("content-type") or "image/svg+xml"
        if image.status_code != 200 or not image.content or "image" not in content_type:
            raise ProviderError("验证码图片获取失败，请换一张", code="captcha_error", status=502)

        challenge_id = uuid.uuid4().hex
        encoded = base64.b64encode(image.content).decode("ascii")
        with _lock:
            _purge()
            _challenges[challenge_id] = (session, time.time())
        return {"id": challenge_id, "image": f"data:{content_type};base64,{encoded}"}
    except ProviderError:
        session.close()
        raise
    except Exception as exc:  # noqa: BLE001
        session.close()
        raise ProviderError("获取验证码超时，请稍后重试", code="network_error", status=504) from exc


def solve_challenge(challenge_id: str, answer: str) -> None:
    answer = (answer or "").strip()
    if not answer.isdigit() or len(answer) != 4:
        raise ProviderError("请输入图中 4 位数字", code="captcha_invalid", status=400)

    with _lock:
        _purge()
        entry = _challenges.get(challenge_id)
        if not entry:
            raise ProviderError("验证码已过期，请换一张", code="captcha_expired", status=400)
        session, _ = entry

    try:
        response = session.post(
            f"{BASE}/rate-captcha/verify",
            data={"captcha": answer, "return_url": RETURN_URL},
            allow_redirects=False,
            timeout=30,
        )
        location = response.headers.get("location") or ""
        success = (
            response.status_code in (301, 302, 303)
            and "error=1" not in location
            and "rate-captcha" not in location
        )
        with _lock:
            _challenges.pop(challenge_id, None)
        session.close()
        if not success:
            raise ProviderError("验证码不正确，请重试", code="captcha_invalid", status=400)
    except ProviderError:
        raise
    except Exception as exc:  # noqa: BLE001
        session.close()
        raise ProviderError("提交验证码超时，请重试", code="network_error", status=504) from exc
