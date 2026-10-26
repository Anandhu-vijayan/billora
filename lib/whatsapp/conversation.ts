// lib/whatsapp/conversation.ts — onboarding state machine (pure, DB-free, unit-tested).
// Validated interactive reply IDs are the only application inputs; display labels are never trusted.
import type { ConversationState } from '@/lib/statuses'
// review-edit.ts is relative + import-only-types at its leaf, so it transpiles to
// pure JS with the conversation layer and the REAL reply parser is unit-tested here.
import { parseReviewEditCommand, type ReviewEditCommand } from './review-edit'
// gstin.ts is pure + dependency-free, so the optional own-GSTIN command can reuse
// the SAME checksum the extractor uses rather than a weaker one-off regex (§P0-1b).
import { gstinFullyValid } from '../ocr/gstin'

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
  // Optional navigation menu (Stage 2). Namespaced so unknown/stale ids degrade
  // to a safe re-prompt rather than an action. Labels are never authoritative.
  MENU_PREFIX: 'billora:menu:',
  MENU_STATUS: 'billora:menu:status',
  MENU_CHANGE_CLIENT: 'billora:menu:change_client',
  MENU_ADD_CLIENT: 'billora:menu:add_client',
  MENU_REVIEW: 'billora:menu:review',
  MENU_DONE: 'billora:menu:done',
  MENU_HELP: 'billora:menu:help',
  MENU_CANCEL: 'billora:menu:cancel',
  // Optional own-GSTIN capture (§P0-1b). Opens a plain-text prompt; the reply is
  // parsed by the `My GSTIN` command below, so NO new conversation state is added
  // (the DB state CHECK and the linear onboarding transitions stay untouched).
  MENU_SET_GSTIN: 'billora:menu:set_gstin',
  // Opt-in proactive delivery (§P1-6). One workspace menu row opens a text prompt;
  // the "Proactive on/off" reply is parsed by parseProactiveCommand below, so NO
  // new conversation state is added (the DB state CHECK stays untouched).
  MENU_PROACTIVE: 'billora:menu:proactive',
  // WhatsApp-native review approval. The invoice id is embedded in the row id
  // and validated below; the display label is never the authorization.
  REVIEW_CONFIRM_PREFIX: 'billora:review:confirm:',
  // WhatsApp-native editable review: tapping "Edit" enters the numbered
  // field-correction sub-state for THAT invoice. Same validated-uuid rule as the
  // confirm id; the display label never authorizes the edit.
  REVIEW_EDIT_PREFIX: 'billora:review:edit:',
  // Bulk approval + pagination over the review list (§P1-7). These ids carry no
  // invoice uuid: approve-all is a fixed control id, and a page id is a validated
  // small integer. They only ever re-run the SAME shared per-invoice confirm path, so
  // "approve all" never bypasses a validator — a still-bad row simply stays flagged.
  REVIEW_APPROVE_ALL: 'billora:review:approve-all',
  REVIEW_PAGE_PREFIX: 'billora:review:page:',
} as const

export const COMMANDS = {
  HELP: 'help', CANCEL: 'cancel', MENU: 'menu', DONE: 'done',
  CHANGE_CLIENT: 'change client', ADD_CLIENT: 'add client',
} as const

// A reply beginning with one of these is an own-GSTIN command, not invoice text.
const GSTIN_COMMAND_PREFIXES = ['my gstin', 'set gstin', 'own gstin', 'update gstin', 'change gstin'] as const

export type GstinCommand =
  | { action: 'prompt' }
  | { action: 'skip' }
  | { action: 'clear' }
  /** A checksum-valid GSTIN, normalised upper-case with no spaces. */
  | { action: 'set'; value: string }
  /** Present-but-not-a-valid-GSTIN: the caller re-prompts, never stores the value. */
  | { action: 'invalid'; value: string }

/**
 * Parse the optional own-GSTIN command. Returns null for anything that is NOT a
 * GSTIN command (so ordinary messages and invoice text are untouched). The value
 * is validated with the SAME full GSTIN check the extractor uses; a near-miss is
 * reported as `invalid` and never stored — we never persist a GSTIN we are unsure
 * of, and never silently no-op a command the user clearly meant (§P0-1b).
 */
export function parseGstinCommand(raw: string | null | undefined): GstinCommand | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  const lower = text.toLowerCase()
  const prefix = GSTIN_COMMAND_PREFIXES.find(
    (p) => lower === p || lower.startsWith(`${p} `) || lower.startsWith(`${p}:`),
  )
  if (!prefix) return null
  const rest = text.slice(prefix.length).replace(/^[\s:=-]+/, '').trim()
  const restLower = rest.toLowerCase()
  if (rest === '') return { action: 'prompt' }
  if (restLower === 'clear' || restLower === 'remove' || restLower === 'delete') return { action: 'clear' }
  if (restLower === 'skip' || restLower === 'none' || restLower === 'no' || restLower === 'unset') return { action: 'skip' }
  const value = rest.toUpperCase().replace(/\s+/g, '')
  return gstinFullyValid(value) ? { action: 'set', value } : { action: 'invalid', value: rest }
}

