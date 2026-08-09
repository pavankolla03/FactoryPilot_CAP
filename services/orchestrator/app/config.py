"""Runtime configuration.

Every adapter choice in the production-close matrix (ADR-005/006/007/012) is a
value here, never an import in business logic. Switching a client from Postgres
to HANA or OpenRouter to AI Core is an env change, not a code change.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- identity -----------------------------------------------------------
    # `dev` trusts X-User-Id / X-User-Roles headers behind the Approuter and is
    # for local work only. `xsuaa` (JWKS validation) is Day 13 of the plan.
    auth_mode: Literal["dev", "xsuaa"] = "dev"
    dev_default_user: str = "bob"
    dev_default_roles: str = "BusinessUser,InsightsQuery,InsightsReadOwnUsage"

    # --- LLM ----------------------------------------------------------------
    llm_provider: Literal["openrouter", "aicore", "fake"] = "fake"
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_model: str = "anthropic/claude-sonnet-4.5"
    aicore_base_url: str = ""
    aicore_deployment_id: str = ""
    aicore_client_id: str = ""
    aicore_client_secret: str = ""
    aicore_token_url: str = ""
    llm_max_tokens: int = 800
    llm_temperature: float = 0.2
    llm_timeout_seconds: float = 30.0

    # --- persistence --------------------------------------------------------
    db_engine: Literal["sqlite", "postgres"] = "sqlite"
    # CAP owns this schema and its migrations; we read it directly (ADR-002).
    sqlite_path: str = "apps/admin-cap/db/factorypilot.db"
    postgres_dsn: str = ""

    # --- cache and counters -------------------------------------------------
    cache_engine: Literal["memory", "redis"] = "memory"
    redis_url: str = "redis://localhost:6379/0"
    default_cache_ttl_seconds: int = 900

    # --- S/4 access ---------------------------------------------------------
    # `fake` replays a synthetic fixture so the pipeline runs with no SAP
    # account at all. `hub_direct` needs SAP_HUB_API_KEY. `cpi` needs a
    # deployed thin iFlow.
    s4_access_mode: Literal["fake", "hub_direct", "cpi"] = "fake"
    sap_hub_api_key: str = ""
    s4_timeout_seconds: float = 15.0
    s4_top: int = 200
    cpi_url: str = ""
    cpi_token: str = ""

    # --- behaviour ----------------------------------------------------------
    pipeline_mode: Literal["full", "resolve"] = "full"
    enable_llm_intent_fallback: bool = False
    default_warehouse: str = "1000"
    serve_insights_ui: bool = True

    @property
    def dev_role_list(self) -> list[str]:
        return [r.strip() for r in self.dev_default_roles.split(",") if r.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
