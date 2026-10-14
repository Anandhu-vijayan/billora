// app/api/whatsapp/route.ts — Fast gateway + Phase 2 onboarding + upload decision engine.
import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin, bucketFor } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { encryptFile, deriveObjectKey, resolveFileKeyConfig, isEncryptionConfigFailure } from '@/lib/encryption/files';
import { validateInvoiceMedia, isPermanentMediaFormatFailure, type ValidatedMedia } from '@/lib/media/file-type';
import { downloadWhatsAppMedia, isPermanentMediaFailure, type DownloadedMedia } from '@/lib/whatsapp/media';
import { senderHmac, senderLabel } from '@/lib/whatsapp/identity';
import { verifyWebhookSignature, safeTokenEqual } from '@/lib/whatsapp/verify';
import { transition, menuText, type ConversationState, type SessionSnapshot, type TransitionResult } from '@/lib/whatsapp/conversation';
import { loadSession, loadAccountType, saveSession, isExpired, expiredSnapshot, updateSessionDeliveryState } from '@/lib/whatsapp/sessions';
import { sendText, sendAccountTypeButtons, sendClientList, sendConfirmApply, sendMenu, type SendOutcome } from '@/lib/whatsapp/send';
import {
  ensureIndividualWorkspace, ensureOrganizationWorkspace,
  listClients, createClient, verifyClientInWorkspace,
} from '@/lib/whatsapp/provision';
import {
  claimIntakeRow, isDurablyAccepted, markIntakeAccepted, markIntakeFailed,
  recordMediaIntake, recordPendingUpload, countWaitingUploads, assignPendingUploads,
} from '@/lib/whatsapp/intake';
import {
  ensureBatchRegisters, collectFinalizeState, composeDoneMessage, composeReviewMessage,
} from '@/lib/whatsapp/finalize';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const receivedToken = searchParams.get('hub.verify_token');
  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || '';
  // Minimal operational log: outcome only, no token material or comparison diagnostics.
  const verified = mode === 'subscribe' && !!expectedToken && !!receivedToken
    && safeTokenEqual(receivedToken, expectedToken);
  logger.info('[WhatsApp] verify attempt', { mode: mode ?? null, verified });
  if (verified) {
    return new Response(searchParams.get('hub.challenge') || '', {
      status: 200, headers: { 'Content-Type': 'text/plain' },
    });
  }
  return new Response('Forbidden', { status: 403 });
}

type Db = SupabaseClient;

interface IncomingMedia { id?: string; mime_type?: string; caption?: string; filename?: string }
interface InteractiveReply { id?: string; title?: string }
interface IncomingMessage {
  id?: string; type?: string; from?: string; timestamp?: string;
  text?: { body?: string }; image?: IncomingMedia; document?: IncomingMedia;
  interactive?: { type?: string; button_reply?: InteractiveReply; list_reply?: InteractiveReply };
}

/**
 * Provisioning + conditional persist FIRST, outbound sends SECOND.
 * Ordering guarantee: the session row is the source of truth. A failed
 * conditional save (concurrent delivery won the race) throws STALE_SESSION so
 * the caller returns retryable 503 and sends nothing — no contradictory replies.
 * Rule 5 — processing success is separate from message delivery: a failed
 * send NEVER rewinds the persisted state or re-triggers intake. Transient
 * failures are deferred (Phase 6 outbound queue resends them); credential
 * blocks are alerted in send.ts without provoking a Meta retry loop.
 */
