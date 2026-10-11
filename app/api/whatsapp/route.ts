// app/api/whatsapp/route.ts — Fast gateway + Phase 2 onboarding + upload decision engine.
import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { isAcceptedMediaType } from '@/lib/statuses';
import { downloadWhatsAppMedia } from '@/lib/whatsapp/media';
import { senderHmac, senderLabel } from '@/lib/whatsapp/identity';
import { verifyWebhookSignature, safeTokenEqual } from '@/lib/whatsapp/verify';
import { transition, type ConversationState, type SessionSnapshot, type TransitionResult } from '@/lib/whatsapp/conversation';
import { loadSession, loadAccountType, saveSession, isExpired, expiredSnapshot } from '@/lib/whatsapp/sessions';
import { sendText, sendAccountTypeButtons, sendClientList, sendConfirmApply, type SendOutcome } from '@/lib/whatsapp/send';
import {
  ensureIndividualWorkspace, ensureOrganizationWorkspace,
  listClients, createClient, verifyClientInWorkspace,
} from '@/lib/whatsapp/provision';
import {
  claimIntakeRow, isDurablyAccepted, markIntakeAccepted, markIntakeFailed,
  recordMediaIntake, recordPendingUpload, countWaitingUploads, assignPendingUploads,
} from '@/lib/whatsapp/intake';

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
  let sendOutcome: SendOutcome = 'ok';
  const track = (outcome: SendOutcome): void => {
    if (outcome === 'blocked') sendOutcome = 'blocked';
    else if (outcome === 'transient' && sendOutcome !== 'blocked') sendOutcome = 'transient';
  };
  const sendStateMessage = async (): Promise<void> => {
    if (result.note === 'individual-selected') {
      const held = assignedNow > 0 ? ` I also filed the ${assignedNow} invoice file(s) you sent earlier.` : '';
      track(await sendText(to, `Your workspace is ready. Send invoice PDFs or photos here.${held}`));
    } else if (result.note.startsWith('org-name:')) {
      const clients = await listClients(db, workspaceId as string);
      if (clients.length > 0) { track(await sendClientList(to, clients)); }
      else {
        track(await sendText(to, 'Organization workspace created. No clients yet — send the first client name.'));
      }
    } else if (result.note === 'reprompt-client-list' || result.note === 're-list-clients'
      || result.note === 'change-client-requested') {
      if (workspaceId) track(await sendClientList(to, await listClients(db, workspaceId)));
    } else if (result.note.startsWith('client-name:')) {
      track(await sendText(to, 'Client saved. Send invoice PDFs or photos here.'));
    } else if (result.note === 'client-selected') {
      track(await sendText(to, 'Client selected. Send invoice PDFs or photos here.'));
    } else if (result.note === 'client-selection-rejected') {
      track(await sendText(to, 'That client is not available. Choose from the list below.'));
      if (workspaceId) track(await sendClientList(to, await listClients(db, workspaceId)));
    } else if (result.note === 'awaiting-pending-confirm' || result.note === 'pending-confirm-stale') {
      // noop: handled by the confirm branch below / generic text.
    } else if (result.note === 'pending-confirm-yes') {
      track(await sendText(to, assignedNow > 0
        ? `Applied to ${assignedNow} file(s) — they're queued for processing. Send more invoices anytime.`
        : 'Applied. Nothing was held for you. Send invoice PDFs or photos here.'));
    } else if (result.note === 'welcome-back') {
      const waiting = await countWaitingUploads(db, hmac);
      track(await sendText(to, waiting > 0
        ? `Welcome back to Billora. Note: ${waiting} earlier file(s) are still held for a client — send Change client to assign them, or just send more invoices.`
        : 'Welcome back to Billora — send invoice PDFs or photos here. Send Menu for options.'));
    } else if (result.note === 'done') {
      track(await sendText(to, 'Done — your uploads are queued for processing. Send more invoices anytime, or type Menu.'));
    } else if (result.outbound.kind === 'text') {
      track(await sendText(to, result.outbound.body));
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
    const detail = e instanceof Error ? e.message : String(e);
    const code = detail.split(':')[0] || 'PROCESSING_ERROR';
    await markIntakeFailed(db, providerMessageId, code).catch(() => undefined);
    logger.error('[WhatsApp] processing failed, retryable', { shortId, error: code });
    return 'retryable';
  }
  logger.info('[WhatsApp] accepted for queue', { shortId });
  return 'processed';
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
  logger.info('[WhatsApp] media intake start', { shortId });
  const mHmac = senderHmac(message.from);
  const mSession = await loadSession(db, mHmac);
  const downloaded = await downloadWhatsAppMedia({
    mediaId, accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '', declaredMime: media?.mime_type,
  });

  // Unsupported or corrupt-by-type media gets a useful reply, never a DB error
  // or a retry loop (acceptance: "unsupported file gets a useful response").
  if (!isAcceptedMediaType(downloaded.contentType)) {
    logger.info('[WhatsApp] unsupported media type rejected', { shortId, contentType: downloaded.contentType });
    await sendText(message.from,
      'Sorry, I can only process invoice PDF, JPG, or PNG files. Please resend as one of those — or type Help.');
    return;
  }
  const sha256Hex = createHash('sha256').update(downloaded.buffer).digest('hex');
  const workspaceId = onboardingWorkspaceId ?? mSession.workspace_id;
  const clientId = onboardingClientId ?? mSession.client_id;

  // Deterministic private hold path: redelivery of the same provider media id
  // overwrites the same object + upserts the same row — never a duplicate hold.
  const holdMedia = async (): Promise<string> => {
    const pendingPath = `whatsapp/pending/${mediaId}.${downloaded.extension}`;
    const { error: pendingUploadError } = await db.storage.from('billora-invoices')
      .upload(pendingPath, downloaded.buffer, { contentType: downloaded.contentType, upsert: true });
    if (pendingUploadError) throw new Error(`STORAGE_UPLOAD_ERROR: ${pendingUploadError.message}`);
    await recordPendingUpload(db, {
      senderHmac: mHmac, objectPath: pendingPath, originalFileName: media?.filename ?? null,
      contentType: downloaded.contentType, fileSha256Hex: sha256Hex,
      sizeBytes: downloaded.size, providerMediaId: mediaId,
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

  const objectPath = `whatsapp/${Date.now()}_${mediaId}.${downloaded.extension}`;
  const { error: uploadError } = await db.storage.from('billora-invoices')
    .upload(objectPath, downloaded.buffer, { contentType: downloaded.contentType, upsert: false });
  if (uploadError) throw new Error(`STORAGE_UPLOAD_ERROR: ${uploadError.message}`);
  const recorded = await recordMediaIntake(db, {
    workspaceId, clientId, objectPath,
    originalFileName: media?.filename ?? null, contentType: downloaded.contentType,
    fileSha256Hex: sha256Hex,
  });
  const waiting = await countWaitingUploads(db, mHmac).catch(() => 0);
  if (waiting > 0 && clientId) {
    await sendText(message.from, `Note: ${waiting} earlier file(s) are still held for a client. Send Change client to assign them.`);
  }
  logger.info('[WhatsApp] media intake recorded', {
    shortId, size: downloaded.size,
    invoice: recorded.invoiceId.slice(0, 8), job: recorded.jobId.slice(0, 8),
  });
}

