namespace factorypilot.chat;

using { cuid, managed } from '@sap/cds/common';
using { factorypilot.common.MessageRole } from './common';

entity Conversation : cuid, managed {
  @title: 'User'
  userID    : String(100) not null;

  @title: 'Title'
  title     : String(200);

  @title: 'Channel'
  channel   : String(40) default 'Web';

  @title: 'Archived'
  archived  : Boolean default false;

  messages  : Composition of many Message on messages.conversation = $self;
}

/**
 * Full turn history including tool calls and tool results, so a follow-up
 * question can reference data an earlier tool returned.
 *
 * Histories are sanitised on load: a tool_call turn whose result never arrived
 * (a write that went to the confirm flow instead) is dropped, because most
 * providers reject a dangling tool call.
 */
entity Message : cuid {
  conversation  : Association to Conversation;

  @title: 'Sequence'
  seq           : Integer;

  @title: 'Timestamp'
  timestamp     : Timestamp;

  @title: 'Role'
  role          : MessageRole;

  @title: 'Content'
  content       : LargeString;

  /** Set on assistant turns that asked for tools; JSON array. */
  @title: 'Tool Calls'
  toolCalls     : LargeString;

  /** Set on tool turns; ties the result back to the assistant's request. */
  @title: 'Tool Call ID'
  toolCallId    : String(80);

  @title: 'Tool Name'
  toolName      : String(60);

  @title: 'Tokens'
  tokensUsed    : Integer default 0;

  @title: 'Grounded'
  grounded      : Boolean default false;
}
