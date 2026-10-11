// lib/statuses.ts — typed status enums, single source of truth in TS.
// These mirror DB CHECK constraints in supabase/migrations exactly;
// tests/onboarding.test.mjs asserts alignment against the migration SQL text.
// Never widen one side without the other.

export const BATCH_STATUSES = [
  'collecting', 'ready', 'processing', 'completed', 'needs_review', 'failed', 'cancelled',
] as const
export type BatchStatus = (typeof BATCH_STATUSES)[number]

export const INVOICE_STATUSES = [
  'received', 'queued', 'processing', 'needs_review', 'completed', 'failed', 'deleted',
] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export const JOB_STATUSES = ['queued', 'processing', 'completed', 'failed'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const WORKBOOK_STATUSES = ['ready', 'sent', 'expired', 'deleted'] as const
export type WorkbookStatus = (typeof WORKBOOK_STATUSES)[number]

// webhook_events intake ledger (durable idempotency).
export const INTAKE_STATUSES = ['received', 'accepted', 'failed'] as const
export type IntakeStatus = (typeof INTAKE_STATUSES)[number]

// whatsapp_sessions conversation lifecycle (distinct from batch/invoice/job status).
export const CONVERSATION_STATES = [
  'new', 'awaiting_account_type', 'awaiting_org_name', 'awaiting_client_select',
  'awaiting_client_name', 'individual_ready', 'organization_ready',
  'awaiting_pending_confirm', 'collecting', 'cancelled',
] as const
export type ConversationState = (typeof CONVERSATION_STATES)[number]

// pending_uploads intake hold ("receive first, ask later").
export const PENDING_UPLOAD_STATUSES = ['waiting_assignment', 'assigned', 'discarded'] as const
export type PendingUploadStatus = (typeof PENDING_UPLOAD_STATUSES)[number]

// workspace_preferences domains.
export const DOCUMENT_TYPES = ['invoice', 'receipt', 'both'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export const BATCH_MODES = ['per_message', 'daily', 'manual'] as const
export type BatchMode = (typeof BATCH_MODES)[number]

// Only these media types may become invoices (matches invoices + pending_uploads
// CHECK constraints). Anything else gets a useful reply, never a DB error.
export const ACCEPTED_MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
export function isAcceptedMediaType(mime: string | null | undefined): boolean {
  return !!mime && (ACCEPTED_MEDIA_TYPES as readonly string[]).includes(mime)
}