// Opt-in proactive delivery (§P1-6). Fixed phrases only — never a fuzzy match —
// so an ordinary message or invoice caption is never mistaken for consent.
const PROACTIVE_ENABLE_PHRASES = ['proactive on', 'enable proactive', 'turn on proactive', 'opt in', 'alerts on'] as const
const PROACTIVE_DISABLE_PHRASES = ['proactive off', 'disable proactive', 'turn off proactive', 'stop proactive', 'opt out', 'alerts off'] as const

export type ProactiveCommand =
  | { action: 'enable' }
  | { action: 'disable' }
  /** Bare "proactive": explain the choice without changing anything. */
  | { action: 'prompt' }

/**
 * Parse an opt-in/opt-out command. Returns null for anything that is NOT one of
 * the fixed phrases (so ordinary text is untouched). Consent itself is only ever
 * acted on by the route when the separate feature flag + key are configured — the
 * state machine records intent, it does not decide eligibility.
 */
export function parseProactiveCommand(raw: string | null | undefined): ProactiveCommand | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  const lower = text.toLowerCase().replace(/\s+/g, ' ')
  if (PROACTIVE_ENABLE_PHRASES.some((p) => lower === p)) return { action: 'enable' }
  if (PROACTIVE_DISABLE_PHRASES.some((p) => lower === p)) return { action: 'disable' }
  if (lower === 'proactive' || lower === 'proactive help' || lower === 'delivery alerts') return { action: 'prompt' }
  return null
}

export interface SessionSnapshot {
  senderHmac: string
  state: ConversationState
  workspaceId: string | null
  clientId: string | null
  batchId: string | null
  pendingClientId: string | null
  /** The invoice currently being corrected in the in-chat editor (edit sub-state only). */
  reviewEditInvoiceId: string | null
  lastProviderMessageId: string | null
  expired: boolean
}

