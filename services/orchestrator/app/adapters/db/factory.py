from __future__ import annotations

from app.config import Settings

from .base import Repository


def get_repository(settings: Settings) -> Repository:
    match settings.db_engine:
        case "sqlite":
            from .sqlite_repo import SqliteRepository

            return SqliteRepository(settings.sqlite_path)
        case "postgres":
            from .postgres_repo import PostgresRepository

            return PostgresRepository(settings.postgres_dsn)
        case other:  # pragma: no cover - pydantic validates the literal
            raise ValueError(f"Unknown db_engine: {other}")
