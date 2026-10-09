import { NextResponse } from 'next/server'

export function ok<T>(data: T, init?: { headers?: HeadersInit; requestId?: string }) {
  const headers = new Headers(init?.headers)
  headers.set('Cache-Control', 'no-store')
  if (init?.requestId) headers.set('x-request-id', init.requestId)
  return NextResponse.json({ ok: true, data }, { headers })
}

export function fail(
  message: string,
  init?: { status?: number; code?: string; headers?: HeadersInit; requestId?: string; details?: unknown },
) {
  const headers = new Headers(init?.headers)
  headers.set('Cache-Control', 'no-store')
  if (init?.requestId) headers.set('x-request-id', init.requestId)
  return NextResponse.json(
    { ok: false, error: { code: init?.code ?? 'error', message } },
    { status: init?.status ?? 500, headers },
  )
}

/** Generic messages only — never leak stack traces, SQL, or secrets to clients. */
export function toPublicErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    const m = e.message.toLowerCase()
    if (m.includes('fetch failed') || m.includes('enotfound') || m.includes('econnrefused')) {
      return 'Upstream service unreachable. Try again shortly.'
    }
    if (m.includes('invalid environment') || m.includes('missing supabase env')) return e.message
    if (m.includes('jwt') || m.includes('unauthorized') || m.includes('permission')) {
      return 'Not authorized for this operation.'
    }
    return 'Request failed. Try again shortly.'
  }
  return 'Request failed. Try again shortly.'
}