export type OutboundMessage =
  | { kind: 'text'; body: string }
  | { kind: 'account_type_buttons' }
  | { kind: 'client_list'; clients: Array<{ id: string; name: string }> }
  | { kind: 'menu_list'; workspace: boolean }
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
  /** Present only for `review-confirm` / `review-edit`: the invoice the reviewer tapped. */
  invoiceId?: string
  /** Present only while in `awaiting_review_edit`: the parsed editor reply (never applied here). */
  editCommand?: ReviewEditCommand
  /** Present only for `review-page`: the 1-based page the reviewer tapped (§P1-7). */
  page?: number
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
  // Inside the in-chat editor, free text is ALWAYS an editor command — including
  // "cancel" / "help", which here exit editing (not the whole session) and are
  // therefore intercepted before the global command block. Interactive reply-ids
  // (menu, edit another invoice, confirm) still route through the branches below.
  if (session.state === 'awaiting_review_edit' && !replyId) {
    const cmd = parseReviewEditCommand(text)
    const nextState: ConversationState = cmd.action === 'cancel' ? 'collecting' : 'awaiting_review_edit'
    return {
      nextState,
      outbound: { kind: 'none' },
      note: `review-edit-${cmd.action}`,
      invoiceId: session.reviewEditInvoiceId ?? undefined,
      editCommand: cmd,
    }
  }
  if (!replyId) {
    if (norm === COMMANDS.CANCEL) {
      return { nextState: 'cancelled',
        outbound: { kind: 'text', body: 'Cancelled. Send Hi anytime to start again.' }, note: 'cancel' }
    }
    if (norm === COMMANDS.HELP || norm === 'help me' || norm === '?') {
      // Onboarded users get the actionable list; pre-onboarding gets guidance text.
      if (session.workspaceId) {
        return { nextState: session.state, outbound: { kind: 'menu_list', workspace: true }, note: 'help' }
      }
      return { nextState: session.state, outbound: { kind: 'text', body: helpText(session.state) }, note: 'help' }
    }
    if (norm === COMMANDS.MENU) {
      // Interactive list is optional navigation; text is preserved as a fallback
      // body so the send layer can degrade to plain text if the list is blocked.
      return { nextState: session.state, outbound: { kind: 'menu_list', workspace: !!session.workspaceId }, note: 'menu' }
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
    // Optional own-GSTIN capture (§P0-1b). Only recognised once the sender has a
    // workspace, so it can never hijack an in-progress onboarding answer (e.g. an
    // org name). A valid value carries `gstin-set:<VALUE>` for the route to persist;
    // skip/invalid/prompt reply with text and change no state.
    if (session.workspaceId) {
      // Bulk approval text command (§P1-6/§P1-7) — recognised only with a workspace,
      // and never while a GSTIN/proactive command is in play. Fixed phrases only, so
      // ordinary text is never mistaken for "approve all". Handled by the route.
      if (norm === 'approve all' || norm === 'approve all pending' || norm === 'approve everything') {
        return { nextState: session.state, outbound: { kind: 'none' }, note: 'review-approve-all' }
      }
      const g = parseGstinCommand(text)
      if (g) {
        if (g.action === 'set') return { nextState: session.state, outbound: { kind: 'none' }, note: `gstin-set:${g.value}` }
        if (g.action === 'clear') return { nextState: session.state, outbound: { kind: 'none' }, note: 'gstin-clear' }
        if (g.action === 'skip') {
          return { nextState: session.state, outbound: { kind: 'text', body: 'OK — no GSTIN saved. Send "My GSTIN <number>" anytime to set it.' }, note: 'gstin-skip' }
        }
        if (g.action === 'invalid') {
          return { nextState: session.state, outbound: { kind: 'text', body: 'That does not look like a valid 15-character GSTIN (example: 27ABCDE1234F1Z5). Send "My GSTIN <number>" again, or "My GSTIN skip" to ignore.' }, note: 'gstin-invalid' }
        }
        return { nextState: session.state, outbound: { kind: 'text', body: 'Send your GSTIN like: My GSTIN 27ABCDE1234F1Z5 — this is the buyer on your purchase bills, so I never mistake your own number for a supplier. Reply "My GSTIN skip" to ignore.' }, note: 'gstin-prompt' }
      }
      // Opt-in proactive delivery (§P1-6). Recognised only with a workspace, and
      // never while a GSTIN command is in play. enable/disable hand off to the route
      // (which persists consent + seals the wa_id only if the flag/key are set).
      const p = parseProactiveCommand(text)
      if (p) {
        if (p.action === 'enable') return { nextState: session.state, outbound: { kind: 'none' }, note: 'proactive-enable' }
        if (p.action === 'disable') return { nextState: session.state, outbound: { kind: 'none' }, note: 'proactive-disable' }
        return { nextState: session.state, outbound: { kind: 'text', body: 'Proactive delivery lets me push your finished register to you without you messaging first — but only while the business has it switched on. Reply "Proactive on" to allow it, or "Proactive off" to stop. You can change this anytime.' }, note: 'proactive-prompt' }
      }
    }
  }
  // Interactive menu selections (Stage 2) are intercepted BEFORE the state
  // switch and reuse the SAME notes the text commands emit — no parallel state
  // machine. A display label never authorizes an action; only the id routes.
  if (replyId && replyId.startsWith(REPLY_IDS.MENU_PREFIX)) {
    return menuTransition(session, replyId)
  }
  // Bulk approval + pagination controls over the review list (§P1-7). These are
  // INTERCEPTED before the per-invoice confirm/edit prefixes so their control ids
  // (which carry no uuid) are never mistaken for a malformed invoice id.
  if (replyId === REPLY_IDS.REVIEW_APPROVE_ALL) {
    return { nextState: session.state, outbound: { kind: 'none' }, note: 'review-approve-all' }
  }
  if (replyId && replyId.startsWith(REPLY_IDS.REVIEW_PAGE_PREFIX)) {
    const n = Number.parseInt(replyId.slice(REPLY_IDS.REVIEW_PAGE_PREFIX.length), 10)
    if (Number.isInteger(n) && n >= 1 && n <= 999) {
      return { nextState: session.state, outbound: { kind: 'none' }, note: 'review-page', page: n }
    }
    // A stale/garbage page id degrades to re-showing the first page (never an action).
    return { nextState: session.state, outbound: { kind: 'none' }, note: 'review-requested' }
  }
  // A tapped "Confirm" row on the Review list: same state, but carry the
  // validated invoice id so the route runs the approval. A malformed/stale id
  // degrades to a re-prompt and never triggers a business action.
  if (replyId && replyId.startsWith(REPLY_IDS.REVIEW_CONFIRM_PREFIX)) {
    const invoiceId = replyId.slice(REPLY_IDS.REVIEW_CONFIRM_PREFIX.length)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invoiceId)) {
      return { nextState: session.state, outbound: { kind: 'none' }, note: 'review-confirm', invoiceId }
    }
    return { nextState: session.state, outbound: { kind: 'none' }, note: 'review-confirm-invalid' }
  }
  // A tapped "Edit" row: enter the numbered field-correction sub-state for that
  // invoice. The validated invoice id is carried so the route renders its editor
  // and persists the edit target; a malformed/stale id degrades to a re-prompt.
  if (replyId && replyId.startsWith(REPLY_IDS.REVIEW_EDIT_PREFIX)) {
    const invoiceId = replyId.slice(REPLY_IDS.REVIEW_EDIT_PREFIX.length)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invoiceId)) {
      return { nextState: 'awaiting_review_edit', outbound: { kind: 'none' }, note: 'review-edit', invoiceId }
    }
    return { nextState: session.state, outbound: { kind: 'none' }, note: 'review-edit-invalid' }
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