async function handleOnboardingSideEffects(
  db: Db, hmac: string, label: string, to: string, providerMessageId: string,
  snapshot: SessionSnapshot, result: TransitionResult,
): Promise<{ workspaceId: string | null; clientId: string | null }> {
  let workspaceId: string | null = snapshot.workspaceId;
  let clientId: string | null = snapshot.clientId;
  let pendingClientId: string | null = snapshot.pendingClientId;
  let assignedNow = 0;

  // ---- provisioning + pending resolution (may rewrite nextState) ----
  if (result.note === 'individual-selected') {
    workspaceId = await ensureIndividualWorkspace(db, hmac);
    result.workspaceId = workspaceId;
    // Individuals carry no client ambiguity: file held uploads immediately.
    assignedNow = await assignPendingUploads(db, hmac, { workspaceId, clientId: null });
  } else if (result.note.startsWith('org-name:')) {
    const ensured = await ensureOrganizationWorkspace(db, hmac, result.note.slice(9));
    workspaceId = ensured.workspaceId;
    result.workspaceId = workspaceId;
  } else if (result.note.startsWith('client-name:')) {
    if (!workspaceId) throw new Error('ONBOARDING_FAULT: no workspace for client creation');
    clientId = await createClient(db, workspaceId, result.note.slice(12));
    result.clientId = clientId;
  } else if (result.note === 'client-selected' && result.clientId) {
    if (!workspaceId || !(await verifyClientInWorkspace(db, workspaceId, result.clientId))) {
      logger.info('[WhatsApp] unauthorized client selection rejected', { sender: label });
      result.nextState = 'awaiting_client_select';
      result.clientId = undefined;
      result.outbound = { kind: 'none' };
      result.note = 'client-selection-rejected';
    } else {
      clientId = result.clientId;
    }
  } else if (result.note === 'pending-confirm-yes') {
    if (!workspaceId || !pendingClientId) {
      // The question outlived its candidate (client deleted, stale retry):
      // degrade to plain collection, held files stay held.
      pendingClientId = null;
      result.note = 'pending-confirm-stale';
    } else {
      clientId = pendingClientId;
      result.clientId = clientId;
      assignedNow = await assignPendingUploads(db, hmac, { workspaceId, clientId });
      pendingClientId = null;
    }
  } else if (result.note === 'pending-confirm-no') {
    // Client stays active for FUTURE uploads; held files are NOT reassigned.
    pendingClientId = null;
  }

  // "Remember context, never guess a client": when a client just became
  // resolved and files are held for this sender, ask before applying it.
  if ((result.note === 'client-selected' || result.note.startsWith('client-name:')) && clientId && workspaceId) {
    const waiting = await countWaitingUploads(db, hmac);
    if (waiting > 0) {
      result.nextState = 'awaiting_pending_confirm';
      result.outbound = { kind: 'none' };
      pendingClientId = clientId;
    }
  }

  // Persist BEFORE any outbound send. A `false` return means a concurrent
  // delivery already advanced this sender: abort without sending.
  const saved = await saveSession(db, hmac, snapshot.lastProviderMessageId, {
    state: result.nextState,
    workspace_id: result.workspaceId ?? workspaceId,
    client_id: result.clientId ?? clientId,
    batch_id: result.batchId ?? snapshot.batchId,
    pending_client_id: pendingClientId,
    last_provider_message_id: providerMessageId,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  if (!saved) throw new Error('STALE_SESSION: concurrent delivery advanced this sender; retry');
  logger.info('[WhatsApp] onboarding persisted', { sender: label, state: result.nextState });

  // Outbound sends happen only after durable persistence. Failures never throw:
  // the intake stays accepted and delivery is tracked separately (rule 5).
  // A failed (transient/blocked) TEXT reply is remembered and best-effort
  // resent on the sender's NEXT inbound message — never re-running a completed
  // business operation. Inbound idempotency (webhook_events) is untouched.
  let sendOutcome: SendOutcome = 'ok';
  const track = (outcome: SendOutcome): void => {
    if (outcome === 'blocked') sendOutcome = 'blocked';
    else if (outcome === 'transient' && sendOutcome !== 'blocked') sendOutcome = 'transient';
  };
  const deliverText = async (body: string): Promise<void> => {
    const o = await sendText(to, body);
    if (o === 'ok') await updateSessionDeliveryState(db, hmac, { pending_reply_body: null, last_reply_error_code: null });
    else await updateSessionDeliveryState(db, hmac, { pending_reply_body: body, last_reply_error_code: o });
    track(o);
  };
  // Menu/list/button sends are re-derivable, so a failed one records only the
  // error code (no body resend); a failed interactive list degrades to text.
  const deliverMenu = async (workspace: boolean): Promise<void> => {
    const o = await sendMenu(to, { workspace });
    if (o === 'ok') { await updateSessionDeliveryState(db, hmac, { last_reply_error_code: null }); track(o); return }
    await updateSessionDeliveryState(db, hmac, { last_reply_error_code: o });
    await deliverText(menuText({ ...snapshot, workspaceId: workspace ? (workspaceId ?? snapshot.workspaceId) : null }));
  };
  const countNeedsReview = async (): Promise<number> => {
    if (!workspaceId) return 0;
    const { count } = await db.from('invoices').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'needs_review');
    return count ?? 0;
  };
  // "Done" is a real finalization, not just an ack. It re-affirms a register job
  // for every eligible batch, then reads the CURRENT state and sends a TRUTHFUL
  // result. It never claims the Excel is ready until a verified generated_workbooks
  // row exists (build_register inserts that row only after an encrypted upload
  // succeeded), so a ready claim always implies the stored file is available.
  // While extraction/register jobs are still running it says "still working" and
  // defers the final result to the register job's delivery. Repeated Done is
  // idempotent: scheduling is deduped and the reads never mutate processing state.
  const deliverDone = async (): Promise<void> => {
    if (!workspaceId) { await deliverText('Nothing to finalize yet — send Hi to start, or just send an invoice.'); return; }
    try {
      await ensureBatchRegisters(db, workspaceId);
      const counts = await collectFinalizeState(db, workspaceId);
      const base = (process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '');
      const link = base && counts.readyWorkbookIds.length > 0
        ? `${base}/api/exports/${counts.readyWorkbookIds[0]}/download`
        : null;
      await deliverText(composeDoneMessage(counts, { link }));
    } catch (e) {
      // Finalization is read/schedule only; a failure here must never lose work or
      // rewind intake. Fall back to an honest "queued" message (no ready claim).
      logger.warn('[WhatsApp] Done finalization deferred', {
        sender: label, error: e instanceof Error ? e.message : String(e),
      });
      await deliverText('Done — your uploads are queued. I\'ll send your register here once processing finishes.');
    }
  };
  const sendStateMessage = async (): Promise<void> => {
    if (result.note === 'individual-selected') {
      const held = assignedNow > 0 ? ` I also filed the ${assignedNow} invoice file(s) you sent earlier.` : '';
      await deliverText(`Your workspace is ready. Send invoice PDFs or photos here.${held}`);
    } else if (result.note.startsWith('org-name:')) {
      const clients = await listClients(db, workspaceId as string);
      if (clients.length > 0) { track(await sendClientList(to, clients)); }
      else {
        await deliverText('Organization workspace created. No clients yet — send the first client name.');
      }
    } else if (result.note === 'reprompt-client-list' || result.note === 're-list-clients'
      || result.note === 'change-client-requested') {
      if (workspaceId) track(await sendClientList(to, await listClients(db, workspaceId)));
    } else if (result.note.startsWith('client-name:')) {
      await deliverText('Client saved. Send invoice PDFs or photos here.');
    } else if (result.note === 'client-selected') {
      await deliverText('Client selected. Send invoice PDFs or photos here.');
    } else if (result.note === 'client-selection-rejected') {
      await deliverText('That client is not available. Choose from the list below.');
      if (workspaceId) track(await sendClientList(to, await listClients(db, workspaceId)));
    } else if (result.note === 'awaiting-pending-confirm' || result.note === 'pending-confirm-stale') {
      // noop: handled by the confirm branch below / generic text.
    } else if (result.note === 'pending-confirm-yes') {
      await deliverText(assignedNow > 0
        ? `Applied to ${assignedNow} file(s) — they're queued for processing. Send more invoices anytime.`
        : 'Applied. Nothing was held for you. Send invoice PDFs or photos here.');
    } else if (result.note === 'welcome-back') {
      const waiting = await countWaitingUploads(db, hmac);
      await deliverText(waiting > 0
        ? `Welcome back to Billora. Note: ${waiting} earlier file(s) are still held for a client — send Change client to assign them, or just send more invoices.`
        : 'Welcome back to Billora — send invoice PDFs or photos here. Send Menu for options.');
    } else if (result.note === 'done') {
      await deliverDone();
    } else if (result.note === 'status-requested') {
      const waiting = await countWaitingUploads(db, hmac).catch(() => 0);
      await deliverText(!workspaceId
        ? "You're not set up yet — send Hi to begin, or just send an invoice and I'll hold it safely."
        : `You're ready. Send invoice PDFs or photos anytime.${waiting > 0 ? ` ${waiting} file(s) are held for a client — send Change client to assign them.` : ''} Send Done when this batch is finished, or Menu for options.`);
    } else if (result.note === 'review-requested') {
      const waiting = await countWaitingUploads(db, hmac).catch(() => 0);
      let body: string;
      if (!workspaceId) {
        body = "You're not set up yet — send Hi to begin, or just send an invoice.";
      } else {
        try {
          const counts = await collectFinalizeState(db, workspaceId);
          const base = (process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '');
          const link = base && counts.readyWorkbookIds.length > 0
            ? `${base}/api/exports/${counts.readyWorkbookIds[0]}/download`
            : null;
          body = composeReviewMessage(counts, { link });
        } catch {
          const flagged = await countNeedsReview().catch(() => 0);
          body = flagged > 0
            ? `${flagged} invoice(s) flagged for review.`
            : 'Nothing needs your attention right now — keep sending invoices.';
        }
      }
      const held = waiting > 0 ? ` Also: ${waiting} file(s) are held for a client — send Change client to assign them.` : '';
      await deliverText(body + held);
    } else if (result.outbound.kind === 'menu_list') {
      await deliverMenu(result.outbound.workspace);
    } else if (result.outbound.kind === 'text') {
      await deliverText(result.outbound.body);
    } else if (result.outbound.kind === 'account_type_buttons') {
      track(await sendAccountTypeButtons(to));
    }
    // Held files + a just-resolved client: the explicit confirmation question.
    if (result.nextState === 'awaiting_pending_confirm' && pendingClientId && workspaceId) {
      const waiting = await countWaitingUploads(db, hmac);
      const clients = await listClients(db, workspaceId);
      const chosen = clients.find((c) => c.id === pendingClientId);
      track(await sendConfirmApply(to, waiting, chosen?.name ?? 'the selected client'));
    }
  };
  await sendStateMessage();
  if (sendOutcome !== 'ok') {
    logger.warn('[WhatsApp] outbound send deferred; processing state persisted', {
      sender: label, outcome: sendOutcome,
    });
  }
  return { workspaceId: result.workspaceId ?? workspaceId, clientId: result.clientId ?? clientId };
}

export async function POST(request: Request) {
  try {
    const rawText = await request.text();
    if (!rawText || rawText.trim().length === 0) {
      return NextResponse.json({ status: 'SKIPPED_EMPTY_BODY' }, { status: 200 });
    }
    // Signature gate: X-Hub-Signature-256 over the RAW body, verified before any
    // intake row is created. Production fails closed when the app secret is
    // unconfigured; dev without a secret proceeds (local/smoke testing only).
    const appSecret = process.env.WHATSAPP_APP_SECRET || '';
    if (!appSecret && process.env.NODE_ENV === 'production') {
      logger.error('[WhatsApp] WHATSAPP_APP_SECRET unconfigured in production; delivery rejected');
      return new Response('Forbidden', { status: 401 });
    }
    if (appSecret && !verifyWebhookSignature(rawText, request.headers.get('x-hub-signature-256'), appSecret)) {
      logger.warn('[WhatsApp] webhook signature invalid; delivery rejected');
      return new Response('Forbidden', { status: 401 });
    }
    let payload: { entry?: Array<{ changes?: Array<{ value?: {
      messages?: IncomingMessage[]; statuses?: Array<{ status?: string }>;
    } }> }> };
    try { payload = JSON.parse(rawText); }
    catch {
      logger.info('[WhatsApp] non-JSON body skipped', {
        preview: rawText.slice(0, 200), contentType: request.headers.get('content-type'),
      });
      return NextResponse.json({ status: 'SKIPPED_NON_JSON_BODY' }, { status: 200 });
    }
    const value = payload.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages ?? [];
    if (messages.length === 0) {
      // Delivery receipts/statuses carry no inbound message to process.
      logger.info('[WhatsApp] non-message delivery skipped', {
        hasMessages: !!value?.messages, statuses: value?.statuses?.[0]?.status ?? null,
      });
      return NextResponse.json({ status: 'SKIPPED_STATUS_UPDATE' }, { status: 200 });
    }
    const db = getSupabaseAdmin();
    // Process EVERY message in the delivery: a 503 makes Meta redeliver the
    // whole payload and the intake ledger skips messages already accepted.
    let retryable = false;
    for (const message of messages) {
      if (!message?.id) continue;
      if (await handleSingleMessage(db, message) === 'retryable') retryable = true;
    }
    if (retryable) {
      return NextResponse.json({ status: 'RETRYABLE_PROCESSING_ERROR' }, { status: 503 });
    }
    return NextResponse.json({ status: 'ACCEPTED_FOR_QUEUE' }, { status: 200 });
  } catch (error: unknown) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    logger.error('[Gateway Interface Router] runtime anomaly', { error: detail });
    const code = /Missing Supabase env|Invalid environment/i.test(detail) ? 'CONFIG_ERROR'
      : /webhook_events|relation .* does not exist/i.test(detail) ? 'DB_TABLE_MISSING'
      : 'SYSTEM_ROUTING_FAULT';
    const retryable = /CONFIG_ERROR|DB_TABLE_MISSING/.test(code) ? 503 : 500;
    return NextResponse.json({ status: code, detail }, { status: retryable });
  }
}

