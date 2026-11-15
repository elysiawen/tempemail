"""平台注册表。"""

from __future__ import annotations

from . import linshiyouxiang, tempmail_io, tempmail_org
from .base import BaseProvider

PROVIDERS: dict[str, BaseProvider] = {
    provider.id: provider
    for provider in (
        tempmail_org.Provider(),
        tempmail_io.Provider(),
        linshiyouxiang.Provider(),
    )
}


def get_provider(provider_id: str) -> BaseProvider | None:
    return PROVIDERS.get(provider_id)


def all_providers() -> list[BaseProvider]:
    return list(PROVIDERS.values())
