// lib/whatsapp/send.ts — real WhatsApp Cloud API interactive sends (server only).
import { logger } from '@/lib/logger'

/**
 * Send outcomes. Rule 5 separates processing from delivery:
 *   ok        Meta confirmed with a message id
 *   transient network/5xx/429 — a later retry or the outbound queue may succeed
 *   blocked   credentials rejected (expired/revoked token, missing permission).
 *             Retrying cannot help; the operator must reissue the token.
 */
export type SendOutcome = 'ok' | 'transient' | 'blocked'

// Graph API error codes meaning the token/app permission is broken:
// 102 invalid OAuth access token, 190 expired/offline session token,
// 200 permission denied, 210 user not active, 2068 business not on platform.
const BLOCKED_ERROR_CODES = new Set([102, 190, 200, 210, 2068])

function graphBase(): string {
  return `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v21.0'}`
}

async function postMessage(
  payload: Record<string, unknown>,
  correlation: { workbookId?: string } = {},
): Promise<SendOutcome> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN || ''
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || ''
  if (!token || !phoneNumberId) {
    logger.error('[WhatsApp] CREDENTIAL_BLOCKED: send config missing (access token / phone number id); retries suppressed until operator fixes env')
    return 'blocked'
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(`${graphBase()}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    const body = (await res.json().catch(() => null)) as
      {
        messages?: Array<{ id?: string }>
        error?: { message?: string; code?: number; error_subcode?: number; type?: string; fbtrace_id?: string }
      } | null
    const messageId = body?.messages?.[0]?.id
    const outcome: SendOutcome = res.ok && messageId
      ? 'ok'
      : res.status === 401 || res.status === 403
        || (body?.error?.code !== undefined && BLOCKED_ERROR_CODES.has(body.error.code))
        ? 'blocked'
        : 'transient'
    const responseFields = {
      httpStatus: res.status,
      outcome,
      providerMessageIdSuffix: messageId?.slice(-8) ?? null,
      providerErrorCode: body?.error?.code ?? null,
      providerErrorSubcode: body?.error?.error_subcode ?? null,
      providerErrorType: body?.error?.type ?? null,
      // Meta's own description of WHICH parameter it rejected. This names request
      // fields, never recipient data, and is bounded so a verbose message cannot
      // bloat the log — without it a code 100 is undiagnosable in production.
      providerErrorMessage: body?.error?.message?.slice(0, 200) ?? null,
      providerTraceId: body?.error?.fbtrace_id ?? null,
      ...correlation,
    }
    logger.info('[WhatsApp] Meta send response', responseFields)

    if (res.ok && messageId) {
      return 'ok'
    }
    const errorCode = body?.error?.code
    if (res.status === 401 || res.status === 403 || (errorCode !== undefined && BLOCKED_ERROR_CODES.has(errorCode))) {
      // Credential-level failure: alert the operator ONCE per delivery attempt
      // and mark blocked so callers never convert this into a Meta retry loop.
      logger.error('[WhatsApp] CREDENTIAL_BLOCKED: Meta rejected the token; operator must reissue it', {
        status: res.status, code: errorCode ?? null,
      })
      return 'blocked'
    }
    logger.error('[WhatsApp] send failed (transient)', responseFields)
    return 'transient'
  } catch (e) {
    logger.error('[WhatsApp] send error (transient)', { error: e instanceof Error ? e.message : String(e) })
    return 'transient'
  } finally {
    clearTimeout(t)
  }
}

export function sendText(to: string, body: string, correlation?: { workbookId?: string }): Promise<SendOutcome> {
  return postMessage({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }, correlation)
}

/**
 * Send a previously-uploaded media id back to the recipient as a document
 * message. Used to deliver the owner's own encrypted register (decrypted in
 * memory, uploaded via uploadWhatsAppMedia) directly into their chat — no public
 * URL, no raw bucket link. The caption is optional and clamped to Meta's 1024
 * limit; the media id/filename never carry invoice contents.
 */
export function sendDocument(
  to: string,
  args: { mediaId: string; filename: string; caption?: string },
  correlation?: { workbookId?: string },
): Promise<SendOutcome> {
  // Send by media id: Meta derives the type from the stored upload. Declaring a
  // mime_type that differs from the type Meta normalized on upload makes it
  // reject the ENTIRE document with error 100 (Invalid parameter) — so we omit
  // it here. The upload (uploadWhatsAppMedia) still carries the real type.
  const document: Record<string, unknown> = { id: args.mediaId, filename: args.filename }
  if (args.caption) document.caption = args.caption.slice(0, 1024)
  return postMessage({ messaging_product: 'whatsapp', to, type: 'document', document }, correlation)
}

export function sendAccountTypeButtons(to: string): Promise<SendOutcome> {
  return postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Welcome to Billora' },
      body: { text: 'Are you onboarding as an individual or an organization / CA firm?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'billora:account:individual', title: 'Individual' } },
          { type: 'reply', reply: { id: 'billora:account:organization', title: 'Organization' } },
        ],
      },
    },
  })
}

/** Interactive client list + Add client row. Never trusts labels; route validates row ids. */
export function sendClientList(to: string, clients: Array<{ id: string; name: string }>): Promise<SendOutcome> {
  const rows = clients.slice(0, 9).map((c) => ({
    id: `billora:client:${c.id}`,
    title: c.name.slice(0, 24) || 'Client',
  }))
  rows.push({ id: 'billora:client:add', title: 'Add client' })
  return postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Select client' },
      body: { text: 'Choose the client for these invoices, or add a new one.' },
      action: { button: 'Clients', sections: [{ title: 'Clients', rows }] },
    },
  })
}

/** "Apply [client] to those pending files?" — validated reply ids, not labels. */
export function sendConfirmApply(to: string, count: number, clientName: string): Promise<SendOutcome> {
  return postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Pending files' },
      body: {
        text: `You have ${count} file${count === 1 ? '' : 's'} held for assignment. Apply them to ${clientName.slice(0, 40)}? (Or send yes / no.)`,
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'billora:confirm:yes', title: 'Apply' } },
          { type: 'reply', reply: { id: 'billora:confirm:no', title: 'Keep held' } },
        ],
      },
    },
  })
}

/**
 * Optional navigation menu — an interactive Cloud API list (up to 10 rows).
 * Never an upload gate: invoices are accepted regardless. With no workspace
 * only Help/Cancel are offered (setup guidance is a reply, not an action).
 * Row ids are the `billora:menu:*` namespace the conversation layer validates;
 * display titles are never treated as authorization.
 */
export function sendMenu(to: string, opts: { workspace: boolean }): Promise<SendOutcome> {
  const rows = opts.workspace
    ? [
        { id: 'billora:menu:status', title: 'Status & how to send' },
        { id: 'billora:menu:change_client', title: 'Change client' },
        { id: 'billora:menu:add_client', title: 'Add client' },
        { id: 'billora:menu:review', title: 'Review held / flagged' },
        { id: 'billora:menu:done', title: 'Done with this batch' },
        { id: 'billora:menu:help', title: 'Help' },
        { id: 'billora:menu:cancel', title: 'Cancel' },
      ]
    : [
        { id: 'billora:menu:help', title: 'Help' },
        { id: 'billora:menu:cancel', title: 'Cancel' },
      ]
  return postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Billora menu' },
      body: {
        text: opts.workspace
          ? 'Choose an option — or just send an invoice PDF/photo anytime; you never need the menu to upload.'
          : 'Welcome to Billora. Choose an option to get started, or send Hi.',
      },
      action: { button: 'Options', sections: [{ title: 'Menu', rows }] },
    },
  })
}

/**
 * Review confirmation list: one row per batchable needs_review invoice, labeled
 * with the EXACT extracted invoice number / vendor / total the reviewer must
 * affirm. Row ids are `billora:review:confirm:<invoiceId>` (validated by the
 * conversation layer); the display title is never the authorization. Tapping a
 * row confirms the values shown on it — it is not a blind "approve" button.
 */
export function sendReviewList(
  to: string,
  invoices: Array<{ invoiceId: string; invoiceNumber: string; vendorName: string | null; total: string | null }>,
): Promise<SendOutcome> {
  const rows = invoices.slice(0, 10).map((inv) => {
    // Cloud API caps a list row TITLE at 24 chars; the longer detail goes in the
    // optional DESCRIPTION (max 72). Exceeding the title limit makes Meta reject
    // the entire list (error 100), so keep the title to the number + total.
    const title = `#${inv.invoiceNumber.slice(0, 14)}${inv.total ? ` \u20b9${inv.total}` : ''}`.slice(0, 24)
    const description = `${(inv.vendorName || 'Invoice').slice(0, 40)}${inv.total ? ` \u00b7 \u20b9${inv.total}` : ''} \u00b7 tap to confirm`.slice(0, 72)
    return { id: `billora:review:confirm:${inv.invoiceId}`, title, description }
  })
  return postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Confirm for review' },
      body: {
        text: 'Tap an invoice to confirm its number and approve it for the register. It is filed only under the month on its own invoice date.',
      },
      action: { button: 'Confirm', sections: [{ title: 'Needs review', rows }] },
    },
  })
}

