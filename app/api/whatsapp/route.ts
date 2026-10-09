import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase/client';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const message = payload.entry?.?.changes?.?.value?.messages?.;
    
    if (!message || !message.id) {
      return NextResponse.json({ status: 'IGNORED_PAYLOAD' }, { status: 200 });
    }

    const providerMessageId = message.id;

    // Deduplicate transaction events inside the isolated boundary layer
    const { error: insertError } = await supabase
      .from('webhook_events')
      .insert({ provider_message_id: providerMessageId });

    if (insertError && insertError.code === '23505') {
      // Primary unique constraint violation hit: message already processed, exit early
      return NextResponse.json({ status: 'DUPLICATE_EVENT_ABORT' }, { status: 200 });
    }

    // Process incoming session parameters safely under the 10-second rule
    // Full content parsing takes place out-of-band via asynchronous worker queues
    return NextResponse.json({ status: 'EVENT_ACCEPTED_FOR_QUEUE' }, { status: 200 });

  } catch (error: any) {
    console.error("[Gateway Exception Handled] Blocked runtime disruption:", error.message);
    return NextResponse.json({ status: 'SYSTEM_COMPILATION_ERROR' }, { status: 200 });
  }
}