type MessageOutcome = 'processed' | 'retryable'

/**
 * Claim -> process -> durably accept exactly one provider message. Only an
 * `accepted` row suppresses reprocessing; `received`/`failed` rows reprocess
 * on Meta redelivery. Retries stay idempotent end to end.
 */
async function handleSingleMessage(db: Db, message: IncomingMessage): Promise<MessageOutcome> {
  const providerMessageId: string = message.id as string;
  const shortId = providerMessageId.slice(-8);
  logger.info('[WhatsApp] webhook received', {
    hasMessages: true, shortId, messageType: message.type ?? null, statuses: null,
  });
  let intake: Awaited<ReturnType<typeof claimIntakeRow>>;
  try {
    intake = await claimIntakeRow(db, providerMessageId);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    logger.error('[WhatsApp] intake claim failed', { shortId, error: detail });
    return 'retryable';
  }
  if (!intake.created && isDurablyAccepted(intake.row)) {
    logger.info('[WhatsApp] duplicate accepted event skipped', { shortId });
    return 'processed';
  }
  if (!intake.created) {
    logger.info('[WhatsApp] retry reprocessing', { shortId, priorStatus: intake.row.status });
  }
  // Any throw before markIntakeAccepted leaves status received/failed -> Meta retries.
  try {
    await processMessage(db, message, providerMessageId, shortId);
    await markIntakeAccepted(db, providerMessageId);
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const code = (e instanceof Error ? e.message : detail).split(':')[0] || 'PROCESSING_ERROR';
    if (isPermanentMediaFailure(e)) {
      // Expired/blocked credential: 503 would loop Meta redeliveries forever
      // and a retry can never succeed. Accept the event as final (audit code
      // recorded), alert the operator, and ask the sender to resend once the
      // token is reissued. Delivery itself is best-effort (rule 5).
      logger.error('[WhatsApp] MEDIA_CREDENTIAL_BLOCKED: media unrecoverable with current token; operator must reissue WHATSAPP_ACCESS_TOKEN', {
        shortId, error: code, detail: detail.slice(0, 200),
      });
      if (message.from) {
        await sendText(message.from, 'I could not retrieve that file right now (a system credential expired). Please resend the invoice in a few minutes.').catch(() => undefined);
      }
      await markIntakeAccepted(db, providerMessageId, detail.slice(0, 120)).catch(() => undefined);
      return 'processed';
    }
    if (isEncryptionConfigFailure(e)) {
      // Encryption keys are a deploy-time contract: a missing/malformed key is
      // an operator-configuration error that NO retry can fix. Returning 503
      // would make Meta redeliver the message in a loop, so accept this
      // delivery as final with a stable audit code (webhook_events stays the
      // idempotency ledger: a genuine later redelivery of an ACCEPTED event is
      // skipped, so the sender below is notified at most once per message),
      // alert the operator, and tell the sender the truth: nothing was saved.
      logger.error('[WhatsApp] ENCRYPTION_CONFIG: file encryption is not configured; nothing was stored — operator must set ENCRYPTION_MASTER_KEY + STORAGE_PATH_KEY and restart', {
        shortId, code: 'ENCRYPTION_CONFIG',
      });
      if (message.from) {
        await sendText(message.from, 'I could not file that invoice — a required system setting is missing on our side, so nothing was saved. The account owner needs to finish setup; please resend afterwards.').catch(() => undefined);
      }
      await markIntakeAccepted(db, providerMessageId, 'ENCRYPTION_CONFIG').catch(() => undefined);
      return 'processed';
    }
    if (isStorageConfigFailure(e)) {
      // The private bucket is not yet configured to accept the encrypted
      // container's transport type (application/octet-stream). This is an
      // operator/schema-delivery gap that no retry can fix: returning 503 would
      // loop Meta redeliveries and re-download the same media forever. Accept as
      // final with a stable audit code, alert the operator, and tell the sender
      // the truth — nothing was saved.
      logger.error('[WhatsApp] STORAGE_CONFIG: private storage rejected the encrypted upload; operator must apply the invoices bucket migration', {
        shortId, code: 'STORAGE_CONFIG',
      });
      if (message.from) {
        await sendText(message.from, 'I could not file that invoice — our private storage is mid-setup, so nothing was saved. The account owner needs to finish a configuration step; please resend afterwards.').catch(() => undefined);
      }
      await markIntakeAccepted(db, providerMessageId, 'STORAGE_CONFIG').catch(() => undefined);
      return 'processed';
    }
    await markIntakeFailed(db, providerMessageId, code).catch(() => undefined);
    logger.error('[WhatsApp] processing failed, retryable', { shortId, error: code, detail: detail.slice(0, 200) });
    return 'retryable';
  }
  logger.info('[WhatsApp] accepted for queue', { shortId });
  return 'processed';
}