/**
 * Route an interactive `billora:menu:*` selection to the SAME note the matching
 * text command emits, so the existing branches handle it (no parallel state
 * machine). Unknown or stale menu ids degrade to a safe re-prompt (the list
 * again) and never trigger an action; a display label is not authorization.
 */
function menuTransition(session: SessionSnapshot, replyId: string): TransitionResult {
  const ws = !!session.workspaceId
  switch (replyId) {
    case REPLY_IDS.MENU_CANCEL:
      return { nextState: 'cancelled',
        outbound: { kind: 'text', body: 'Cancelled. Send Hi anytime to start again.' }, note: 'cancel' }
    case REPLY_IDS.MENU_HELP:
      return ws
        ? { nextState: session.state, outbound: { kind: 'menu_list', workspace: true }, note: 'help' }
        : { nextState: session.state, outbound: { kind: 'text', body: helpText(session.state) }, note: 'help' }
    case REPLY_IDS.MENU_DONE:
      return ws
        ? { nextState: session.state, outbound: { kind: 'none' }, note: 'done' }
        : { nextState: session.state, outbound: { kind: 'text', body: helpText(session.state) }, note: 'done-not-onboarded' }
    case REPLY_IDS.MENU_CHANGE_CLIENT:
      return ws
        ? { nextState: 'awaiting_client_select', outbound: { kind: 'none' }, note: 'change-client-requested' }
        : { nextState: session.state, outbound: { kind: 'text', body: 'Finish setup first — send Hi.' }, note: 'no-workspace' }
    case REPLY_IDS.MENU_ADD_CLIENT:
      return ws
        ? { nextState: 'awaiting_client_name', outbound: { kind: 'text', body: 'Send the new client name.' }, note: 'client-add-requested' }
        : { nextState: session.state, outbound: { kind: 'text', body: 'Finish setup first — send Hi.' }, note: 'no-workspace' }
    case REPLY_IDS.MENU_SET_GSTIN:
      return ws
        ? { nextState: session.state, outbound: { kind: 'text', body: 'Send your GSTIN like: My GSTIN 27ABCDE1234F1Z5 — this is the buyer on your purchase bills, so I never mistake your own number for a supplier. Reply "My GSTIN skip" to ignore.' }, note: 'gstin-prompt' }
        : { nextState: session.state, outbound: { kind: 'text', body: 'Finish setup first — send Hi.' }, note: 'no-workspace' }
    case REPLY_IDS.MENU_PROACTIVE:
      return ws
        ? { nextState: session.state, outbound: { kind: 'text', body: 'Proactive delivery lets me push your finished register to you without you messaging first — but only while the business has it switched on. Reply "Proactive on" to allow it, or "Proactive off" to stop. You can change this anytime.' }, note: 'proactive-prompt' }
        : { nextState: session.state, outbound: { kind: 'text', body: 'Finish setup first — send Hi.' }, note: 'no-workspace' }
    case REPLY_IDS.MENU_STATUS:
      return { nextState: session.state, outbound: { kind: 'none' }, note: 'status-requested' }
    case REPLY_IDS.MENU_REVIEW:
      return { nextState: session.state, outbound: { kind: 'none' }, note: 'review-requested' }
    default:
      // Unknown/stale menu id: re-show the menu, state untouched, no action.
      return { nextState: session.state, outbound: { kind: 'menu_list', workspace: ws }, note: 'menu' }
  }
}

export function menuText(session: SessionSnapshot): string {
  if (!session.workspaceId) return 'Send Hi to begin setup. Commands: Help, Cancel.'
  return [
    'Billora menu:',
    '• Send invoices — PDF, JPG, or PNG',
    '• Change client — pick who new files belong to',
    '• Add client — create a new client',
    '• My GSTIN — set your own GSTIN so it is never read as a supplier',
    '• Proactive on/off — let me push your finished register to you',
    '• Done — finish this batch',
    '• Help • Cancel',
  ].join('\n')
}
