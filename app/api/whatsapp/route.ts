import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

// app/api/whatsapp/route.ts - REPLACE GET ONLY
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get('hub.mode')
  const receivedToken = searchParams.get('hub.verify_token')
  const expectedConfigured = (process.env.WHATSAPP_VERIFY_TOKEN ?? '').length > 0
  // Safe diagnostics: lengths + match flag only, never the token values.
  console.log('Verify attempt:', JSON.stringify({
    mode, hasToken: !!receivedToken, receivedLen: receivedToken?.length ?? 0,
    expectedConfigured, match: !!receivedToken && receivedToken === process.env.WHATSAPP_VERIFY_TOKEN,
  }))
  if (
    mode === 'subscribe' &&
    !!receivedToken &&
    receivedToken === process.env.WHATSAPP_VERIFY_TOKEN
  ) {
    const challenge = searchParams.get('hub.challenge') || ''
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
  return new Response('Forbidden', { status: 403 })
}

export async function POST(request: Request) {
  try {
    const rawText = await request.text();
    if (!rawText || rawText.trim().length === 0) {
      logger.info('[WhatsApp] empty body skipped', {});
      return NextResponse.json({ status: 'SKIPPED_EMPTY_BODY' }, { status: 200 });
    }
    let payload: { entry?: Array<{ changes?: Array<{ value?: Record<string, unknown> }> }> };
    try {
      payload = JSON.parse(rawText);
    } catch (parseError) {
      logger.info('[WhatsApp] non-JSON body skipped', {
        preview: rawText.slice(0, 200),
        contentType: request.headers.get('content-type'),
      });
      return NextResponse.json({ status: 'SKIPPED_NON_JSON_BODY' }, { status: 200 });
    }
    const value = (payload.entry?.[0]?.changes?.[0]?.value ?? {}) as {
      messages?: Array<{ id?: string; type?: string; from?: string; timestamp?: string; image?: unknown; document?: unknown; text?: unknown }>;
      statuses?: Array<{ status?: string }>;
    };
    const message = value?.messages?.[0];

    logger.info('[WhatsApp] webhook received', {
      hasMessages: !!value?.messages,
      messageId: message?.id ?? null,
      messageType: message?.type ?? null,
      from: message?.from ?? null,
      statuses: value?.statuses?.[0]?.status ?? null,
    });

    if (!message || !message.id) {
      logger.info('[WhatsApp] skipped unsupported payload', { keys: Object.keys(payload ?? {}) });
      return NextResponse.json({ status: 'SKIPPED_UNSUPPORTED_PAYLOAD' }, { status: 200 });
    }

    const providerMessageId: string = message.id;
    logger.info('[WhatsApp] message received', {
      providerMessageId,
      messageType: message.type ?? null,
      from: message.from ?? null,
      timestamp: message.timestamp ?? null,
      hasImage: !!message.image,
      hasDocument: !!message.document,
      hasText: !!message.text,
    });

    // SECURITY GATING DEDUPLICATION RULE: Prevent multi-delivery spikes via unique index constraints
    const { error: insertError } = await (getSupabaseAdmin().from('webhook_events') as unknown as {
      insert: (row: { provider_message_id: string }) => Promise<{ error: { code?: string; message: string } | null }>
    }).insert({ provider_message_id: providerMessageId });

    if (insertError && insertError.code === '23505') {
      // Unique constraint 23505 = duplicate hit; exit early with 200
      logger.info('[WhatsApp] duplicate event aborted', { providerMessageId });
      return NextResponse.json({ status: 'ABORTED_DUPLICATE_EVENT' }, { status: 200 });
    }
    if (insertError) throw new Error(insertError.message);

    // Fast-exit path to stay within Meta's 10-second webhook window.
    // Heavy spreadsheet/AI jobs run asynchronously out-of-band.
    logger.info('[WhatsApp] accepted for queue', { providerMessageId });
    return NextResponse.json({ status: 'ACCEPTED_FOR_QUEUE' }, { status: 200 });

  } catch (error: unknown) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    logger.error("[Gateway Interface Router] Intercepted runtime disruption anomaly", { error: detail });
    // Surface the failure class to the caller for debugging (still 200 so Meta doesn't retry-storm).
    // Safe: error classes only, never secrets/payloads.
    const code = /Missing Supabase env|Invalid environment/i.test(detail) ? 'CONFIG_ERROR'
      : /webhook_events|relation .* does not exist/i.test(detail) ? 'DB_TABLE_MISSING'
      : 'SYSTEM_ROUTING_FAULT';
    return NextResponse.json({ status: code, detail }, { status: 200 });
  }
}
