import 'server-only'

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { bucketFor } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

type Db = SupabaseClient

interface OrphanedObject {
  object_path: string
  object_kind: 'invoice' | 'pending'
  provider_message_id: string
}

export async function recoverStaleIntakeReservations(db: Db): Promise<number> {
  const { data, error } = await db.rpc('recover_whatsapp_daily_intake_reservations')
  if (error) throw new Error(`INTAKE_QUOTA_RECOVERY_ERROR: ${error.message}`)
  return Number(data ?? 0)
}

export async function reconcileOrphanedIntakeObjects(
  db: Db,
  limit = 10,
): Promise<{ claimed: number; deleted: number; retried: number }> {
  const claimToken = randomUUID()
  const { data, error } = await db.rpc('claim_orphaned_whatsapp_intake', {
    p_claim_token: claimToken,
    p_limit: Math.min(Math.max(Math.trunc(limit), 1), 50),
    p_grace_seconds: 86_400,
    p_lease_seconds: 120,
  })
  if (error) throw new Error(`INTAKE_RECONCILE_CLAIM_ERROR: ${error.message}`)
  const rows = (data ?? []) as OrphanedObject[]
  let deleted = 0
  let retried = 0

  for (const row of rows) {
    try {
      const { error: removeError } = await db.storage
        .from(bucketFor('invoices'))
        .remove([row.object_path])
      if (removeError) throw removeError

      const { data: finished, error: finishError } = await db.rpc('finish_orphaned_whatsapp_intake', {
        p_object_path: row.object_path,
        p_claim_token: claimToken,
      })
      if (finishError) throw finishError
      if (finished !== true) {
        logger.warn('[IntakeReconcile] orphan cleanup lost its claim or found a linked row', {
          objectKind: row.object_kind,
        })
        continue
      }
      deleted += 1
    } catch (error) {
      const errorCode = error instanceof Error ? error.message.split(':')[0] : 'STORAGE_DELETE_FAILED'
      const { data: retriedRow, error: retryError } = await db.rpc('retry_orphaned_whatsapp_intake', {
        p_object_path: row.object_path,
        p_claim_token: claimToken,
        p_error_code: errorCode,
      })
      if (retryError) {
        logger.error('[IntakeReconcile] failed to persist cleanup retry', {
          objectKind: row.object_kind,
          error: retryError.message.split(':')[0],
        })
        continue
      }
      if (retriedRow === true) retried += 1
      logger.error('[IntakeReconcile] storage cleanup failed', {
        objectKind: row.object_kind,
        error: errorCode,
        retryRecorded: retriedRow === true,
      })
    }
  }

  return { claimed: rows.length, deleted, retried }
}

export async function purgeOldIntakeQuotaHistory(db: Db): Promise<number> {
  const { data, error } = await db.rpc('purge_old_whatsapp_intake_quota')
  if (error) throw new Error(`INTAKE_QUOTA_PURGE_ERROR: ${error.message}`)
  return Number(data ?? 0)
}