/**
 * Editable-review picker: one row per needs_review invoice the reviewer may open
 * to CORRECT fields in-chat. Row ids are `billora:review:edit:<invoiceId>` (the
 * conversation layer validates that prefix + uuid); the display title is never the
 * authorization. Unlike the confirm list this makes NO approval promise — tapping a
 * row only opens the numbered editor for that one invoice, so nothing is approved
 * or filed until a later explicit APPROVE (§7: an edit is not an approval).
 */
export function sendReviewEditList(
  to: string,
  invoices: Array<{ invoiceId: string; invoiceNumber: string; vendorName: string | null; total: string | null }>,
): Promise<SendOutcome> {
  const rows = invoices.slice(0, 10).map((inv) => {
    // Same Meta caps as sendReviewList: title <=24, description <=72, or the
    // whole list is rejected (error 100).
    const title = `#${inv.invoiceNumber.slice(0, 14)}${inv.total ? ` \u20b9${inv.total}` : ''}`.slice(0, 24)
    const description = `${(inv.vendorName || 'Invoice').slice(0, 40)}${inv.total ? ` \u00b7 \u20b9${inv.total}` : ''} \u00b7 tap to edit`.slice(0, 72)
    return { id: `billora:review:edit:${inv.invoiceId}`, title, description }
  })
  return postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Edit a flagged invoice' },
      body: {
        text: 'Tap an invoice to correct its fields (number, GSTIN, date, supplier, amounts). Saving a correction keeps it flagged until you approve it.',
      },
      action: { button: 'Edit', sections: [{ title: 'Needs review', rows }] },
    },
  })
}
