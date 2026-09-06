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
      { $Type: 'UI.DataField', Value: isActive,      Label: 'Active' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'General',      Target: '@UI.FieldGroup#General' },
      { $Type: 'UI.ReferenceFacet', Label: 'OData Source', Target: '@UI.FieldGroup#OData' },
      { $Type: 'UI.ReferenceFacet', Label: 'Agent',        Target: '@UI.FieldGroup#Agent' }
    ],
    FieldGroup#General: { Data: [
      { Value: objectCode }, { Value: objectName }, { Value: moduleDomain }, { Value: isActive }
    ]},
    FieldGroup#OData: { Data: [
      { Value: endpoint_ID, Label: 'Integration Endpoint' }, { Value: odataServicePath }, { Value: entitySet },
      { Value: apiVersion }, { Value: defaultFilters }, { Value: selectFields },
      { Value: hubApiName }, { Value: hubApiUrl }, { Value: communicationScenario }
    ]},
    FieldGroup#Agent: { Data: [
      { Value: exposedAsTool }, { Value: keywords }, { Value: promptHints }
    ]}
  }
);

/**
 * The vetted question library, offered on the Insights welcome screen. (BETA)
 *
 * `useCount` leads the object page rather than hiding at the bottom: whether
 * anyone actually asks a saved question is the one fact that says whether the
 * library is worth curating, and it should not take a second click to see.
 */
annotate ConfigService.SavedQuestions with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Saved Question',
      TypeNamePlural: 'Saved Questions',
      Title         : { Value: title },
      Description   : { Value: question }
    },
    SelectionFields: [ forRole, warehouseID, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: sortOrder,   Label: 'Order' },
      { $Type: 'UI.DataField', Value: title,       Label: 'Title' },
      { $Type: 'UI.DataField', Value: question,    Label: 'Question' },
      { $Type: 'UI.DataField', Value: warehouseID, Label: 'Plant' },
      { $Type: 'UI.DataField', Value: forRole,     Label: 'For Role' },
      { $Type: 'UI.DataField', Value: useCount,    Label: 'Times Asked' },
      { $Type: 'UI.DataField', Value: isActive,    Label: 'Active' }
    ],
    Facets: [ { $Type: 'UI.ReferenceFacet', Label: 'Question', Target: '@UI.FieldGroup#Q' } ],
    FieldGroup#Q: { Data: [
      { Value: title }, { Value: question }, { Value: warehouseID }, { Value: forRole },
      { Value: sortOrder }, { Value: isActive }, { Value: useCount }
    ]}
  }
);

annotate ConfigService.SavedQuestions with {
  useCount @readonly;
};



