using IntegrationService from '../integration-service';

annotate IntegrationService.Endpoints with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Integration Endpoint',
      TypeNamePlural: 'Integration Endpoints',
      Title         : { Value: name },
      Description   : { Value: description }
    },
    SelectionFields: [ name, kind, lastTestStatus, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: name,           Label: 'Name' },
      { $Type: 'UI.DataField', Value: kind,           Label: 'Kind' },
      { $Type: 'UI.DataField', Value: url,            Label: 'Endpoint URL' },
      { $Type: 'UI.DataField', Value: authMode,       Label: 'Auth' },
      { $Type: 'UI.DataField', Value: lastTestStatus, Label: 'Last Test', Criticality: testCriticality },
      { $Type: 'UI.DataField', Value: lastTestedAt,   Label: 'Tested' },
      { $Type: 'UI.DataField', Value: isActive,       Label: 'Active' },
      { $Type: 'UI.DataFieldForAction', Action: 'IntegrationService.test', Label: 'Test' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Endpoint',       Target: '@UI.FieldGroup#Endpoint' },
      { $Type: 'UI.ReferenceFacet', Label: 'Authentication', Target: '@UI.FieldGroup#Auth' },
      { $Type: 'UI.ReferenceFacet', Label: 'Last Test',      Target: '@UI.FieldGroup#LastTest' },
      { $Type: 'UI.ReferenceFacet', Label: 'Test History',   Target: 'tests/@UI.LineItem' }
    ],
    FieldGroup#Endpoint: { Data: [
      { Value: name }, { Value: kind }, { Value: url }, { Value: httpMethod },
      { Value: destinationName }, { Value: healthPath },
      { Value: timeoutMs }, { Value: maxRetries }, { Value: description }, { Value: isActive }
    ]},
    FieldGroup#Auth: { Data: [
      { Value: authMode }, { Value: credentialRef }, { Value: authHeaderName }, { Value: tokenUrl }
    ]},
    FieldGroup#LastTest: { Data: [
      { Value: lastTestStatus }, { Value: lastTestedAt }, { Value: lastTestMs }, { Value: lastTestMessage }
    ]}
  }
);

// Say what each field means where the admin is typing it. The credential one
// especially: the difference between a name and a secret is the difference
// between a config row and a leak.
annotate IntegrationService.Endpoints with {
  url            @title: 'Full endpoint URL (https). Paste your iFlow address here.';
  httpMethod     @title: 'GET sends OData query parameters · POST sends a JSON body';
  authMode       @title: 'How this endpoint authenticates';
  credentialRef  @title: 'NAME of the env var holding the secret — never the secret. OAuth2 expands to <REF>_CLIENT_ID and <REF>_CLIENT_SECRET.';
  authHeaderName @title: 'Header the API key travels in, e.g. APIKey';
  tokenUrl       @title: 'OAuth2 token endpoint (client credentials)';
  healthPath     @title: 'Optional cheap path for Test, e.g. /$metadata';
  lastTestStatus @title: 'OK · FAILED · UNCONFIGURED';
};

annotate IntegrationService.EndpointTests with @(
  UI: {
    LineItem: [
      { $Type: 'UI.DataField', Value: testedAt,   Label: 'When' },
      { $Type: 'UI.DataField', Value: status,     Label: 'Status' },
      { $Type: 'UI.DataField', Value: httpStatus, Label: 'HTTP' },
      { $Type: 'UI.DataField', Value: durationMs, Label: 'ms' },
      { $Type: 'UI.DataField', Value: testedBy,   Label: 'By' },
      { $Type: 'UI.DataField', Value: message,    Label: 'Message' }
    ]
  }
);
