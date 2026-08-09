"""Test fixtures.

The database here is built from the same DDL `cds deploy` emits rather than a
copy of the deployed file, so the Python test job does not need Node. A
dedicated test (test_schema_parity) checks the two have not drifted apart.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adapters.cache.memory import MemoryCacheAdapter  # noqa: E402
from app.adapters.db.sqlite_repo import SqliteRepository  # noqa: E402
from app.adapters.llm.fake import FakeLLMProvider  # noqa: E402
from app.adapters.s4.fake import FakeS4Client  # noqa: E402
from app.config import Settings  # noqa: E402
from app.graph.pipeline import build_pipeline  # noqa: E402
from app.graph.state import Deps  # noqa: E402
from app.services.rate_limit import RateLimiter  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
CAP_DB = REPO_ROOT / "apps/admin-cap/db/factorypilot.db"

DDL = """
CREATE TABLE factorypilot_BusinessObjectConfig (
  ID NVARCHAR(36) NOT NULL, createdAt TIMESTAMP_TEXT, createdBy NVARCHAR(255),
  modifiedAt TIMESTAMP_TEXT, modifiedBy NVARCHAR(255),
  objectCode NVARCHAR(30) NOT NULL, objectName NVARCHAR(60),
  moduleDomain NVARCHAR(30) DEFAULT 'SCM', keywords NVARCHAR(500),
  destinationName NVARCHAR(100), odataServicePath NVARCHAR(200),
  entitySet NVARCHAR(100), apiVersion NVARCHAR(10) DEFAULT 'v2',
  defaultFilters NVARCHAR(500), selectFields NVARCHAR(500),
  promptHints NVARCHAR(1000), hubApiName NVARCHAR(100), hubApiUrl NVARCHAR(300),
  communicationScenario NVARCHAR(30), isActive BOOLEAN DEFAULT FALSE,
  PRIMARY KEY(ID)
);
CREATE TABLE factorypilot_UserRateLimitConfig (
  ID NVARCHAR(36) NOT NULL, createdAt TIMESTAMP_TEXT, createdBy NVARCHAR(255),
  modifiedAt TIMESTAMP_TEXT, modifiedBy NVARCHAR(255),
  userID NVARCHAR(100) NOT NULL, dailyLimit INTEGER, weeklyLimit INTEGER,
  monthlyLimit INTEGER, limitType NVARCHAR(20) DEFAULT 'REQUEST_COUNT',
  overagePolicy NVARCHAR(20) DEFAULT 'BLOCK', isActive BOOLEAN DEFAULT TRUE,
  PRIMARY KEY(ID)
);
CREATE TABLE factorypilot_CacheConfig (
  ID NVARCHAR(36) NOT NULL, createdAt TIMESTAMP_TEXT, createdBy NVARCHAR(255),
  modifiedAt TIMESTAMP_TEXT, modifiedBy NVARCHAR(255),
  objectCode NVARCHAR(30) NOT NULL, queryPattern NVARCHAR(200),
  cacheEnabled BOOLEAN DEFAULT TRUE, ttlValue INTEGER DEFAULT 15,
  ttlUnit NVARCHAR(10) DEFAULT 'MINUTES',
  cacheKeyStrategy NVARCHAR(10) DEFAULT 'PER_USER', isActive BOOLEAN DEFAULT TRUE,
  PRIMARY KEY(ID)
);
CREATE TABLE factorypilot_CommunicationLog (
  ID NVARCHAR(36) NOT NULL, timestamp TIMESTAMP_TEXT, userID NVARCHAR(100),
  channel NVARCHAR(40), objectCode NVARCHAR(30), userQuery NVARCHAR(1000),
  odataURLCalled NVARCHAR(500), odataResponseTimeMs INTEGER,
  cacheResult NVARCHAR(20), rateLimitResult NVARCHAR(10),
  llmProvider NVARCHAR(100), llmModel NVARCHAR(100), tokensUsed INTEGER,
  totalResponseTimeMs INTEGER, status NVARCHAR(20),
  responseSummary NVARCHAR(2000), errorDetail NVARCHAR(1000),
  correlationId NVARCHAR(60), PRIMARY KEY(ID)
);
CREATE TABLE factorypilot_UserConsumption (
  ID NVARCHAR(36) NOT NULL, userID NVARCHAR(100) NOT NULL,
  periodType NVARCHAR(10) NOT NULL, periodStart DATE_TEXT NOT NULL,
  consumedCount INTEGER DEFAULT 0, lastUpdated TIMESTAMP_TEXT, PRIMARY KEY(ID)
);
"""

DELIVERY_FILTER = "ActualGoodsMovementDate eq {today} and ShippingPoint eq '{warehouse}'"
DELIVERY_KEYWORDS = "delivery,deliveries,outbound delivery,ship,warehouse,to be delivered"
DELIVERY_SELECT = (
    "DeliveryDocument,DeliveryDocumentType,ShippingPoint,"
    "OverallGoodsMovementStatus,ActualGoodsMovementDate,SoldToParty"
)


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    path = tmp_path / "test.db"
    conn = sqlite3.connect(path)
    conn.executescript(DDL)
    conn.execute(
        "INSERT INTO factorypilot_BusinessObjectConfig "
        "(ID, objectCode, objectName, moduleDomain, keywords, destinationName, "
        "odataServicePath, entitySet, apiVersion, defaultFilters, selectFields, "
        "promptHints, hubApiUrl, isActive) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "bo-delivery", "DELIVERY", "Outbound Delivery", "SCM", DELIVERY_KEYWORDS,
            "SAP_ACCELERATOR_HUB_SANDBOX",
            "/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV", "A_OutbDeliveryHeader",
            "v2", DELIVERY_FILTER, DELIVERY_SELECT,
            "You summarise outbound deliveries.", "", 1,
        ),
    )
    conn.execute(
        "INSERT INTO factorypilot_BusinessObjectConfig "
        "(ID, objectCode, objectName, keywords, entitySet, odataServicePath, isActive) "
        "VALUES (?,?,?,?,?,?,?)",
        (
            "bo-sales", "SALES", "Sales Order", "sales order,order,so",
            "A_SalesOrder", "/sap/opu/odata/sap/API_SALES_ORDER_SRV", 1,
        ),
    )
    conn.execute(
        "INSERT INTO factorypilot_UserRateLimitConfig "
        "(ID, userID, dailyLimit, weeklyLimit, monthlyLimit, limitType, overagePolicy, isActive) "
        "VALUES (?,?,?,?,?,?,?,?)",
        ("rl-default", "DEFAULT", 50, 200, 500, "REQUEST_COUNT", "BLOCK", 1),
    )
    conn.execute(
        "INSERT INTO factorypilot_CacheConfig "
        "(ID, objectCode, queryPattern, cacheEnabled, ttlValue, ttlUnit, cacheKeyStrategy, isActive) "
        "VALUES (?,?,?,?,?,?,?,?)",
        ("cc-delivery", "DELIVERY", "", 1, 15, "MINUTES", "PER_USER", 1),
    )
    conn.commit()
    conn.close()
    return path


@pytest.fixture
def fixture_path(tmp_path: Path) -> Path:
    """A small synthetic payload with a known shape, generated relative to
    today so date filters behave the same on any run date."""
    today = date.today()

    def ticks(d: date) -> str:
        ms = int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000)
        return f"/Date({ms})/"

    rows = []
    plan = [
        ("1000", "A", 0), ("1000", "A", 0), ("1000", "B", 0), ("1000", "C", 0),
        ("1010", "A", 0), ("1010", "C", 0),
        ("1000", "A", -1), ("1000", "C", 1),
    ]
    for i, (shipping, status, offset) in enumerate(plan):
        rows.append({
            "DeliveryDocument": f"8000{i:04d}",
            "DeliveryDocumentType": "LF",
            "ShippingPoint": shipping,
            "OverallGoodsMovementStatus": status,
            "ActualGoodsMovementDate": ticks(today + timedelta(days=offset)),
            "SoldToParty": "USCU_L01",
        })

    path = tmp_path / "sample.json"
    path.write_text(
        json.dumps({"_synthetic": {"baseDate": today.isoformat()}, "d": {"results": rows}}),
        encoding="utf-8",
    )
    return path


@pytest.fixture
def settings(db_path: Path) -> Settings:
    return Settings(
        auth_mode="dev",
        llm_provider="fake",
        db_engine="sqlite",
        sqlite_path=str(db_path),
        cache_engine="memory",
        s4_access_mode="fake",
        default_warehouse="1000",
        llm_max_tokens=800,
    )


@pytest.fixture
def deps(settings: Settings, fixture_path: Path) -> Deps:
    repo = SqliteRepository(settings.sqlite_path)
    cache = MemoryCacheAdapter()
    return Deps(
        settings=settings,
        repo=repo,
        cache=cache,
        llm=FakeLLMProvider(),
        s4=FakeS4Client(fixture_path),
        rate_limiter=RateLimiter(repo, cache),
    )


@pytest.fixture
def pipeline(deps: Deps):
    return build_pipeline(deps)


def log_rows(db_path: Path) -> list[sqlite3.Row]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            "SELECT * FROM factorypilot_CommunicationLog ORDER BY timestamp"
        ).fetchall()
    finally:
        conn.close()