/**
 * Best-effort resend of a reply that failed delivery earlier (rule 5 decouples
 * outbound from inbound). Fires at the top of a NEW inbound message and only
 * sends — it never re-runs intake or onboarding side effects, so a completed
 * business operation cannot be duplicated. Cleared on success; left stored on
 * any non-ok so the next message retries. Never throws.
 */
async function resendPendingReply(db: Db, hmac: string, to: string): Promise<void> {
  try {
    const { data } = await db.from('whatsapp_sessions').select('pending_reply_body')
      .eq('sender_hmac', hmac).maybeSingle();
    const body = (data?.pending_reply_body as string | null) ?? null;
    if (!body) return;
    const o = await sendText(to, body);
    if (o === 'ok') {
      await updateSessionDeliveryState(db, hmac, { pending_reply_body: null, last_reply_error_code: null });
      logger.info('[WhatsApp] deferred reply resent');
    }
  } catch { /* delivery is best-effort; ignore and try again next message */ }
}

/**
 * Onboarding + upload decision engine for one message. Throws only when the
 * work is NOT durably recorded (caller marks intake failed -> Meta retries).
 * Media lifecycle: validate type -> store privately + SHA-256 -> invoice
 * (received) + job (queued) — or a pending_uploads hold when workspace/client
 * is unresolved ("receive first, ask later"). Held paths are deterministic
 * per provider media id, so webhook redelivery never duplicates a hold.
 */
