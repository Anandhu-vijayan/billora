// app/api/whatsapp/route.ts — Fast gateway + WhatsApp media intake.
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { downloadWhatsAppMedia } from '@/lib/whatsapp/media';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const receivedToken = searchParams.get('hub.verify_token');
  const expectedConfigured = (process.env.WHATSAPP_VERIFY_TOKEN ?? '').length > 0;
  console.log('Verify attempt:', JSON.stringify({
    mode, hasToken: !!receivedToken, receivedLen: receivedToken?.length ?? 0,
    expectedConfigured, match: !!receivedToken && receivedToken === process.env.WHATSAPP_VERIFY_TOKEN,
  }));
  if (mode === 'subscribe' && !!receivedToken && receivedToken === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(searchParams.get('hub.challenge') || '', {
      status: 200, headers: { 'Content-Type': 'text/plain' },
    });
  }
  return new Response('Forbidden', { status: 403 });
}

interface IncomingMedia { id?: string; mime_type?: string; caption?: string; filename?: string }
interface IncomingMessage {
  id?: string; type?: string; from?: string; timestamp?: string;
  text?: { body?: string }; image?: IncomingMedia; document?: IncomingMedia;
}

export async function POST(request: Request) {
  try {
    const rawText = await request.text();
    if (!rawText || rawText.trim().length === 0) {
      return NextResponse.json({ status: 'SKIPPED_EMPTY_BODY' }, { status: 200 });
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
    const message = value?.messages?.[0];
    logger.info('[WhatsApp] webhook received', {
      hasMessages: !!value?.messages, messageId: message?.id ?? null,
      messageType: message?.type ?? null, from: message?.from ?? null,
      statuses: value?.statuses?.[0]?.status ?? null,
    });
    if (!message || !message.id) {
      return NextResponse.json({ status: 'SKIPPED_UNSUPPORTED_PAYLOAD' }, { status: 200 });
    }
    const providerMessageId: string = message.id;
    logger.info('[WhatsApp] message received', {
      providerMessageId, messageType: message.type ?? null, from: message.from ?? null,
      timestamp: message.timestamp ?? null, hasImage: !!message.image,
      hasDocument: !!message.document, hasText: !!message.text,
    });
    const db = getSupabaseAdmin();
    const { error: dedupError } = await (db.from('webhook_events') as unknown as {
      insert: (row: { provider_message_id: string }) => Promise<{ error: { code?: string; message: string } | null }>;
    }).insert({ provider_message_id: providerMessageId });
    if (dedupError && dedupError.code === '23505') {
      logger.info('[WhatsApp] duplicate event aborted', { providerMessageId });
      return NextResponse.json({ status: 'ABORTED_DUPLICATE_EVENT' }, { status: 200 });
    }
    if (dedupError) throw new Error(dedupError.message);
    // Media intake: image/* + document(pdf) via mime_type mapping.
    const media = message.type === 'image' ? message.image
      : message.type === 'document' ? message.document : undefined;
    const mediaId = media?.id;
    if (mediaId) {
      const declaredMime = media?.mime_type;
      logger.info('[WhatsApp] media id extracted', { providerMessageId, mediaId, declaredMime: declaredMime ?? null });
      try {
        const downloaded = await downloadWhatsAppMedia({
          mediaId, accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '', declaredMime,
        });
        const safeFrom = (message.from || 'unknown').replace(/[^0-9a-zA-Z+_-]/g, '');
        const objectPath = `whatsapp/${safeFrom}/${Date.now()}_${mediaId}.${downloaded.extension}`;
        const { error: uploadError } = await db.storage.from('billora-invoices')
          .upload(objectPath, downloaded.buffer, { contentType: downloaded.contentType, upsert: false });
        if (uploadError) throw new Error(`STORAGE_UPLOAD_ERROR: ${uploadError.message}`);
        logger.info('[WhatsApp] media stored', { providerMessageId, objectPath, size: downloaded.size });
      } catch (mediaError: unknown) {
        logger.error('[WhatsApp] media intake failed', { providerMessageId, mediaId,
          error: mediaError instanceof Error ? mediaError.message : String(mediaError) });
      }
    } else if (message.type === 'image' || message.type === 'document') {
      logger.info('[WhatsApp] media message without media id', { providerMessageId });
    }
    logger.info('[WhatsApp] accepted for queue', { providerMessageId });
    return NextResponse.json({ status: 'ACCEPTED_FOR_QUEUE' }, { status: 200 });
  } catch (error: unknown) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    logger.error('[Gateway Interface Router] runtime anomaly', { error: detail });
    const code = /Missing Supabase env|Invalid environment/i.test(detail) ? 'CONFIG_ERROR'
      : /webhook_events|relation .* does not exist/i.test(detail) ? 'DB_TABLE_MISSING'
      : 'SYSTEM_ROUTING_FAULT';
    return NextResponse.json({ status: code, detail }, { status: 200 });
  }
}
