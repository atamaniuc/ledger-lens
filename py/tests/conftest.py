import psycopg
import pytest
from db import DB_URL, connect_db
from psycopg.rows import dict_row


@pytest.fixture(scope="session")
def db_reachable() -> bool:
    try:
        conn = connect_db()
        conn.close()
        return True
    except psycopg.Error:
        return False


@pytest.fixture
def conn(db_reachable):
    if not db_reachable:
        pytest.skip("local Supabase database is not reachable; DB tests skipped")
    with psycopg.connect(DB_URL, row_factory=dict_row) as conn:
        yield conn


@pytest.fixture
def tx(conn):
    """A connection whose every write is rolled back before the test ends.

    Mirrors the whatIf() pattern in tests/helpers/db.ts: mutations happen
    inside a transaction that never commits. These tests never truncate and
    never touch seeded tenants — they create a throwaway org per test.
    """
    try:
        yield conn
    finally:
        conn.rollback()
