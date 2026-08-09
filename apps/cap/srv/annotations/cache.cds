using CacheService from '../cache-service';

annotate CacheService.CachePolicies with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Cache Policy',
      TypeNamePlural: 'Cache Policies',
      Title         : { Value: objectCode },
      Description   : { Value: description }
    },
    SelectionFields: [ objectCode, cacheEnabled, cacheKeyStrategy, isActive ],
    LineItem: [
      { $Type: 'UI.DataField', Value: objectCode,       Label: 'Object' },
      { $Type: 'UI.DataField', Value: queryPattern,     Label: 'Pattern' },
      { $Type: 'UI.DataField', Value: ttlValue,         Label: 'TTL' },
      { $Type: 'UI.DataField', Value: ttlUnit,          Label: 'Unit' },
      { $Type: 'UI.DataField', Value: cacheKeyStrategy, Label: 'Shared With' },
      { $Type: 'UI.DataField', Value: midnightClamp,    Label: 'Expires at Midnight' },
      { $Type: 'UI.DataField', Value: cacheEnabled,     Label: 'Enabled' },
      { $Type: 'UI.DataField', Value: isActive,         Label: 'Active' }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Freshness', Target: '@UI.FieldGroup#Freshness' },
      { $Type: 'UI.ReferenceFacet', Label: 'Sharing',   Target: '@UI.FieldGroup#Sharing' }
    ],
    FieldGroup#Freshness: { Data: [
      { Value: objectCode }, { Value: queryPattern }, { Value: cacheEnabled },
      { Value: ttlValue }, { Value: ttlUnit }, { Value: midnightClamp }, { Value: isActive }
    ]},
    FieldGroup#Sharing: { Data: [
      { Value: cacheKeyStrategy }, { Value: description }
    ]}
  }
);

// Spell out the consequences where the admin is choosing, not in a wiki page
// they will not read. Key scope in particular is a data-visibility decision.
annotate CacheService.CachePolicies with {
  objectCode       @title: 'Business object, or DEFAULT as the fallback';
  queryPattern     @title: 'Optional finer pattern, e.g. today-count';
  ttlValue         @title: 'Reuse an answer for this long';
  cacheKeyStrategy @title: 'PER_USER private · PER_ROLE shared by role · GLOBAL shared by everyone';
  midnightClamp    @title: 'Force "today" answers to expire at midnight';
  description      @title: 'Why this setting is safe — required for GLOBAL';
};

annotate CacheService.CacheStats with @(
  UI: {
    SelectionFields: [ objectCode, day ],
    LineItem: [
      { $Type: 'UI.DataField', Value: day,         Label: 'Day' },
      { $Type: 'UI.DataField', Value: objectCode,  Label: 'Object' },
      { $Type: 'UI.DataField', Value: hits,        Label: 'Hits' },
      { $Type: 'UI.DataField', Value: misses,      Label: 'Misses' },
      { $Type: 'UI.DataField', Value: hitRatio,    Label: 'Hit %' },
      { $Type: 'UI.DataField', Value: tokensSaved, Label: 'Tokens Saved' }
    ]
  }
);
