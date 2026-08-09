using AuditService from '../audit-service';

annotate AuditService.SessionLogs with @(
  UI: {
    HeaderInfo: { TypeName: 'Log Entry', TypeNamePlural: 'Session Log', Title: { Value: userQuery } },
    SelectionFields: [ userID, objectCode, status, quotaResult, grounded ],
    LineItem: [
      { $Type: 'UI.DataField', Value: timestamp,           Label: 'When' },
      { $Type: 'UI.DataField', Value: userID,              Label: 'User' },
      { $Type: 'UI.DataField', Value: objectCode,          Label: 'Object' },
      { $Type: 'UI.DataField', Value: status,              Label: 'Status', Criticality: statusCriticality },
      // Whether the answer came from tool output or model recall. An
      // ungrounded answer is not evidence, and the log should show that.
      { $Type: 'UI.DataField', Value: grounded,            Label: 'Grounded' },
      { $Type: 'UI.DataField', Value: quotaResult,         Label: 'Quota' },
      { $Type: 'UI.DataField', Value: tokensUsed,          Label: 'Tokens' },
      { $Type: 'UI.DataField', Value: totalResponseTimeMs, Label: 'ms' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Request', Target: '@UI.FieldGroup#Req' },
      { $Type: 'UI.ReferenceFacet', Label: 'Outcome', Target: '@UI.FieldGroup#Out' }
    ],
    FieldGroup#Req: { Data: [
      { Value: timestamp }, { Value: userID }, { Value: channel }, { Value: objectCode },
      { Value: userQuery }, { Value: toolsCalled }, { Value: backendUrlCalled }, { Value: correlationId }
    ]},
    FieldGroup#Out: { Data: [
      { Value: status }, { Value: grounded }, { Value: quotaResult }, { Value: cacheResult },
      { Value: llmProvider }, { Value: llmModel }, { Value: tokensUsed },
      { Value: backendTimeMs }, { Value: totalResponseTimeMs },
      { Value: responseSummary }, { Value: errorDetail }
    ]}
  }
);

annotate AuditService.AgentRuns with @(
  UI: {
    HeaderInfo: { TypeName: 'Agent Run', TypeNamePlural: 'Agent Runs', Title: { Value: goal } },
    SelectionFields: [ userID, status ],
    LineItem: [
      { $Type: 'UI.DataField', Value: startedAt,     Label: 'Started' },
      { $Type: 'UI.DataField', Value: userID,        Label: 'User' },
      { $Type: 'UI.DataField', Value: goal,          Label: 'Goal' },
      { $Type: 'UI.DataField', Value: rounds,        Label: 'Rounds' },
      { $Type: 'UI.DataField', Value: toolCallCount, Label: 'Tools' },
      { $Type: 'UI.DataField', Value: status,        Label: 'Status', Criticality: statusCriticality }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Run',   Target: '@UI.FieldGroup#R' },
      { $Type: 'UI.ReferenceFacet', Label: 'Steps', Target: 'steps/@UI.LineItem' }
    ],
    FieldGroup#R: { Data: [
      { Value: startedAt }, { Value: finishedAt }, { Value: userID },
      { Value: goal }, { Value: rounds }, { Value: toolCallCount },
      { Value: status }, { Value: outcome }
    ]}
  }
);

annotate AuditService.AgentSteps with @(
  UI: {
    LineItem: [
      { $Type: 'UI.DataField', Value: seq,        Label: '#' },
      { $Type: 'UI.DataField', Value: toolName,   Label: 'Tool' },
      { $Type: 'UI.DataField', Value: arguments,  Label: 'Arguments' },
      { $Type: 'UI.DataField', Value: result,     Label: 'Result' },
      { $Type: 'UI.DataField', Value: durationMs, Label: 'ms' },
      { $Type: 'UI.DataField', Value: error,      Label: 'Error' }
    ]
  }
);

annotate AuditService.PendingActions with @(
  UI: {
    HeaderInfo: { TypeName: 'Pending Action', TypeNamePlural: 'Approvals', Title: { Value: summary } },
    SelectionFields: [ userID, status, anomalous, warehouseID ],
    LineItem: [
      { $Type: 'UI.DataField', Value: createdAt,   Label: 'Proposed' },
      { $Type: 'UI.DataField', Value: userID,      Label: 'By' },
      { $Type: 'UI.DataField', Value: summary,     Label: 'Action' },
      { $Type: 'UI.DataField', Value: warehouseID, Label: 'Warehouse' },
      // An anomalous action is never auto-approved; it needs to stand out.
      { $Type: 'UI.DataField', Value: anomalous,   Label: 'Anomalous' },
      { $Type: 'UI.DataField', Value: status,      Label: 'Status' },
      { $Type: 'UI.DataField', Value: expiresAt,   Label: 'Expires' }
    ],
    Facets: [ { $Type: 'UI.ReferenceFacet', Label: 'Action', Target: '@UI.FieldGroup#A' } ],
    FieldGroup#A: { Data: [
      { Value: summary }, { Value: toolName }, { Value: arguments }, { Value: warehouseID },
      { Value: anomalous }, { Value: anomalyReason }, { Value: status },
      { Value: approvedBy }, { Value: createdAt }, { Value: expiresAt }, { Value: resolvedAt }
    ]}
  }
);
