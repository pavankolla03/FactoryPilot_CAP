"""FastAPI entrypoint for the insights orchestrator."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.adapters.cache.factory import get_cache_adapter
from app.adapters.db.factory import get_repository
from app.adapters.llm.factory import get_llm_provider
from app.adapters.s4.factory import get_s4_client
from app.api.routes.insights import router as insights_router
from app.config import get_settings
from app.graph.pipeline import build_pipeline
from app.graph.state import Deps
from app.services.rate_limit import RateLimiter

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("factorypilot")

# Repo-root-relative, so `uvicorn app.main:app` works from the repo root where
# the CAP SQLite file and the UI live.
UI_DIR = Path("apps/approuter/resources/insights")


def build_deps() -> Deps:
    settings = get_settings()
    repo = get_repository(settings)
    cache = get_cache_adapter(settings)
    return Deps(
        settings=settings,
        repo=repo,
        cache=cache,
        llm=get_llm_provider(settings),
        s4=get_s4_client(settings),
        rate_limiter=RateLimiter(repo, cache),
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    deps = build_deps()
    app.state.deps = deps
    app.state.pipeline = build_pipeline(deps)
    log.info(
        "orchestrator ready — llm=%s s4=%s db=%s cache=%s auth=%s",
        deps.settings.llm_provider,
        deps.settings.s4_access_mode,
        deps.settings.db_engine,
        deps.settings.cache_engine,
        deps.settings.auth_mode,
    )
    try:
        yield
    finally:
        await deps.cache.close()
        await deps.repo.close()


app = FastAPI(
    title="FactoryPilot Insights Orchestrator",
    version="0.1.0",
    lifespan=lifespan,
)
app.include_router(insights_router)


@app.get("/healthz", include_in_schema=False)
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


# In production the Approuter serves this and routes /insights/* here. Locally
# we mount the same directory so one process gives you the whole demo.
if get_settings().serve_insights_ui and UI_DIR.is_dir():
    app.mount("/", StaticFiles(directory=UI_DIR, html=True), name="insights-ui")
