import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { bucketFor } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

type Db = SupabaseClient

export interface RetentionMaintenanceResult {
  notices: number
  deletions: number
  failed: number
}

export async function processRetentionMaintenance(
  db: Db,
  limit = 10,
): Promise<RetentionMaintenanceResult> {
  const result: RetentionMaintenanceResult = { notices: 0, deletions: 0, failed: 0 }

  const { data: workspaceRows, error: workspaceError } = await db.from('invoice_review_retention_notices')
    .select('workspace_id')
    .is('delivered_at', null)
    .lte('scheduled_at', new Date().toISOString())
    .lt('available_at', new Date().toISOString()) as unknown as {
      data: Array<{ workspace_id: string }> | null
      error: { message?: string } | null
    }
  if (workspaceError) {
    throw new Error(`RETENTION_NOTICE_SCAN_ERROR: ${workspaceError.message ?? 'unknown'}`)
  }

  const workspaces = [...new Set((workspaceRows ?? []).map((row) => row.workspace_id))]
  for (const workspaceId of workspaces) {
    const claimToken = randomUUID()
    const claimResponse = await db.rpc('claim_due_invoice_review_retention_notices', {
      p_workspace_id: workspaceId,
      p_claim_token: claimToken,
      p_limit: Math.min(10, Math.max(1, limit)),
      p_lease_seconds: 120,
    }) as unknown as { data: Array<{ notice_id: string; invoice_id: string; notice_days: number }> | null; error: { message?: string } | null }
    if (claimResponse.error) {
      logger.warn('[Retention] notice claim failed', { workspaceId, error: claimResponse.error.message ?? 'unknown' })
      continue
    }
    for (const notice of claimResponse.data ?? []) {
      try {
        const delivered = await db.rpc('finish_invoice_review_retention_notice', {
          p_notice_id: notice.notice_id,
          p_claim_token: claimToken,
        }) as unknown as { data: boolean | null; error: { message?: string } | null }
        if (delivered.error) {
          logger.warn('[Retention] notice delivery failed', {
            noticeId: notice.notice_id,
            invoiceId: notice.invoice_id,
            error: delivered.error.message ?? 'unknown',
          })
          continue
        }
        if (delivered.data === true) {
          result.notices += 1
        }
      } catch (error) {
        logger.warn('[Retention] notice delivery crashed', {
          noticeId: notice.notice_id,
          invoiceId: notice.invoice_id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const expiredResponse = await db.rpc('claim_expired_review_invoices', {
    p_claim_token: randomUUID(),
    p_limit: Math.min(10, Math.max(1, limit)),
    p_lease_seconds: 180,
  }) as unknown as { data: Array<{ invoice_id: string; workspace_id: string; object_path: string | null; policy_version: string | null }> | null; error: { message?: string } | null }
  if (expiredResponse.error) {
    logger.warn('[Retention] expired invoice claim failed', { error: expiredResponse.error.message ?? 'unknown' })
    return result
  }

  for (const row of expiredResponse.data ?? []) {
    const claimToken = randomUUID()

    if (!row.object_path) {
      const retried = await db.rpc('retry_expired_review_invoice_retention', {
        p_invoice_id: row.invoice_id,
        p_claim_token: claimToken,
        p_error_code: 'OBJECT_PATH_MISSING',
      }) as unknown as { data: boolean | null; error: { message?: string } | null }
      if (retried.error) {
        logger.warn('[Retention] invalid expired invoice path could not be retried', {
          invoiceId: row.invoice_id,
          error: retried.error.message ?? 'unknown',
        })
      }
      result.failed += 1
      continue
    }

    try {
      const objectResult = await db.storage.from(bucketFor('invoices')).remove([row.object_path]) as unknown as {
        data: Array<{ path: string }> | null
        error: { message?: string } | null
      }
      if (objectResult.error) {
        const retried = await db.rpc('retry_expired_review_invoice_retention', {
          p_invoice_id: row.invoice_id,
          p_claim_token: claimToken,
          p_error_code: objectResult.error.message?.slice(0, 120) ?? 'STORAGE_DELETE_FAILED',
        }) as unknown as { data: boolean | null; error: { message?: string } | null }
        if (retried.error) {
          logger.warn('[Retention] expired invoice delete retry failed', {
            invoiceId: row.invoice_id,
            error: retried.error.message ?? 'unknown',
          })
        }
        result.failed += 1
        continue
      }

      const finished = await db.rpc('finish_expired_review_invoice_retention', {
        p_invoice_id: row.invoice_id,
        p_workspace_id: row.workspace_id,
        p_object_path: row.object_path,
        p_policy_version: row.policy_version ?? 'review-retention-v1',
        p_claim_token: claimToken,
      }) as unknown as { data: boolean | null; error: { message?: string } | null }
      if (finished.error) {
        logger.warn('[Retention] expired invoice deletion failed to settle', {
          invoiceId: row.invoice_id,
          error: finished.error.message ?? 'unknown',
        })
        result.failed += 1
        continue
      }
      if (finished.data === true) {
        result.deletions += 1
      } else {
        result.failed += 1
      }
    } catch (error) {
      const retried = await db.rpc('retry_expired_review_invoice_retention', {
        p_invoice_id: row.invoice_id,
        p_claim_token: claimToken,
        p_error_code: error instanceof Error ? error.message.slice(0, 120) : 'STORAGE_DELETE_FAILED',
      }) as unknown as { data: boolean | null; error: { message?: string } | null }
      if (retried.error) {
        logger.warn('[Retention] expired invoice storage delete crashed during retry', {
          invoiceId: row.invoice_id,
          error: retried.error.message ?? 'unknown',
        })
      }
      result.failed += 1
    }
  }

  return result
}
