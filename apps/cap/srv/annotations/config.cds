using ConfigService from '../config-service';

// Generated UI: these annotations are the list report and object page. There
// is no hand-written screen behind them — adding a field to the CDS model and
// naming it here is the whole change.

annotate ConfigService.BusinessObjects with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Business Object',
      TypeNamePlural: 'Business Objects',
      Title         : { Value: objectName },
      Description   : { Value: objectCode }
    },
    SelectionFields: [ objectCode, moduleDomain, isActive, exposedAsTool ],
    LineItem: [
      { $Type: 'UI.DataField', Value: objectCode,    Label: 'Code' },
      { $Type: 'UI.DataField', Value: objectName,    Label: 'Name' },
      { $Type: 'UI.DataField', Value: moduleDomain,  Label: 'Module' },
      { $Type: 'UI.DataField', Value: entitySet,     Label: 'Entity Set' },
      { $Type: 'UI.DataField', Value: exposedAsTool, Label: 'Agent Tool' },
      { $Type: 'UI.DataField', Value: isActive,      Label: 'Active' },
      { $Type: 'UI.DataFieldForAction', Action: 'ConfigService.testConnection', Label: 'Test Connection' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'General',      Target: '@UI.FieldGroup#General' },
      { $Type: 'UI.ReferenceFacet', Label: 'OData Source', Target: '@UI.FieldGroup#OData' },
      { $Type: 'UI.ReferenceFacet', Label: 'Agent',        Target: '@UI.FieldGroup#Agent' },
      { $Type: 'UI.ReferenceFacet', Label: 'Cache',        Target: 'cachePolicies/@UI.LineItem' }
    ],
    FieldGroup#General: { Data: [
      { Value: objectCode }, { Value: objectName }, { Value: moduleDomain }, { Value: isActive }
    ]},
    FieldGroup#OData: { Data: [
      { Value: connection_ID, Label: 'Connection' }, { Value: odataServicePath }, { Value: entitySet },
      { Value: apiVersion }, { Value: defaultFilters }, { Value: selectFields },
      { Value: hubApiName }, { Value: hubApiUrl }, { Value: communicationScenario }
    ]},
    FieldGroup#Agent: { Data: [
      { Value: exposedAsTool }, { Value: keywords }, { Value: promptHints }
    ]}
  }
);

annotate ConfigService.Connections with @(
  UI: {
    HeaderInfo: { TypeName: 'Connection', TypeNamePlural: 'Connections', Title: { Value: name } },
    SelectionFields: [ name, kind, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: name,           Label: 'Name' },
      { $Type: 'UI.DataField', Value: kind,           Label: 'Kind' },
      { $Type: 'UI.DataField', Value: baseUrl,        Label: 'Base URL' },
      { $Type: 'UI.DataField', Value: lastTestStatus, Label: 'Last Test', Criticality: testCriticality },
      { $Type: 'UI.DataField', Value: lastTestedAt,   Label: 'Tested' },
      { $Type: 'UI.DataField', Value: isActive,       Label: 'Active' },
      { $Type: 'UI.DataFieldForAction', Action: 'ConfigService.test', Label: 'Test' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Connection', Target: '@UI.FieldGroup#Conn' },
      { $Type: 'UI.ReferenceFacet', Label: 'Last Test',  Target: '@UI.FieldGroup#Test' }
    ],
    FieldGroup#Conn: { Data: [
      { Value: name }, { Value: kind }, { Value: baseUrl }, { Value: destinationName },
      { Value: authMode }, { Value: credentialRef }, { Value: timeoutMs }, { Value: isActive }
    ]},
    FieldGroup#Test: { Data: [
      { Value: lastTestStatus }, { Value: lastTestedAt }, { Value: lastTestMessage }
    ]}
  }
);

// The credential reference is a env var *name*, never the secret. Say so where
// an admin is typing it.
annotate ConfigService.Connections with {
  credentialRef @title: 'Credential env var name (never the secret)';
};

annotate ConfigService.CachePolicies with @(
  UI: {
    HeaderInfo: { TypeName: 'Cache Policy', TypeNamePlural: 'Cache Policies', Title: { Value: toolName } },
    SelectionFields: [ toolName, cacheEnabled, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: toolName,         Label: 'Tool' },
      { $Type: 'UI.DataField', Value: queryPattern,     Label: 'Pattern' },
      { $Type: 'UI.DataField', Value: ttlValue,         Label: 'TTL' },
      { $Type: 'UI.DataField', Value: ttlUnit,          Label: 'Unit' },
      { $Type: 'UI.DataField', Value: cacheKeyStrategy, Label: 'Key Scope' },
      { $Type: 'UI.DataField', Value: cacheEnabled,     Label: 'Enabled' }
    ]
  }
);
