using AdminService from '../admin-service';

annotate AdminService.Users with @(
  UI: {
    HeaderInfo: { TypeName: 'User', TypeNamePlural: 'Users', Title: { Value: displayName }, Description: { Value: userID } },
    SelectionFields: [ userID, isAdmin, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: userID,           Label: 'User' },
      { $Type: 'UI.DataField', Value: displayName,      Label: 'Name' },
      { $Type: 'UI.DataField', Value: email,            Label: 'Email' },
      { $Type: 'UI.DataField', Value: defaultWarehouse, Label: 'Default WH' },
      { $Type: 'UI.DataField', Value: isAdmin,          Label: 'Admin' },
      { $Type: 'UI.DataField', Value: isActive,         Label: 'Active' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Details', Target: '@UI.FieldGroup#D' },
      { $Type: 'UI.ReferenceFacet', Label: 'Warehouse Scopes', Target: 'scopes/@UI.LineItem' }
    ],
    FieldGroup#D: { Data: [
      { Value: userID }, { Value: displayName }, { Value: email },
      { Value: defaultWarehouse }, { Value: isAdmin }, { Value: isActive }
    ]}
  }
);

annotate AdminService.UserScopes with @(
  UI: {
    LineItem: [
      { $Type: 'UI.DataField', Value: warehouseID, Label: 'Warehouse' },
      { $Type: 'UI.DataField', Value: accessLevel, Label: 'Access' }
    ]
  }
);

annotate AdminService.ApprovalPolicies with @(
  UI: {
    HeaderInfo: { TypeName: 'Approval Policy', TypeNamePlural: 'Approval Policies', Title: { Value: subject } },
    SelectionFields: [ scopeKind, subject, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: scopeKind,             Label: 'Applies To' },
      { $Type: 'UI.DataField', Value: subject,               Label: 'Subject' },
      { $Type: 'UI.DataField', Value: autoApproveReads,      Label: 'Auto Reads' },
      { $Type: 'UI.DataField', Value: autoApproveWrites,     Label: 'Auto Writes' },
      { $Type: 'UI.DataField', Value: writeCeiling,          Label: 'Ceiling' },
      { $Type: 'UI.DataField', Value: requireSecondApprover, Label: '2nd Approver' },
      { $Type: 'UI.DataField', Value: isActive,              Label: 'Active' }
    ],
    Facets: [ { $Type: 'UI.ReferenceFacet', Label: 'Policy', Target: '@UI.FieldGroup#P' } ],
    FieldGroup#P: { Data: [
      { Value: scopeKind }, { Value: subject }, { Value: autoApproveReads },
      { Value: autoApproveWrites }, { Value: writeCeiling },
      { Value: requireSecondApprover }, { Value: isActive }
    ]}
  }
);

annotate AdminService.OrgSettings with @(
  UI: {
    HeaderInfo: { TypeName: 'Org Settings', TypeNamePlural: 'Org Settings', Title: { Value: defaultWarehouse } },
    // A list report with no LineItem renders its columns as nothing at all —
    // the screen loads, the row is there, and every cell is blank. One row is
    // still a list as far as the template is concerned.
    LineItem: [
      { $Type: 'UI.DataField', Value: defaultWarehouse, Label: 'Default Plant' },
      { $Type: 'UI.DataField', Value: autopilotEnabled, Label: 'Autopilot' },
      { $Type: 'UI.DataField', Value: anomalyFactor,    Label: 'Anomaly Factor' },
      { $Type: 'UI.DataField', Value: digestHour,       Label: 'Digest Hour' }
    ],
    Facets: [ { $Type: 'UI.ReferenceFacet', Label: 'Organisation', Target: '@UI.FieldGroup#O' } ],
    FieldGroup#O: { Data: [
      { Value: autopilotEnabled }, { Value: anomalyFactor }, { Value: digestHour },
      { Value: webhookUrl }, { Value: defaultWarehouse }
    ]}
  }
);

annotate AdminService.ApprovalPolicies with {
  writeCeiling @title: 'Quantity above which a human always confirms';
};

annotate AdminService.OrgSettings with {
  anomalyFactor @title: 'Flag a move this many times the recent average';
};
