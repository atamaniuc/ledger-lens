"""Loopback-guarded test database helper (mirrors tests/helpers/db.ts).

These tests write — inside transactions that are always rolled back — so the
helper refuses to touch anything but a database on this machine. The host is
parsed and matched exactly rather than searched for as a substring, exactly
like the TS helper.
"""

from __future__ import annotations

import os
import re

import psycopg

DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DB_URL = os.environ.get("DB_URL", DEFAULT_DB_URL)


def assert_loopback(url: str) -> None:
    scheme = re.match(r"^postgres(ql)?://", url)
    if not scheme:
        raise RuntimeError(f"DB_URL is not a postgres:// URL, refusing to touch it: {url}")
    authority = url[scheme.end() :].split("/")[0].split("?")[0]
    host_port = authority.rsplit("@", 1)[-1]
    if host_port.startswith("["):
        host = host_port[1 : host_port.index("]")]
    else:
        host = host_port.split(":")[0]
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise RuntimeError(
            f"DB_URL host '{host}' is not loopback. These tests write "
            "and are for the local stack only."
        )


assert_loopback(DB_URL)


def connect_db() -> psycopg.Connection:
    return psycopg.connect(DB_URL)
