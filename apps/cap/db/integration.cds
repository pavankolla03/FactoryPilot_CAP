namespace factorypilot.integration;

using { managed, cuid } from '@sap/cds/common';
using { factorypilot.common.ActiveFlag } from './common';

/**
 * A backend the platform can reach.
 *
 * The point of this table is that connecting a new iFlow is data entry, not a
 * deploy: paste the endpoint, name the credential, press Test, activate. A
 * client can point the same product at their own Integration Suite tenant
 * without anyone touching the code (Documentation.docx Component 4, ADR-016).
 */
@assert.unique: { name: [ name ] }
entity IntegrationEndpoint : cuid, managed, ActiveFlag {
  @title: 'Name'
  name            : String(60) not null;

  /**
   * iflow        — a deployed Integration Suite iFlow (POST, thin contract)
   * odata_direct — an OData service reached directly, no middleware
   * hub_sandbox  — SAP Business Accelerator Hub sandbox
   * destination  — resolved through a BTP destination
   * mock         — the bundled fixture, for demos with no SAP account
   */
  @title: 'Kind'
  kind            : String(20) not null default 'iflow';

  @title: 'Endpoint URL'
  url             : String(400);

  @title: 'BTP Destination'
  destinationName : String(100);

  @title: 'HTTP Method'
  httpMethod      : String(10) default 'POST';

  /** none | api_key | bearer | basic | oauth2_client_credentials */
  @title: 'Authentication'
  authMode        : String(30) default 'none';

  /**
   * The NAME of the environment variable or credential-store key holding the
   * secret — never the secret itself. A secret here would end up in the
   * database, in every backup, and in every audit export of this table.
   */
  @title: 'Credential Reference'
  credentialRef   : String(100);

  /** Header the credential goes in, when the scheme uses one (e.g. APIKey). */
  @title: 'Auth Header Name'
  authHeaderName  : String(60);

  @title: 'OAuth Token URL'
  tokenUrl        : String(300);

  @title: 'Timeout (ms)'
  timeoutMs       : Integer default 15000;

  @title: 'Retries'
  maxRetries      : Integer default 1;

  /** Optional cheap path used by Test — a HEAD/GET that proves reachability
   *  without running a real query. */
  @title: 'Health Path'
  healthPath      : String(200);

  @title: 'Description'
  description     : String(300);

  // --- last test outcome, written by the Test action -----------------------
  @title: 'Last Test Status'
  lastTestStatus  : String(20);

  @title: 'Last Tested'
  lastTestedAt    : Timestamp;

  @title: 'Last Test Message'
  lastTestMessage : String(500);

  @title: 'Last Test (ms)'
  lastTestMs      : Integer;

  tests           : Composition of many EndpointTest on tests.endpoint = $self;
}

/**
 * History of connection tests.
 *
 * Kept rather than only showing the latest result: "it worked when we set it
 * up and started failing on Tuesday" is the question people actually ask.
 */
entity EndpointTest : cuid {
  endpoint    : Association to IntegrationEndpoint;

  @title: 'Tested At'
  testedAt    : Timestamp;

  @title: 'Tested By'
  testedBy    : String(100);

  @title: 'Status'
  status      : String(20);          // OK | FAILED | UNCONFIGURED

  @title: 'HTTP Status'
  httpStatus  : Integer;

  @title: 'Duration (ms)'
  durationMs  : Integer;

  @title: 'URL Tested'
  urlTested   : String(400);

  @title: 'Message'
  message     : String(500);
}
