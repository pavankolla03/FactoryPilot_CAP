using TokenService from '../token-service';

annotate TokenService.QuotaPolicies with @(
  UI: {
    HeaderInfo: { TypeName: 'Quota Policy', TypeNamePlural: 'Quota Policies', Title: { Value: subject } },
    SelectionFields: [ subject, limitType, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: subject,       Label: 'User / Role' },
      { $Type: 'UI.DataField', Value: limitType,     Label: 'Counts' },
      { $Type: 'UI.DataField', Value: dailyLimit,    Label: 'Day' },
      { $Type: 'UI.DataField', Value: weeklyLimit,   Label: 'Week' },
      { $Type: 'UI.DataField', Value: monthlyLimit,  Label: 'Month' },
      { $Type: 'UI.DataField', Value: overagePolicy, Label: 'On Overage' },
      { $Type: 'UI.DataField', Value: isActive,      Label: 'Active' }
    ],
    Facets: [ { $Type: 'UI.ReferenceFacet', Label: 'Limits', Target: '@UI.FieldGroup#Limits' } ],
    FieldGroup#Limits: { Data: [
      { Value: subject }, { Value: limitType }, { Value: dailyLimit }, { Value: weeklyLimit },
      { Value: monthlyLimit }, { Value: perRequestMaxTokens }, { Value: overagePolicy }, { Value: isActive }
    ]}
  }
);

annotate TokenService.Consumptions with @(
  UI: {
    SelectionFields: [ userID, periodType ],
    LineItem: [
      { $Type: 'UI.DataField', Value: userID },
      { $Type: 'UI.DataField', Value: periodType },
      { $Type: 'UI.DataField', Value: periodStart },
      { $Type: 'UI.DataField', Value: consumedCount },
      { $Type: 'UI.DataField', Value: requestCount },
      { $Type: 'UI.DataField', Value: lastUpdated }
    ]
  }
);

annotate TokenService.TokenUsages with @(
  UI: {
    SelectionFields: [ userID, model, provider, isEstimated ],
    LineItem: [
      { $Type: 'UI.DataField', Value: timestamp,        Label: 'When' },
      { $Type: 'UI.DataField', Value: userID,           Label: 'User' },
      { $Type: 'UI.DataField', Value: model,            Label: 'Model' },
      { $Type: 'UI.DataField', Value: promptTokens,     Label: 'Prompt' },
      { $Type: 'UI.DataField', Value: completionTokens, Label: 'Completion' },
      { $Type: 'UI.DataField', Value: totalTokens,      Label: 'Total' },
      // Surfaced deliberately: an estimated count must not be read as measured.
      { $Type: 'UI.DataField', Value: isEstimated,      Label: 'Estimated' },
      { $Type: 'UI.DataField', Value: latencyMs,        Label: 'ms' }
    ]
  }
);

annotate TokenService.ModelRoutes with @(
  UI: {
    HeaderInfo: { TypeName: 'Model Route', TypeNamePlural: 'Model Routes', Title: { Value: route } },
    SelectionFields: [ route, provider, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: route,     Label: 'Route' },
      { $Type: 'UI.DataField', Value: provider,  Label: 'Provider' },
      { $Type: 'UI.DataField', Value: model,     Label: 'Model' },
      { $Type: 'UI.DataField', Value: maxTokens, Label: 'Max Tokens' },
      { $Type: 'UI.DataField', Value: isActive,  Label: 'Active' }
    ],
    Facets: [ { $Type: 'UI.ReferenceFacet', Label: 'Routing', Target: '@UI.FieldGroup#R' } ],
    FieldGroup#R: { Data: [
      { Value: route }, { Value: provider }, { Value: model }, { Value: fallbacks },
      { Value: maxTokens }, { Value: temperature }, { Value: isActive }
    ]}
  }
);

annotate TokenService.ApiKeyRefs with @(
  UI: {
    HeaderInfo: { TypeName: 'API Key', TypeNamePlural: 'API Keys', Title: { Value: label } },
    LineItem: [
      { $Type: 'UI.DataField', Value: label },
      { $Type: 'UI.DataField', Value: provider },
      { $Type: 'UI.DataField', Value: credentialRef, Label: 'Env Var' },
      { $Type: 'UI.DataField', Value: lastUsedAt },
      { $Type: 'UI.DataField', Value: isActive }
    ]
  }
);

annotate TokenService.ApiKeyRefs with {
  credentialRef @title: 'Credential env var name (never the key)';
};
