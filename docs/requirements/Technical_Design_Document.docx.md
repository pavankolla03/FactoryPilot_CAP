  
**Technical Design Document**

**AI-Assisted S/4HANA Business Insights Platform**

*Configurable CAP Apps, Generic CPI Integration Flow, Rate-Limited LLM Contextualization and Usage Dashboard*

Version 0.1 — Draft for Review

Domain: SAP BTP | CAP (Node.js/Java) | SAP Integration Suite (CPI) | S/4HANA OData | LLM Gateway

# **1\. Introduction & Objective**

This document defines the technical design for a configurable, AI-assisted platform that allows business users to query SAP S/4HANA operational data — such as Sales, Delivery, Shipping, Goods Movement and Purchasing — using natural language (for example, “How many orders are to be delivered / shipped today in my warehouse?”). The platform resolves the intent to the correct S/4HANA OData service, retrieves the data, enforces per-user rate limits, contextualizes the raw OData response into a natural-language answer via an LLM gateway (OpenRouter), caches the result, and logs every step for auditing and reporting.

The solution is composed of three configurable CAP (Cloud Application Programming) administration apps, one generic CPI integration flow, an LLM contextualization step, a caching layer, and a monitoring dashboard. Each is described in detail in the sections below, including proposed data models, configuration options, and interaction sequence.

## **1.1 Objectives**

* Avoid hard-coding OData service paths per business object — allow functional consultants to configure/extend them without a code change.

* Give administrators fine-grained control over LLM/API token consumption per user, per day/week/month.

* Make result caching configurable per business object / query pattern to reduce redundant S/4HANA and LLM calls.

* Provide one generic, metadata-driven CPI iFlow rather than one iFlow per business object.

* Enforce rate limits before invoking the LLM, to control cost and protect the S/4HANA backend.

* Give full traceability: every request, OData call, rate-limit decision, LLM call and cached response is logged.

* Provide a dashboard for token usage, throughput and communication history, by user and by business object.

# **2\. Solution Overview & High-Level Architecture**

## **2.1 Component Landscape**

| \# | Component | Type | Responsibility |
| :---- | :---- | :---- | :---- |
| 1 | Business Object Configuration App | CAPM (Fiori Elements) | Maintain business objects (Sales, Delivery, Shipping, Goods Movement, Purchasing, …) and their S/4HANA OData service URL, entity set, filters and keyword mapping. |
| 2 | User Token Control App | CAPM (Fiori Elements) | Maintain per-user (or per-role) rate limits for day / week / month, and view consumption. |
| 3 | Cache Configuration App | CAPM (Fiori Elements) | Maintain cache TTL (time-to-live) and cache key strategy per business object / query type. |
| 4 | Generic Query iFlow | SAP Integration Suite (CPI) | Identify the business object from user input, resolve its OData URL from config, call S4 OData, check rate limit, call LLM gateway, cache & log. |
| 5 | LLM Gateway Integration | OpenRouter (external) | Contextualize the raw OData JSON payload into a natural-language answer. |
| 6 | Cache Store | Redis / CAP-managed table / HANA Cache | Store contextualized responses keyed by object \+ query fingerprint, honoring configured TTL. |
| 7 | Usage & Audit Log Store | CAP entity / HANA table | Persist every request: user, business object, OData call, rate-limit result, LLM tokens used, cache hit/miss, response time. |
| 8 | Monitoring Dashboard | CAP \+ Fiori (SAC optional) | Visualize token consumption, throughput, cache hit ratio and communication logs by user/object/time. |

## **2.2 End-to-End Flow**

1. User (chatbot / Fiori / Joule-style UI) submits a natural-language question, e.g. “How many orders are to be delivered today in my warehouse?”

2. The Generic Query iFlow receives the request together with the user identity (from the calling channel / JWT).

3. Step – Identify Business Object: the iFlow calls an intent-classification step (keyword/NLU rules maintained in the Business Object Configuration App, optionally backed by an LLM classification call) to resolve the request to a business object (e.g. “Delivery”).

4. Step – Resolve OData URL: the iFlow reads the Business Object Configuration App (via its own OData service) to fetch the destination, service path, entity set and default filters configured for “Delivery”.

5. Step – Check Cache: the iFlow computes a cache key (business object \+ normalized query \+ user/tenant) and checks the Cache Configuration/Cache Store for a valid, non-expired entry. If found — return the cached, already-contextualized answer immediately (skip steps 6–10) and log a cache hit.

