import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { safeTokenEqual } from '@/lib/whatsapp/verify'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 15

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(status: number, code: string) {
  return NextResponse.json({ ok: false, error: { code } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function authorized(req: Request): boolean {
  if (process.env.BILLORA_TESTING_ENABLED !== 'true') return false
  const expected = process.env.BILLORA_TEST_TOKEN ?? ''
  const supplied = req.headers.get('x-billora-test-token') ?? ''
  return expected.length >= 32 && safeTokenEqual(supplied, expected)
}

/**
 * Test-only, workspace-scoped status/manifest endpoint.
 * Accepts invoice IDs returned by the upload route; batchId is deliberately not
 * used as a database key because it is only a client-side correlation value.
 * No invoice payloads, storage paths, URLs, or decrypted financial data leave DB.
 */
export async function POST(req: Request) {
  if (process.env.BILLORA_TESTING_ENABLED !== 'true') return fail(404, 'NOT_FOUND')
  if (!authorized(req)) return fail(401, 'TEST_UNAUTHORIZED')

  const workspaceId = process.env.BILLORA_TEST_WORKSPACE_ID ?? ''
  if (!UUID_RE.test(workspaceId)) return fail(503, 'TEST_WORKSPACE_CONFIGURATION_INVALID')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return fail(400, 'INVALID_JSON')
  }

  const invoiceIds = (body as { invoiceIds?: unknown })?.invoiceIds
  if (!Array.isArray(invoiceIds) || invoiceIds.length < 1 || invoiceIds.length > 20
    || invoiceIds.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    return fail(400, 'INVALID_INVOICE_IDS')
  }

  const ids = [...new Set(invoiceIds as string[])]
  if (ids.length !== invoiceIds.length) return fail(400, 'DUPLICATE_INVOICE_IDS')

  try {
    const db = getSupabaseAdmin()
    const [invoiceResult, jobResult, recordResult] = await Promise.all([
      db.from('invoices').select('id,status,batch_id').eq('workspace_id', workspaceId).in('id', ids),
      db.from('processing_jobs').select('id,invoice_id,job_type,status,attempts,safe_error_code')
        .eq('workspace_id', workspaceId).in('invoice_id', ids),
      db.from('extracted_records').select('invoice_id,review_status')
        .eq('workspace_id', workspaceId).in('invoice_id', ids),
    ])

    if (invoiceResult.error || jobResult.error || recordResult.error) {
      console.error('[TestStatus] query failed', {
        invoices: invoiceResult.error?.code ?? null,
        jobs: jobResult.error?.code ?? null,
        records: recordResult.error?.code ?? null,
      })
      return fail(503, 'TEST_STATUS_QUERY_FAILED')
    }

    const invoices = invoiceResult.data ?? []
    if (invoices.length !== ids.length) return fail(404, 'TEST_INVOICE_NOT_FOUND')

    const jobs = jobResult.data ?? []
    const records = recordResult.data ?? []
    const batchIds = [...new Set(invoices.map((invoice) => invoice.batch_id).filter(
      (id): id is string => typeof id === 'string' && UUID_RE.test(id),
    ))]

    let batches: Array<{ id: string; period_start: string | null; period_end: string | null }> = []
    let workbooks: Array<{
      id: string; batch_id: string; accounting_category: string | null;
      status: string; version: number; period_start: string | null; period_end: string | null;
    }> = []

    if (batchIds.length) {
      const [batchResult, workbookResult] = await Promise.all([
        db.from('invoice_batches').select('id,period_start,period_end')
          .eq('workspace_id', workspaceId).in('id', batchIds),
        db.from('generated_workbooks')
          .select('id,batch_id,accounting_category,status,version,period_start,period_end')
          .eq('workspace_id', workspaceId).in('batch_id', batchIds)
          .in('status', ['ready', 'sent']).order('version', { ascending: false }),
      ])
      if (batchResult.error || workbookResult.error) return fail(503, 'TEST_MANIFEST_QUERY_FAILED')
      batches = (batchResult.data ?? []) as typeof batches
      workbooks = (workbookResult.data ?? []) as typeof workbooks
    }

    const jobByInvoice = new Map<string, typeof jobs[number]>()
    for (const job of jobs) {
      if (job.job_type === 'invoice_extraction' && job.invoice_id) jobByInvoice.set(job.invoice_id, job)
    }
    const recordByInvoice = new Map(records.map((record) => [record.invoice_id, record]))
    const invoiceStatus = invoices.map((invoice) => {
      const job = jobByInvoice.get(invoice.id)
      const record = recordByInvoice.get(invoice.id)
      return {
        invoiceId: invoice.id,
        invoiceStatus: invoice.status,
        jobId: job?.id ?? null,
        jobStatus: job?.status ?? null,
        attempts: job?.attempts ?? null,
        errorCode: job?.safe_error_code ?? null,
        reviewStatus: record?.review_status ?? null,
        batchId: invoice.batch_id,
      }
    })

    const batchById = new Map(batches.map((batch) => [batch.id, batch]))
    const manifest = workbooks.map((workbook) => ({
      workbookId: workbook.id,
      batchId: workbook.batch_id,
      periodStart: workbook.period_start ?? batchById.get(workbook.batch_id)?.period_start ?? null,
      periodEnd: workbook.period_end ?? batchById.get(workbook.batch_id)?.period_end ?? null,
      category: workbook.accounting_category,
      status: workbook.status,
      version: workbook.version,
      downloadPath: `/api/exports/${workbook.id}/download`,
    }))

    const pending = invoiceStatus.filter((row) => row.jobStatus === 'queued' || row.jobStatus === 'processing').length
    const failed = invoiceStatus.filter((row) => row.jobStatus === 'failed' || row.invoiceStatus === 'failed').length
    const reviewRequired = invoiceStatus.filter((row) => row.reviewStatus === 'needs_review' || row.invoiceStatus === 'needs_review').length

    return NextResponse.json({
      ok: true,
      total: invoiceStatus.length,
      pending,
      processing: invoiceStatus.filter((row) => row.jobStatus === 'processing').length,
      failed,
      reviewRequired,
      completed: invoiceStatus.filter((row) => row.jobStatus === 'completed').length,
      invoices: invoiceStatus,
      workbooks: manifest,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[TestStatus] unexpected failure', {
      kind: error instanceof Error ? error.name : 'unknown',
    })
    return fail(500, 'TEST_STATUS_FAILED')
  }
}
