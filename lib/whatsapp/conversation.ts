// lib/whatsapp/conversation.ts — onboarding state machine (pure, DB-free, unit-tested).
// Validated interactive reply IDs are the only application inputs; display labels are never trusted.
import type { ConversationState } from '@/lib/statuses'

// States mirror the CONVERSATION_STATES enum (lib/statuses.ts) and the DB CHECK
// constraint in 20261011000000_phase1_status_lifecycle.sql. Re-exported for callers.
export type { ConversationState }

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24h idle expiry

export const REPLY_IDS = {
  ACCOUNT_INDIVIDUAL: 'billora:account:individual',
  ACCOUNT_ORGANIZATION: 'billora:account:organization',
  CLIENT_ADD: 'billora:client:add',
  CLIENT_PREFIX: 'billora:client:',
  CONFIRM_YES: 'billora:confirm:yes',
  CONFIRM_NO: 'billora:confirm:no',
} as const

export const COMMANDS = {
  HELP: 'help', CANCEL: 'cancel', MENU: 'menu', DONE: 'done',
  CHANGE_CLIENT: 'change client', ADD_CLIENT: 'add client',
} as const

export interface SessionSnapshot {
  senderHmac: string
  state: ConversationState
  workspaceId: string | null
  clientId: string | null
  batchId: string | null
  pendingClientId: string | null
  lastProviderMessageId: string | null
  expired: boolean
}

export type OutboundMessage =
  | { kind: 'text'; body: string }
  | { kind: 'account_type_buttons' }
  | { kind: 'client_list'; clients: Array<{ id: string; name: string }> }
  | { kind: 'none' }

export interface TransitionInput {
  session: SessionSnapshot
  replyId: string | null
  text: string | null
  providerMessageId: string
}

export interface TransitionResult {
  nextState: ConversationState
  outbound: OutboundMessage
  workspaceId?: string | null
  clientId?: string | null
  batchId?: string | null
  note: string
}

function normalizeText(t: string | null): string { return (t || '').trim().toLowerCase() }

const GREETINGS = new Set(['hi', 'hello', 'hey', 'start', 'namaste'])

function isGreeting(t: string): boolean { return GREETINGS.has(t) }