6. Step – Call S/4HANA OData: on a cache miss, the iFlow calls the resolved OData service/entity set on S4 with the derived filters (e.g. delivery date \= today, plant/warehouse \= user's default) to retrieve the data.

7. Step – Rate Limit Check: the iFlow calls the User Token Control App to verify the requesting user's remaining quota for the current day/week/month window.

8. Step – Route on Result:

   * If rate limit OK → forward the OData result to OpenRouter (LLM gateway) to contextualize it into a natural-language answer, decrement/record token usage.

   * If rate limit exceeded → skip the LLM call, return a rate-limit-exceeded message (optionally with raw data or a “try again after X” message), and log the rejection.

9. Step – Cache the Result: store the contextualized response in the cache using the TTL configured in the Cache Configuration App for that business object.

10. Step – Log: write one audit/log record capturing user, business object, OData call, payload size, rate-limit decision, LLM tokens consumed, cache hit/miss, and total response time.

11. Response is returned to the calling channel and rendered to the user.

A sequence diagram and a component diagram should be added as appendices once endpoints and the LLM gateway contract are finalized; placeholders are noted in Section 10\.

# **3\. CAPM App 1 — Business Object Configuration**

## **3.1 Purpose**

Allows functional/technical administrators to register each business object (Sales, Delivery, Shipping, Goods Movement, Purchasing, and future objects) together with the S/4HANA OData service metadata needed to query it, without requiring changes to the CPI iFlow.

## **3.2 Proposed Data Model — entity BusinessObjectConfig**

| Field | Type | Description |
| :---- | :---- | :---- |
| objectID | UUID | Technical primary key. |
| objectCode | String(30) | Short code, e.g. SALES, DELIVERY, SHIPPING, GOODS\_MOVEMENT, PURCHASING. |
| objectName | String(60) | Display name shown in the app and used for NLU matching. |
| keywords | String(500) | Comma-separated synonyms/keywords used to match user free-text to this object (e.g. “orders, sales order, SO”). |
| destinationName | String(100) | BTP Destination pointing to the S/4HANA system (cloud connector / principal propagation). |
| odataServicePath | String(200) | Service root, e.g. /sap/opu/odata/sap/API\_DELIVERY\_DOCUMENT\_SRV. |
| entitySet | String(100) | Entity set to query, e.g. DeliveryDocument. |
| defaultFilters | String(500) | Default OData $filter template, e.g. DeliveryDate eq today and Plant eq {userPlant}. |
| selectFields | String(500) | OData $select fields to limit payload size. |
| apiVersion | String(10) | OData v2 / v4 indicator, used to build the correct query syntax. |
| isActive | Boolean | Enable/disable this object without deleting configuration. |
| createdBy / createdAt | User / Timestamp | Standard managed fields. |
| modifiedBy / modifiedAt | User / Timestamp | Standard managed fields. |

## **3.3 UI / Behavior**

* Fiori Elements List Report \+ Object Page (CRUD) generated from the CDS model above.

* Validation: objectCode unique; odataServicePath and entitySet mandatory when isActive \= true.

* “Test Connection” action that calls $metadata on the configured destination/service to validate configuration before activation.

* Draft-enabled for safe editing; changes only take effect for new requests once activated.

# **4\. CAPM App 2 — User Token / Rate-Limit Control**

## **4.1 Purpose**

Allows administrators to configure how many requests / LLM tokens a user (or role/tenant) may consume within a day, week and month, and exposes current consumption so the Generic Query iFlow can approve or reject a request before it is routed to the LLM gateway.

## **4.2 Proposed Data Model — entity UserRateLimitConfig**

| Field | Type | Description |
| :---- | :---- | :---- |
| configID | UUID | Technical primary key. |
| userID / roleID | String(100) | User, group or role the limit applies to (supports a default/fallback entry). |
| dailyLimit | Integer | Max requests or tokens allowed per day. |
| weeklyLimit | Integer | Max requests or tokens allowed per rolling/calendar week. |
| monthlyLimit | Integer | Max requests or tokens allowed per calendar month. |
| limitType | Enum | REQUEST\_COUNT or TOKEN\_COUNT — whether limits count calls or LLM tokens. |
| overagePolicy | Enum | BLOCK, WARN\_AND\_ALLOW, or QUEUE — behavior once a limit is hit. |
| isActive | Boolean | Enable/disable the limit entry. |

## **4.3 Proposed Data Model — entity UserConsumption (rolling counters)**

| Field | Type | Description |
| :---- | :---- | :---- |
| consumptionID | UUID | Technical primary key. |
| userID | String(100) | Requesting user. |
| periodType | Enum | DAY / WEEK / MONTH. |
| periodStart | Date | Start of the counting window. |
| consumedCount | Integer | Requests or tokens consumed so far in the window. |
| lastUpdated | Timestamp | Last increment timestamp. |

## **4.4 Behavior**

* The iFlow calls a CAP action, e.g. POST /checkAndReserveQuota(userID, requestedTokens), which atomically checks all three windows against UserRateLimitConfig and, if within limits, increments UserConsumption and returns ALLOWED; otherwise returns DENIED with the exceeded window.

* Fiori app shows current configuration plus a read-only consumption view (used also by the dashboard in Section 8).

* Supports a default/fallback limit entry applied when no user-specific or role-specific entry exists.

# **5\. CAPM App 3 — Cache Configuration**

## **5.1 Purpose**

Allows administrators to configure how long contextualized results may be reused (cache TTL) per business object or per query pattern, balancing data freshness against S/4HANA load, LLM cost and response time.

## **5.2 Proposed Data Model — entity CacheConfig**

| Field | Type | Description |
| :---- | :---- | :---- |
| cacheConfigID | UUID | Technical primary key. |
| objectCode | String(30) | Links to BusinessObjectConfig.objectCode (e.g. DELIVERY). |
| queryPattern | String(200) | Optional finer-grained pattern (e.g. “today-count”) for objects needing different TTLs per query type. |
| cacheEnabled | Boolean | Whether caching is active for this object/pattern. |
| ttlValue | Integer | Numeric TTL amount. |
| ttlUnit | Enum | MINUTES / HOURS / DAYS. |
| cacheKeyStrategy | Enum | PER\_USER, PER\_ROLE, or GLOBAL — whether the cache is shared or private. |
| isActive | Boolean | Enable/disable without deleting the row. |

## **5.3 Behavior**

* The iFlow builds the cache key as a hash of objectCode \+ normalized filters \+ (userID or roleID, depending on cacheKeyStrategy).

* TTL defaults to a system-wide fallback (e.g. 15 minutes) when no specific CacheConfig row is active for the object.

* Cache store technology: recommend a managed Redis instance on BTP for low-latency lookups; alternatively a CAP-managed HANA table with a scheduled cleanup job if Redis is not available.

# **6\. Generic CPI Integration Flow**

## **6.1 Purpose**

A single, metadata-driven iFlow handles every business object, rather than one iFlow per object. It is entirely data-driven by the three CAPM configuration apps described above.

## **6.2 iFlow Steps**

| Step | iFlow Element | Description |
| :---- | :---- | :---- |
| 1 | HTTPS Sender Adapter | Receives the request: userID, free-text query, and any pre-parsed context (e.g. warehouse/plant from the calling app). |
| 2 | Content Modifier | Extracts headers/body into exchange properties: userQuery, userID, tenant. |
| 3 | Request-Reply – Intent Resolution | Calls a small classification step (rule-based keyword match against BusinessObjectConfig.keywords, or an LLM intent-classification call) to resolve objectCode. |
| 4 | Request-Reply – Config Lookup | OData call to the Business Object Configuration App to fetch destination, service path, entity set, filters for the resolved objectCode. |
| 5 | Request-Reply – Cache Lookup | Calls Cache Config App / cache store with the computed cache key; Router branches on hit vs. miss. |
| 6a | Router – Cache Hit | Returns the cached, contextualized payload directly; logs a cache-hit record; flow ends. |
| 6b | Request-Reply – OData Call to S4 | On cache miss, dynamically builds the OData GET (service path, entity set, $filter, $select from config) and calls S/4HANA via the configured destination. |
| 7 | Request-Reply – Rate Limit Check | Calls the User Token Control App's checkAndReserveQuota action with userID and estimated token cost. |
| 8 | Router – Rate Limit Decision | ALLOWED → continue to step 9; DENIED → skip to step 11 with a rate-limit-exceeded message. |
| 9 | Request-Reply – LLM Contextualization | Calls OpenRouter with the OData JSON \+ original user query, requesting a natural-language summary/answer. |
| 10 | Request-Reply – Cache Write | Writes the contextualized result to the cache store using the TTL/strategy from Cache Config App. |
| 11 | Request-Reply – Audit Log Write | Persists one log record (Section 7\) regardless of the path taken (cache hit, success, or rate-limited). |
| 12 | HTTPS Sender Response | Returns the final answer (or rate-limit message) to the calling channel. |

## **6.3 Error Handling**

* Exception subprocess catches OData/backend failures, LLM gateway timeouts, and config-lookup failures; each writes a distinct error entry to the audit log and returns a graceful fallback message.

* Circuit-breaker / timeout settings per adapter to avoid long-hanging user requests if S4 or OpenRouter is slow.

* Retries with backoff on transient OpenRouter/S4 errors, capped to avoid double-counting rate-limit consumption.

# **7\. Rate Limiting, Caching Logic & Communication Log**

## **7.1 Rate Limiting Summary**

Rate limiting is enforced centrally by the User Token Control App's checkAndReserveQuota action, evaluated against the day/week/month limits configured per user or role. The iFlow always performs the rate check after the S4 OData call but before the LLM call, since the LLM call is the primary cost driver being protected; the OData call itself may optionally be subject to its own lighter-weight limit if backend load also needs protection.

## **7.2 Caching Summary**

Caching wraps the entire contextualized answer, keyed by business object, normalized query and (depending on configuration) user or role. This avoids repeat OData and LLM calls for repeated or near-identical questions within the configured TTL, directly reducing both S/4HANA load and LLM token spend.

## **7.3 Proposed Data Model — entity CommunicationLog**

| Field | Type | Description |
| :---- | :---- | :---- |
| logID | UUID | Technical primary key. |
| timestamp | Timestamp | Request time. |
| userID | String(100) | Requesting user. |
| objectCode | String(30) | Resolved business object. |
| userQuery | String(1000) | Original free-text question. |
| odataURLCalled | String(500) | Resolved OData request (service \+ entity \+ filters). |
| odataResponseTimeMs | Integer | S4 OData call latency. |
| cacheResult | Enum | HIT / MISS / NOT\_APPLICABLE. |
| rateLimitResult | Enum | ALLOWED / DENIED. |
| llmProvider / model | String(100) | OpenRouter model used for contextualization. |
| tokensUsed | Integer | Tokens consumed for this request (prompt \+ completion). |
| totalResponseTimeMs | Integer | End-to-end latency. |
| status | Enum | SUCCESS / RATE\_LIMITED / ERROR. |
| errorDetail | String(1000) | Populated on ERROR status. |

# **8\. Monitoring Dashboard**

## **8.1 Purpose**

A CAP \+ Fiori (or SAP Analytics Cloud, if already licensed) dashboard built on top of the UserConsumption and CommunicationLog entities, giving administrators visibility into usage, cost and system health.

## **8.2 Proposed KPIs / Views**

* Tokens used by user — current day/week/month vs. configured limit, with a progress indicator.

* Throughput — requests per hour/day, split by business object (Sales, Delivery, Shipping, Goods Movement, Purchasing).

* Cache hit ratio — overall and per business object, to validate TTL configuration effectiveness.

* Rate-limit rejections — count and trend, by user, to flag users who need a higher quota.

* Average response time — broken down by OData call time vs. LLM call time vs. cache-hit time.

* Communication log explorer — searchable/filterable table of CommunicationLog entries for troubleshooting and audit.

* Top questions / objects queried — to guide future keyword tuning in the Business Object Configuration App.

## **8.3 Technical Notes**

* Expose aggregation views (CDS analytical views with @Analytics.query) on top of UserConsumption and CommunicationLog for efficient dashboard queries.

* Fiori Elements Analytical List Page or Overview Page for the initial release; SAC story as an optional enhancement for richer visualizations.

# **9\. Technology Stack Summary**

| Layer | Technology |
| :---- | :---- |
| Configuration Apps (3x) | SAP CAP (Node.js or Java) \+ Fiori Elements, deployed on SAP BTP Cloud Foundry / Kyma |
| Database | SAP HANA Cloud (CAP-managed entities: config, consumption, logs) |
| Integration | SAP Integration Suite – Cloud Integration (CPI), generic iFlow |
| S/4HANA Connectivity | Cloud Connector \+ BTP Destination service, OData v2/v4 APIs |
| LLM Gateway | OpenRouter (model-agnostic routing to LLM providers) |
| Cache Store | Redis on SAP BTP (preferred) or HANA-managed cache table |
| Dashboard | CAP analytical services \+ Fiori Elements (Overview/Analytical List Page); SAC optional |
| Auth | SAP BTP XSUAA / IAS, principal propagation to S4 where applicable |

# **10\. Non-Functional Requirements & Open Points**

## **10.1 Non-Functional Requirements**

* Security: all configuration apps role-restricted (e.g. Administrator vs. Viewer scopes); OpenRouter API key stored in BTP destination/credential store, never in the iFlow.

* Performance: cache-hit responses target sub-second latency; cache-miss (full S4 \+ LLM round trip) target defined per NFR workshop (e.g. under 5 seconds).

* Scalability: rate-limit and cache lookups must be safe under concurrent requests (atomic increment on UserConsumption).

* Auditability: every request produces exactly one CommunicationLog record, regardless of outcome.

* Extensibility: adding a new business object requires configuration only (Business Object Configuration App), no iFlow or code change.

## **10.2 Open Points for Review**

* Confirm intent-classification approach for Step 3 of the iFlow: pure keyword matching vs. LLM-based classification (cost/latency trade-off).

* Confirm whether rate limiting should also gate the S/4HANA OData call itself, or only the LLM contextualization call.

* Confirm cache invalidation strategy for time-sensitive data (e.g. “today's deliveries” naturally expires at midnight regardless of configured TTL).

* Confirm OpenRouter model selection policy (cost vs. quality) and whether it should be configurable per business object.

* Confirm dashboard tool choice: native Fiori/CAP analytics vs. SAP Analytics Cloud.

* Sequence and component diagrams to be finalized and attached as appendices once the above points are confirmed.