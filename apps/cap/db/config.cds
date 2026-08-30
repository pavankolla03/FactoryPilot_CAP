namespace factorypilot.config;

using { managed, cuid } from '@sap/cds/common';
using { factorypilot.common.ActiveFlag } from './common';
using { factorypilot.integration.IntegrationEndpoint } from './integration';

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

  @title: 'Integration Endpoint'
  endpoint              : Association to IntegrationEndpoint;

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

  /**
   * OData $expand, for a backend where the detail hangs off a header rather
   * than standing on its own. SAP Graph exposes A_MaterialDocumentHeader but
   * not A_MaterialDocumentItem, so the item fields are only reachable through
   * the association. Supports the same {plant} / {materialID} placeholders as
   * defaultFilters, e.g.
   *   to_MaterialDocumentItem($filter=Plant eq '{plant}';$select=Material,Plant)
   * Rows come back flattened to one per child, so a caller sees the same shape
   * it would from a direct item query.
   */
  @title: 'Expand'
  expandPath            : String(600);

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


// Cache policy moved to db/cache.cds and CacheService: freshness-vs-cost is a
// different job from registering OData services, and giving it its own scope
// means a client can hand cache tuning to someone without also handing them
// the ability to repoint a business object at a different backend.