/** Pure transition: unknown IDs / unexpected messages degrade to a safe re-prompt. */
export function transition(input: TransitionInput): TransitionResult {
  const { session, replyId, text } = input
  const norm = normalizeText(text)
  if (session.lastProviderMessageId === input.providerMessageId) {
    return { nextState: session.state, outbound: { kind: 'none' }, note: 'duplicate' }
  }
  if (!replyId) {
    if (norm === COMMANDS.CANCEL) {
      return { nextState: 'cancelled',
        outbound: { kind: 'text', body: 'Cancelled. Send Hi anytime to start again.' }, note: 'cancel' }
    }
    if (norm === COMMANDS.HELP || norm === 'help me' || norm === '?') {
      return { nextState: session.state, outbound: { kind: 'text', body: helpText(session.state) }, note: 'help' }
    }
    if (norm === COMMANDS.MENU) {
      return { nextState: session.state, outbound: { kind: 'text', body: menuText(session) }, note: 'menu' }
    }
    if (norm === COMMANDS.DONE) {
      if (session.workspaceId) {
        return { nextState: session.state, outbound: { kind: 'none' }, note: 'done' }
      }
      return { nextState: session.state, outbound: { kind: 'text', body: helpText(session.state) }, note: 'done-not-onboarded' }
    }
    if (norm === COMMANDS.CHANGE_CLIENT || norm === 'switch client') {
      if (session.workspaceId) {
        return { nextState: 'awaiting_client_select', outbound: { kind: 'none' }, note: 'change-client-requested' }
      }
      return { nextState: session.state, outbound: { kind: 'text', body: 'Finish setup first — send Hi.' }, note: 'no-workspace' }
    }
    if (norm === COMMANDS.ADD_CLIENT || norm === 'add a client') {
      if (session.workspaceId) {
        return { nextState: 'awaiting_client_name', outbound: { kind: 'text', body: 'Send the new client name.' }, note: 'client-add-requested' }
      }
      return { nextState: session.state, outbound: { kind: 'text', body: 'Finish setup first — send Hi.' }, note: 'no-workspace' }
    }
  }
  switch (session.state) {
    case 'new':
    case 'cancelled': {
      // Returning users never repeat setup: a linked workspace means onboarding
      // is done; any message resumes collection (welcome-back).
      if (session.workspaceId) {
        return { nextState: 'collecting', outbound: { kind: 'none' }, note: 'welcome-back' }
      }
      if (text && isGreeting(norm)) {
        return { nextState: 'awaiting_account_type', outbound: { kind: 'account_type_buttons' }, note: 'greet' }
      }
      return { nextState: 'awaiting_account_type', outbound: { kind: 'account_type_buttons' }, note: 'nudge-to-greet' }
    }
    case 'awaiting_account_type': {
      if (replyId === REPLY_IDS.ACCOUNT_INDIVIDUAL) {
        return { nextState: 'individual_ready',
          outbound: { kind: 'text', body: 'Your individual workspace is ready. Send invoice PDFs or photos here.' },
          note: 'individual-selected' }
      }
      if (replyId === REPLY_IDS.ACCOUNT_ORGANIZATION) {
        return { nextState: 'awaiting_org_name',
          outbound: { kind: 'text', body: 'What is the organization name?' }, note: 'organization-selected' }
      }
      return { nextState: 'awaiting_account_type', outbound: { kind: 'account_type_buttons' }, note: 'reprompt' }
    }
    case 'awaiting_org_name': {
      if (replyId) {
        return { nextState: 'awaiting_org_name',
          outbound: { kind: 'text', body: 'Please send the organization name as text.' }, note: 'reprompt' }
      }
      const name = (text || '').trim()
      if (name.length < 2 || name.length > 120) {
        return { nextState: 'awaiting_org_name',
          outbound: { kind: 'text', body: 'Please send a valid organization name (2-120 characters).' },
          note: 'org-name-invalid' }
      }
      return { nextState: 'awaiting_client_select', outbound: { kind: 'none' }, note: `org-name:${name}` }
    }
    case 'awaiting_client_select': {
      if (replyId === REPLY_IDS.CLIENT_ADD) {
        return { nextState: 'awaiting_client_name',
          outbound: { kind: 'text', body: 'Send the new client name.' }, note: 'client-add-requested' }
      }
      if (replyId && replyId.startsWith(REPLY_IDS.CLIENT_PREFIX)) {
        const clientId = replyId.slice(REPLY_IDS.CLIENT_PREFIX.length)
        if (/^[0-9a-f-]{8,36}$/i.test(clientId)) {
          // First selection completes onboarding; a later one is a client switch.
          return { nextState: session.clientId ? 'collecting' : 'organization_ready', clientId,
            outbound: { kind: 'text', body: 'Client selected. Send invoice PDFs or photos here.' },
            note: 'client-selected' }
        }
        return { nextState: session.state, outbound: { kind: 'none' }, note: 'reprompt-client-list' }
      }
      return { nextState: session.state, outbound: { kind: 'none' }, note: 'reprompt-client-list' }
    }
    case 'awaiting_client_name': {
      if (replyId) {
        return { nextState: 'awaiting_client_name',
          outbound: { kind: 'text', body: 'Please send the new client name as text.' }, note: 'reprompt' }
      }
      const name = (text || '').trim()
      if (name.length < 2 || name.length > 120) {
        return { nextState: 'awaiting_client_name',
          outbound: { kind: 'text', body: 'Please send a valid client name (2-120 characters).' },
          note: 'client-name-invalid' }
      }
      return { nextState: session.clientId ? 'collecting' : 'organization_ready', outbound: { kind: 'none' }, note: `client-name:${name}` }
    }
    // "Apply [New Client] to those pending files?" — yes/no over buttons or text.
    // The pending client candidate is persisted on the session row, so the
    // question survives restarts and webhook retries.
    case 'awaiting_pending_confirm': {
      if (replyId === REPLY_IDS.CONFIRM_YES || norm === 'yes') {
        return { nextState: 'collecting', outbound: { kind: 'none' }, note: 'pending-confirm-yes' }
      }
      if (replyId === REPLY_IDS.CONFIRM_NO || norm === 'no') {
        return { nextState: 'collecting',
          outbound: { kind: 'text', body: 'OK — those files stay held. Send Change client anytime to assign them.' },
          note: 'pending-confirm-no' }
      }
      return { nextState: session.state,
        outbound: { kind: 'text', body: 'Please tap Apply to pending files or Keep held — or send yes / no.' },
        note: 'reprompt-confirm' }
    }
    // Setup finished into a ready state; the next message promotes to collecting.
    // Media intake is handled by the route and works in any ready/collecting state.
    case 'individual_ready':
    case 'organization_ready':
    case 'collecting': {
      return { nextState: 'collecting', outbound: { kind: 'none' }, note: 'collecting-passthrough' }
    }
    default:
      return { nextState: session.state,
        outbound: { kind: 'text', body: 'Send Hi to start again.' }, note: 'reprompt' }
  }
}

function helpText(state: ConversationState): string {
  if (state === 'collecting' || state === 'individual_ready' || state === 'organization_ready'
    || state === 'awaiting_pending_confirm') {
    return 'Send invoice PDFs or photos here. Commands: Change client, Add client, Done, Menu, Help, Cancel.'
  }
  if (state === 'awaiting_client_select' || state === 'awaiting_client_name') {
    return 'Choose a client from the list or add a new one by name. Commands: Help, Cancel.'
  }
  return 'Send Hi to begin. You will choose Individual or Organization / CA firm. Commands: Help, Cancel.'
}

function menuText(session: SessionSnapshot): string {
  if (!session.workspaceId) return 'Send Hi to begin setup. Commands: Help, Cancel.'
  return [
    'Billora menu:',
    '• Send invoices — PDF, JPG, or PNG',
    '• Change client — pick who new files belong to',
    '• Add client — create a new client',
    '• Done — finish this batch',
    '• Help • Cancel',
  ].join('\n')
}
