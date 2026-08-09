using AdminService from './admin-service';

// ---------------------------------------------------------------------------
// Tile 1 — Business Object & OData Registration
// ---------------------------------------------------------------------------

annotate AdminService.BusinessObjectConfigs with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Business Object',
      TypeNamePlural: 'Business Objects',
      Title         : { Value: objectName },
      Description   : { Value: objectCode }
    },
    SelectionFields: [ objectCode, moduleDomain, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: objectCode,       Label: 'Code' },
      { $Type: 'UI.DataField', Value: objectName,       Label: 'Name' },
      { $Type: 'UI.DataField', Value: moduleDomain,     Label: 'Module' },
      { $Type: 'UI.DataField', Value: hubApiName,       Label: 'Hub API' },
      { $Type: 'UI.DataField', Value: entitySet,        Label: 'Entity Set' },
      { $Type: 'UI.DataField', Value: isActive,         Label: 'Active' },
      { $Type: 'UI.DataFieldForAction', Action: 'AdminService.testConnection', Label: 'Test Connection' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'General',      Target: '@UI.FieldGroup#General' },
      { $Type: 'UI.ReferenceFacet', Label: 'OData Source', Target: '@UI.FieldGroup#OData' },
      { $Type: 'UI.ReferenceFacet', Label: 'Query Shaping',Target: '@UI.FieldGroup#Query' }
    ],
    FieldGroup#General: { Data: [
      { Value: objectCode }, { Value: objectName }, { Value: moduleDomain },
      { Value: keywords },   { Value: isActive }
    ]},
    FieldGroup#OData: { Data: [
      { Value: destinationName }, { Value: odataServicePath }, { Value: entitySet },
      { Value: apiVersion },      { Value: hubApiName },       { Value: hubApiUrl },
      { Value: communicationScenario }
    ]},
    FieldGroup#Query: { Data: [
      { Value: defaultFilters }, { Value: selectFields }, { Value: promptHints }
    ]}
  }
);

// ---------------------------------------------------------------------------
// Tile 2 — User Token / Rate-Limit Control
// ---------------------------------------------------------------------------

annotate AdminService.UserRateLimitConfigs with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Rate Limit',
      TypeNamePlural: 'Rate Limits',
      Title         : { Value: userID }
    },
    SelectionFields: [ userID, limitType, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: userID,        Label: 'User / Role' },
      { $Type: 'UI.DataField', Value: limitType,     Label: 'Counts' },
      { $Type: 'UI.DataField', Value: dailyLimit,    Label: 'Day' },
      { $Type: 'UI.DataField', Value: weeklyLimit,   Label: 'Week' },
      { $Type: 'UI.DataField', Value: monthlyLimit,  Label: 'Month' },
      { $Type: 'UI.DataField', Value: overagePolicy, Label: 'On Overage' },
      { $Type: 'UI.DataField', Value: isActive,      Label: 'Active' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Limits', Target: '@UI.FieldGroup#Limits' }
    ],
    FieldGroup#Limits: { Data: [
      { Value: userID }, { Value: limitType }, { Value: dailyLimit },
      { Value: weeklyLimit }, { Value: monthlyLimit },
      { Value: overagePolicy }, { Value: isActive }
    ]}
  }
);

annotate AdminService.UserConsumptions with @(
  UI: {
    SelectionFields: [ userID, periodType ],
    LineItem: [
      { $Type: 'UI.DataField', Value: userID },
      { $Type: 'UI.DataField', Value: periodType },
      { $Type: 'UI.DataField', Value: periodStart },
      { $Type: 'UI.DataField', Value: consumedCount },
      { $Type: 'UI.DataField', Value: lastUpdated }
    ]
  }
);

// ---------------------------------------------------------------------------
// Tile 3 — Cache Configuration
// ---------------------------------------------------------------------------

annotate AdminService.CacheConfigs with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Cache Policy',
      TypeNamePlural: 'Cache Policies',
      Title         : { Value: objectCode }
    },
    SelectionFields: [ objectCode, cacheEnabled, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: objectCode,       Label: 'Object' },
      { $Type: 'UI.DataField', Value: queryPattern,     Label: 'Pattern' },
      { $Type: 'UI.DataField', Value: ttlValue,         Label: 'TTL' },
      { $Type: 'UI.DataField', Value: ttlUnit,          Label: 'Unit' },
      { $Type: 'UI.DataField', Value: cacheKeyStrategy, Label: 'Key Scope' },
      { $Type: 'UI.DataField', Value: cacheEnabled,     Label: 'Enabled' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Policy', Target: '@UI.FieldGroup#Policy' }
    ],
    FieldGroup#Policy: { Data: [
      { Value: objectCode }, { Value: queryPattern }, { Value: cacheEnabled },
      { Value: ttlValue },   { Value: ttlUnit },      { Value: cacheKeyStrategy },
      { Value: isActive }
    ]}
  }
);

// ---------------------------------------------------------------------------
// Tile 4 — Monitoring Dashboard / Communication Log explorer
// ---------------------------------------------------------------------------

annotate AdminService.CommunicationLogs with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Log Entry',
      TypeNamePlural: 'Communication Log',
      Title         : { Value: userQuery }
    },
    SelectionFields: [ userID, objectCode, status, cacheResult, rateLimitResult ],
    LineItem: [
      { $Type: 'UI.DataField', Value: timestamp,           Label: 'When' },
      { $Type: 'UI.DataField', Value: userID,              Label: 'User' },
      { $Type: 'UI.DataField', Value: objectCode,          Label: 'Object' },
      { $Type: 'UI.DataField', Value: status,              Label: 'Status',     Criticality: statusCriticality },
      { $Type: 'UI.DataField', Value: cacheResult,         Label: 'Cache' },
      { $Type: 'UI.DataField', Value: rateLimitResult,     Label: 'Rate Limit' },
      { $Type: 'UI.DataField', Value: tokensUsed,          Label: 'Tokens' },
      { $Type: 'UI.DataField', Value: totalResponseTimeMs, Label: 'ms' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Request',  Target: '@UI.FieldGroup#Request' },
      { $Type: 'UI.ReferenceFacet', Label: 'Outcome',  Target: '@UI.FieldGroup#Outcome' }
    ],
    FieldGroup#Request: { Data: [
      { Value: timestamp }, { Value: userID }, { Value: channel },
      { Value: objectCode }, { Value: userQuery }, { Value: odataURLCalled },
      { Value: correlationId }
    ]},
    FieldGroup#Outcome: { Data: [
      { Value: status }, { Value: cacheResult }, { Value: rateLimitResult },
      { Value: llmProvider }, { Value: llmModel }, { Value: tokensUsed },
      { Value: odataResponseTimeMs }, { Value: totalResponseTimeMs },
      { Value: responseSummary }, { Value: errorDetail }
    ]}
  }
);

annotate AdminService.CommunicationLogs with {
  statusCriticality @UI.Hidden;
};
