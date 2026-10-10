import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get('hub.mode')
  const receivedToken = searchParams.get('hub.verify_token')
  const expectedConfigured = (process.env.WHATSAPP_VERIFY_TOKEN?? '').length > 0
  console.log('Verify attempt:', JSON.stringify({
    mode, hasToken:!!receivedToken, receivedLen: receivedToken?.length?? 0,
    expectedConfigured, match:!!receivedToken && receivedToken === process.env.WHATSAPP_VERIFY_TOKEN,
  }))
  if (mode === 'subscribe' &&!!receivedToken && receivedToken === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(searchParams.get('hub.challenge') || '', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
  return new Response('Forbidden', { status: 403 })
}

export async function POST(request: Request) {
  try {
    const rawText = await request.text();
    if (!rawText?.trim()) return NextResponse.json({ status: 'SKIPPED_EMPTY_BODY' }, { status: 200 });

    let payload: any;
    try { payload = JSON.parse(rawText); }
    catch { return NextResponse.json({ status: 'SKIPPED_NON_JSON_BODY' }, { status: 200 }); }

    const value = payload.entry?.[0]?.changes?.[0]?.value?? {};
    const message = value?.messages?.[0] as any;

    logger.info('[WhatsApp] webhook received', {
      hasMessages:!!value?.messages,
      messageId: message?.id?? null,
      messageType: message?.type?? null,
      from: message?.from?? null,
    });

    if (!message?.id) return NextResponse.json({ status: 'SKIPPED_UNSUPPORTED_PAYLOAD' }, { status: 200 });

    const supabase = getSupabaseAdmin();
    const providerMessageId: string = message.id;

    // DEDUP - your existing logic
    const { error: insertError } = await (supabase.from('webhook_events') as any).insert({
      provider_message_id: providerMessageId,
      payload: value // save full payload for debugging
    });
    if (insertError?.code === '23505') {
      return NextResponse.json({ status: 'ABORTED_DUPLICATE_EVENT' }, { status: 200 });
    }
    if (insertError) throw new Error(insertError.message);

    // === NEW: HANDLE IMAGE FROM TEST NUMBER ===
    if (message.type === 'image' && message.image?.id) {
      const imageId = message.image.id;
      const from = message.from;
      const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

      logger.info('[WhatsApp] downloading image', { imageId, from });

      try {
        // Step 1: Get temporary URL from Meta
        const mediaMetaRes = await fetch(`https://graph.facebook.com/v25.0/${imageId}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const mediaMeta = await mediaMetaRes.json();

        if (!mediaMeta.url) throw new Error(`Meta media error: ${JSON.stringify(mediaMeta)}`);

        // Step 2: Download image bytes
        const imageRes = await fetch(mediaMeta.url, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const buffer = Buffer.from(await imageRes.arrayBuffer());

        // Step 3: Upload to Supabase Storage (create bucket 'invoices' if not exists)
        const fileName = `${from}/${Date.now()}_${imageId}.jpg`;
        const { error: uploadError } = await supabase.storage
         .from('billora-invoices')
         .upload(fileName, buffer, { contentType: 'image/jpeg' });

        if (uploadError) throw uploadError;

        // Step 4: Insert into your invoices queue table
        await (supabase.from('billora-invoices') as any).insert({
          provider_message_id: providerMessageId,
          from_number: from,
          image_path: fileName,
          status: 'received',
          phone_number_id: '1432096079978954' // test number from your screenshot
        });

        logger.info('[WhatsApp] image saved', { fileName, size: buffer.length });

      } catch (imgErr: any) {
        logger.error('[WhatsApp] image download failed', { error: imgErr.message, imageId });
        // Don't throw - still return 200 so Meta doesn't retry storm
      }
    }

    return NextResponse.json({ status: 'ACCEPTED_FOR_QUEUE' }, { status: 200 });

  } catch (error: any) {
    const detail = error?.message?? String(error);
    logger.error("[Gateway Interface Router] Intercepted runtime disruption anomaly", { error: detail });
    const code = /Missing Supabase env|Invalid environment/i.test(detail)? 'CONFIG_ERROR'
      : /webhook_events|relation.* does not exist/i.test(detail)? 'DB_TABLE_MISSING'
      : 'SYSTEM_ROUTING_FAULT';
    return NextResponse.json({ status: code, detail }, { status: 200 });
  }
}