async function processMessage(
  db: Db, message: IncomingMessage, providerMessageId: string, shortId: string,
): Promise<void> {
  const replyId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || null;
  const textBody = message.text?.body ?? null;
  // Decoupled outbound retry: if a previous reply failed delivery, resend it
  // now (send only — no business operation re-runs), before normal processing.
  if (message.from) {
    try { await resendPendingReply(db, senderHmac(message.from), message.from); } catch { /* best effort */ }
  }
  let onboardingWorkspaceId: string | null = null;
  let onboardingClientId: string | null = null;
  if ((message.type === 'text' || message.type === 'interactive') && message.from) {
    const hmac = senderHmac(message.from);
    const label = senderLabel(hmac);
    const stored = await loadSession(db, hmac);
    let snapshot: SessionSnapshot = isExpired(stored.updated_at)
      ? expiredSnapshot(stored, hmac)
      : { senderHmac: hmac, state: stored.state as ConversationState,
          workspaceId: stored.workspace_id, clientId: stored.client_id,
          batchId: stored.batch_id, pendingClientId: stored.pending_client_id ?? null,
          lastProviderMessageId: stored.last_provider_message_id,
          expired: false };
    // Session row lost its linkage but the identity is onboarded: backfill so
    // returning users never repeat setup.
    if (!snapshot.workspaceId) {
      const linked = await db.from('whatsapp_identities').select('workspace_id')
        .eq('sender_hmac', hmac).maybeSingle();
      const linkedWs = (linked.data?.workspace_id as string | null) ?? null;
      if (linkedWs) snapshot = { ...snapshot, workspaceId: linkedWs };
    }
    const result = transition({ session: snapshot, replyId, text: textBody, providerMessageId });
    logger.info('[WhatsApp] onboarding transition', { sender: label, note: result.note });
    const out = await handleOnboardingSideEffects(db, hmac, label, message.from, providerMessageId, snapshot, result);
    onboardingWorkspaceId = out.workspaceId;
    onboardingClientId = out.clientId;
  }
  const media = message.type === 'image' ? message.image
    : message.type === 'document' ? message.document : undefined;
  const mediaId = media?.id;
  if (!mediaId) {
    if (message.type === 'image' || message.type === 'document') {
      logger.info('[WhatsApp] media message without media id', { shortId });
      throw new Error('MEDIA_MISSING_ID: retryable media without provider id');
    }
    return;
  }
  if (!message.from) throw new Error('MEDIA_MISSING_SENDER: media without from address');
  // Encryption keys are required before ANY file handling, so validate them
  // FIRST: a misconfigured deploy must not pay for a media download it can
  // never store (fail-closed: plaintext is never written, retries never help).
  const { masterKeyHex, pathKeyHex } = resolveFileKeyConfig();
  logger.info('[WhatsApp] media intake start', { shortId });
  const mHmac = senderHmac(message.from);
  const mSession = await loadSession(db, mHmac);

  // Download, then validate the ACTUAL bytes. WhatsApp's declared mime /
  // filename / extension are hints only — the magic-byte sniff is authoritative,
  // so a mislabeled, unsupported or oversized file is rejected here: nothing is
  // stored, no DB error is raised, and the intake settles accepted (a permanent
  // format/size failure must NEVER trigger a Meta retry / re-download loop).
  let downloaded: DownloadedMedia;
  try {
    downloaded = await downloadWhatsAppMedia({
      mediaId, accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '', declaredMime: media?.mime_type,
    });
  } catch (e) {
    if (isPermanentMediaFormatFailure(e)) {
      logger.info('[WhatsApp] media rejected by declared size', { shortId, reason: (e as Error).message });
      await sendText(message.from, (e as { userReply: string }).userReply);
      return;
    }
    throw e;
  }
  let validated: ValidatedMedia;
  try {
    validated = validateInvoiceMedia({
      buffer: downloaded.buffer, declaredMime: downloaded.contentType, declaredFilename: media?.filename ?? null,
    });
  } catch (e) {
    if (isPermanentMediaFormatFailure(e)) {
      logger.info('[WhatsApp] unsupported or oversized media rejected', { shortId, reason: (e as Error).message });
      await sendText(message.from, (e as { userReply: string }).userReply);
      return;
    }
    throw e;
  }
  // Persist the VALIDATED original MIME + extension (never the provider hint) so
  // extraction routes on the true format. The stored blob is always the opaque
  // octet-stream container; the original bytes stay intact inside it.
  downloaded.contentType = validated.mime;
  downloaded.extension = validated.extension;
  const sha256Hex = createHash('sha256').update(downloaded.buffer).digest('hex');
  const workspaceId = onboardingWorkspaceId ?? mSession.workspace_id;
  const clientId = onboardingClientId ?? mSession.client_id;

  // Envelope-encrypt the ORIGINAL bytes before they ever touch storage (keys
  // were validated above, before the download). The SHA-256 above stays over
  // plaintext for dedup + integrity; the stored blob is the self-describing
  // container.
  const invoiceBucket = bucketFor('invoices');

  // Deterministic private hold path: redelivery of the same provider media id
  // resolves to the same opaque object + upserts the same row — never a
  // duplicate hold, and never collides with an unrelated file.
  const holdMedia = async (): Promise<string> => {
    const pendingPath = deriveObjectKey('pending', mediaId, pathKeyHex);
    const enc = encryptFile(downloaded.buffer, masterKeyHex, { context: pendingPath });
    const { error: pendingUploadError } = await db.storage.from(invoiceBucket)
      .upload(pendingPath, enc.container, {
        contentType: 'application/octet-stream', upsert: true,
        metadata: { original_mime: validated.mime, original_extension: validated.extension },
      });
    if (pendingUploadError) throw new Error(`STORAGE_UPLOAD_ERROR: ${pendingUploadError.message}`);
    await recordPendingUpload(db, {
      senderHmac: mHmac, objectPath: pendingPath, originalFileName: media?.filename ?? null,
      contentType: downloaded.contentType, fileSha256Hex: sha256Hex,
      sizeBytes: enc.sizeBytes, providerMediaId: mediaId, keyVersion: enc.keyVersion,
    });
    return pendingPath;
  };

  if (!workspaceId) {
    // Account type unknown: preserve the file, then continue/ask setup.
    await holdMedia();
    if (mSession.state === 'awaiting_account_type') {
      await sendText(message.from, 'I saved that invoice safely. Finish setup above — pick Individual or Organization — and I will file it automatically.');
    } else {
      await sendText(message.from, 'I saved that invoice safely. Before I file it: are you onboarding as an Individual or an Organization / CA firm?');
      await sendAccountTypeButtons(message.from);
    }
    return;
  }

  const accountType = await loadAccountType(db, mHmac);
  if (accountType === 'organization' && !clientId) {
    // Client unresolved: hold and ask. NEVER guess a client.
    await holdMedia();
    await saveSession(db, mHmac, mSession.last_provider_message_id, {
      state: 'awaiting_client_select', workspace_id: workspaceId, client_id: clientId,
      batch_id: mSession.batch_id, pending_client_id: mSession.pending_client_id,
      last_provider_message_id: providerMessageId,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).catch(() => undefined); // best effort: the file is durably held either way
    await sendText(message.from, 'I saved that invoice — but I must not guess which client it belongs to. Choose a client (or add one) below.');
    await sendClientList(message.from, await listClients(db, workspaceId));
    return;
  }

  // Assigned path is deterministic too (per provider media id): combined with
  // the invoices.file_object_path unique constraint, a redelivery can never
  // store or queue the same file twice, whatever the retry timing.
  const objectPath = deriveObjectKey('invoices', mediaId, pathKeyHex);
  const enc = encryptFile(downloaded.buffer, masterKeyHex, { context: objectPath });
  const { error: uploadError } = await db.storage.from(invoiceBucket)
    .upload(objectPath, enc.container, {
      contentType: 'application/octet-stream', upsert: true,
      metadata: { original_mime: validated.mime, original_extension: validated.extension },
    });
  if (uploadError) throw new Error(`STORAGE_UPLOAD_ERROR: ${uploadError.message}`);
  const recorded = await recordMediaIntake(db, {
    workspaceId, clientId, objectPath,
    originalFileName: media?.filename ?? null, contentType: downloaded.contentType,
    fileSha256Hex: sha256Hex, keyVersion: enc.keyVersion, sizeBytes: enc.sizeBytes,
  });
  const waiting = await countWaitingUploads(db, mHmac).catch(() => 0);
  const deduped = recorded.invoicePreexisting || recorded.jobPreexisting;
  logger.info('[WhatsApp] media intake recorded', {
    shortId, size: enc.sizeBytes,
    invoice: recorded.invoiceId.slice(0, 8), job: recorded.jobId.slice(0, 8),
    deduped,
  });
  // Acknowledge a freshly-filed invoice so a clean upload is never silent
  // (rule 5: send is best-effort — a delivery failure never rewinds the
  // accepted intake). A webhook redelivery dedups to the same invoice/job and
  // stays quiet, so Meta retries never double-ping the sender. After the FIRST
  // ack in a session, subsequent clean uploads are silent (no repetitive nag).
  const alreadyAcked = !!mSession.upload_ack_sent_at;
  if (!deduped && !alreadyAcked) {
    const held = waiting > 0 && clientId
      ? ` Note: ${waiting} earlier file(s) are still held for a client — send Change client to assign them.`
      : '';
    const o = await sendText(message.from, `Invoice received and queued for processing.${held} Send more anytime, or type Done / Menu.`);
    if (o === 'ok') await updateSessionDeliveryState(db, mHmac, { upload_ack_sent_at: new Date().toISOString() });
  }
}

/**
 * A storage upload rejected specifically because the object's transport MIME is
 * not permitted on the bucket (the encrypted container is uploaded as
 * application/octet-stream). That is a bucket-configuration gap the operator
 * fixes by applying the invoices bucket migration — retrying the same upload
 * can never succeed, so it must NOT loop Meta redeliveries. Deliberately narrow:
 * only a MIME/"not allowed"-style rejection matches, so transient network and
 * permission errors stay retryable.
 */
function isStorageConfigFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/STORAGE_UPLOAD_ERROR/.test(message)) return false;
  return /(mime|content[ -]?type|file type)/i.test(message)
    && /(not allowed|not supported|unsupported)/i.test(message);
}

