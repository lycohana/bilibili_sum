import sqlite3
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse


def sqlite_path_from_url(database_url: str) -> Path:
    if database_url.startswith("sqlite:///"):
        return Path(database_url.removeprefix("sqlite:///"))
    parsed = urlparse(database_url)
    if parsed.scheme == "sqlite":
        return Path(parsed.path.lstrip("/"))
    raise ValueError(f"Unsupported database url: {database_url}")


def connect_sqlite(database_url: str) -> sqlite3.Connection:
    path = sqlite_path_from_url(database_url)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    return connection


@contextmanager
def sqlite_cursor(connection: sqlite3.Connection):
    cursor = connection.cursor()
    try:
        yield cursor
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        cursor.close()
