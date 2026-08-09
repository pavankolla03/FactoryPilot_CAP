namespace factorypilot.config;

using { managed, cuid } from '@sap/cds/common';
using { factorypilot.common.ActiveFlag } from './common';

/**
 * The OData / business object registry.
 *
 * Adding a business object — or a whole new module — is a row here, never a new
 * iFlow and never a code deploy (ADR-016). The agent's tool layer reads this to
 * build queries at runtime.
 */
@assert.unique: { objectCode: [ objectCode ] }
entity BusinessObjectConfig : cuid, managed, ActiveFlag {
  @title: 'Object Code'
  objectCode            : String(30) not null;

  @title: 'Object Name'
  objectName            : String(60);

  @title: 'Module Domain'
  moduleDomain          : String(30) default 'SCM';

  @title: 'Intent Keywords'
  keywords              : String(500);

  @title: 'Connection'
  connection            : Association to Connection;

  @title: 'OData Service Path'
  odataServicePath      : String(200);

  @title: 'Entity Set'
  entitySet             : String(100);

  @title: 'OData Version'
  apiVersion            : String(10) default 'v2';

  @title: 'Default Filters'
  defaultFilters        : String(500);

  @title: 'Select Fields'
  selectFields          : String(500);

  @title: 'Prompt Hints'
  promptHints           : String(1000);

  @title: 'Hub API Name'
  hubApiName            : String(100);

  @title: 'Hub API URL'
  hubApiUrl             : String(300);

  @title: 'Communication Scenario'
  communicationScenario : String(30);

  @title: 'Exposed as Agent Tool'
  exposedAsTool         : Boolean default true;
}

/**
 * A backend the platform can reach: Hub sandbox, a customer S/4 via
 * destination, or the thin CPI iFlow. Keeping this separate from
 * BusinessObjectConfig means many objects share one connection and credentials
 * rotate in a single place.
 */
@assert.unique: { name: [ name ] }
entity Connection : cuid, managed, ActiveFlag {
  @title: 'Name'
  name            : String(60) not null;

  @title: 'Kind'
  kind            : String(20) default 'hub_sandbox';  // hub_sandbox | destination | cpi | mock

  @title: 'Base URL'
  baseUrl         : String(300);

  @title: 'BTP Destination'
  destinationName : String(100);

  @title: 'Auth Mode'
  authMode        : String(30) default 'api_key';      // api_key | oauth2 | basic | none

  /** Never the secret itself — the name of the env var / credential-store key. */
  @title: 'Credential Reference'
  credentialRef   : String(100);

  @title: 'Timeout (ms)'
  timeoutMs       : Integer default 15000;

  @title: 'Last Test Result'
  lastTestStatus  : String(20);

  @title: 'Last Tested'
  lastTestedAt    : Timestamp;

  @title: 'Last Test Message'
  lastTestMessage : String(500);
}

// Cache policy moved to db/cache.cds and CacheService: freshness-vs-cost is a
// different job from registering OData services, and giving it its own scope
// means a client can hand cache tuning to someone without also handing them
// the ability to repoint a business object at a different backend.
