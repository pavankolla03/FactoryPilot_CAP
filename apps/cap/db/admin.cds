namespace factorypilot.admin;

using { managed, cuid } from '@sap/cds/common';
using { factorypilot.common.ActiveFlag } from './common';

/** Users the platform knows about. Identity itself comes from IAS/XSUAA —
 *  this is the local projection plus what only we care about. */
@assert.unique: { userID: [ userID ] }
entity User : cuid, managed, ActiveFlag {
  @title: 'User'
  userID       : String(100) not null;

  @title: 'Display Name'
  displayName  : String(120);

  @title: 'Email'
  email        : String(160);

  @title: 'Default Warehouse'
  defaultWarehouse : String(20);

  @title: 'Administrator'
  isAdmin      : Boolean default false;

  scopes       : Composition of many UserScope on scopes.user = $self;
}

/**
 * Warehouse-level authorisation with an access level.
 *
 * `read` permits read tools only; a write tool needs a `write` scope on that
 * same warehouse. This is the check that stops a user moving stock in a plant
 * they can only look at.
 */
entity UserScope : cuid {
  user        : Association to User;

  @title: 'Warehouse'
  warehouseID : String(20) not null;

  @title: 'Access'
  accessLevel : String(10) default 'read';   // read | write
}

/**
 * When the agent may act without asking.
 *
 * Policies stack and the most restrictive wins: a user allowed to auto-approve
 * cannot exceed what their warehouse permits.
 */
entity ApprovalPolicy : cuid, managed, ActiveFlag {
  @title: 'Scope Kind'
  scopeKind        : String(20) default 'USER';   // USER | WAREHOUSE | ORG

  @title: 'Subject'
  subject          : String(100);                 // userID, warehouseID, or ORG

  @title: 'Auto-approve Reads'
  autoApproveReads : Boolean default true;

  @title: 'Auto-approve Writes'
  autoApproveWrites : Boolean default false;

  /** A write above this quantity always goes to a human, whatever the flags
   *  above say. */
  @title: 'Write Ceiling'
  writeCeiling     : Integer;

  /** Requires a different person to approve — the maker cannot be the checker. */
  @title: 'Second Approver Required'
  requireSecondApprover : Boolean default false;
}

/** Single-row org configuration. */
entity OrgSettings : cuid, managed {
  @title: 'Autopilot Enabled'
  autopilotEnabled  : Boolean default false;

  @title: 'Anomaly Factor'
  anomalyFactor     : Decimal(4,1) default 5.0;

  @title: 'Digest Hour'
  digestHour        : Integer default 6;

  @title: 'Webhook URL'
  webhookUrl        : String(300);

  @title: 'Default Warehouse'
  defaultWarehouse  : String(20) default '1000';
}
