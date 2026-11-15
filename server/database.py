"""SQLite 持久化：邮箱会话（含 Cookie）与历史记录。"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS mailboxes (
    handle       TEXT PRIMARY KEY,
    provider     TEXT NOT NULL,
    address      TEXT NOT NULL,
    token        TEXT,
    extra        TEXT NOT NULL DEFAULT '{}',
    cookies      TEXT NOT NULL DEFAULT '{}',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mailboxes_last_used ON mailboxes(last_used_at DESC);
"""


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def _run(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Cursor:
        with self._lock:
            cursor = self._conn.execute(sql, params)
            self._conn.commit()
            return cursor

    def insert(
        self,
        handle: str,
        provider: str,
        address: str,
        token: str | None,
        extra: dict[str, Any],
        cookies: dict[str, str],
    ) -> None:
        now = int(time.time())
        self._run(
            """
            INSERT INTO mailboxes (handle, provider, address, token, extra, cookies, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                handle,
                provider,
                address,
                token,
                json.dumps(extra, ensure_ascii=False),
                json.dumps(cookies, ensure_ascii=False),
                now,
                now,
            ),
        )

    def get(self, handle: str) -> dict[str, Any] | None:
        cursor = self._run("SELECT * FROM mailboxes WHERE handle = ?", (handle,))
        row = cursor.fetchone()
        return self._row_to_dict(row) if row else None

    def list(self) -> list[dict[str, Any]]:
        cursor = self._run("SELECT * FROM mailboxes ORDER BY last_used_at DESC")
        return [self._row_to_dict(row) for row in cursor.fetchall()]

    def delete(self, handle: str) -> None:
        self._run("DELETE FROM mailboxes WHERE handle = ?", (handle,))

    def update_cookies(self, handle: str, cookies: dict[str, str]) -> None:
        self._run(
            "UPDATE mailboxes SET cookies = ?, last_used_at = ? WHERE handle = ?",
            (json.dumps(cookies, ensure_ascii=False), int(time.time()), handle),
        )

    def update_box(self, handle: str, address: str, token: str | None, extra: dict[str, Any]) -> None:
        self._run(
            "UPDATE mailboxes SET address = ?, token = ?, extra = ?, last_used_at = ? WHERE handle = ?",
            (
                address,
                token,
                json.dumps(extra, ensure_ascii=False),
                int(time.time()),
                handle,
            ),
        )

    def touch(self, handle: str) -> None:
        self._run("UPDATE mailboxes SET last_used_at = ? WHERE handle = ?", (int(time.time()), handle))

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        for key, fallback in (("extra", {}), ("cookies", {})):
            try:
                data[key] = json.loads(data.get(key) or "{}")
            except Exception:  # noqa: BLE001
                data[key] = fallback
        return data
