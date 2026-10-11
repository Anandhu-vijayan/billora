// POST /api/jobs/worker — external scheduler entry point for the durable queue.
//
// The queue lives in Postgres, so *when* a tick runs is an operational choice:
// a cron job, a GitHub Actions schedule, or `npm run worker:poll` all work.
// Nothing here runs on its own: the endpoint is disabled unless WORKER_SECRET
// is configured, and a tick claims only job types that have a registered
// handler, so this route cannot start "processing" before Phase 4 exists.
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { safeTokenEqual } from '@/lib/whatsapp/verify';
import { runWorkerTick } from '@/lib/jobs/worker';

export const dynamic = 'force-dynamic';

// Serverless platform function timeout; the tick self-limits below this via
// JOB_TICK_BUDGET_MS so it always returns a summary instead of being killed.
export const maxDuration = 60;

interface TickBody {
  limit?: number;
  leaseSeconds?: number;
}

function authorized(req: Request): boolean {
  const secret = process.env.WORKER_SECRET || '';
  if (!secret) return false;
  return safeTokenEqual(req.headers.get('x-worker-token') ?? '', secret);
}

export async function POST(req: Request) {
  if (!process.env.WORKER_SECRET) {
    logger.error('[Worker] WORKER_SECRET unconfigured; worker endpoint disabled');
    return NextResponse.json(
      { ok: false, status: 'WORKER_DISABLED' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!authorized(req)) {
    logger.warn('[Worker] worker endpoint rejected: token invalid');
    return NextResponse.json(
      { ok: false, status: 'WORKER_UNAUTHORIZED' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let body: TickBody = {};
  const raw = await req.text();
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw) as TickBody;
    } catch {
      return NextResponse.json(
        { ok: false, status: 'SKIPPED_NON_JSON_BODY' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }
  // Clamp: a caller can ask for less work, never more than the RPC allows.
  const limit = Number.isFinite(body.limit) ? Math.min(Math.max(body.limit as number, 1), 25) : undefined;
  const leaseSeconds = Number.isFinite(body.leaseSeconds)
    ? Math.min(Math.max(body.leaseSeconds as number, 30), 1800)
    : undefined;

  try {
    const db = getSupabaseAdmin();
    const result = await runWorkerTick(db, { limit, leaseSeconds });
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error: unknown) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    logger.error('[Worker] tick failed', { error: detail.split(':')[0] || 'WORKER_TICK_FAULT', detail: detail.slice(0, 200) });
    return NextResponse.json(
      { ok: false, status: 'WORKER_TICK_RETRYABLE', detail: detail.split(':')[0] },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
