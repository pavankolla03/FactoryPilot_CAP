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



