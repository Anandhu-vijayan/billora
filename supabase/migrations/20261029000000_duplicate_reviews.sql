-- 20261029000000_duplicate_reviews.sql
-- §3.5 duplicate-review DECISION RECORDS.
--
-- WRITE-ONLY + ADDITIVE. This migration is deliberately NOT applied by the code;
-- the operator applies it when ready (npx supabase db push). Until it is applied
-- the runtime duplicate-review bookkeeping FAILS SOFT (see the identity_key /
-- own_gstin precedent in lib/jobs/handlers/extract-invoice.ts and
-- lib/invoices/review.ts): a possible-duplicate bill is STILL flagged for a human
-- via the encrypted `_reviewReasons` path and NOTHING is blocked, lost, or
-- auto-approved — the durable decision row is simply not recorded yet.
--
-- Why a separate table (not a column): a duplicate is a RELATIONSHIP between two
-- invoices (the incoming scan and the prior live record it may collide with) plus
-- a human's eventual decision. That is 1:N over time and must survive re-scans,
-- so it is its own record, workspace-scoped, tenant-isolated, and never folded
-- into either invoice's status lifecycle.
--
-- What it adds — and why it is safe:
--   * `match_evidence bytea` stores ONLY the same non-reversible HMAC blind index
--     (or exact-file SHA-256) already used for detection — never a plaintext
--     invoice number, supplier, GSTIN, or amount — so it adds NO new PII at rest.
--   * `review_status` records the HUMAN outcome (pending -> confirmed_duplicate |
--     distinct | resolved). The machine only ever writes 'pending' on detection;
--     it NEVER self-resolves. Approval of the underlying invoice still flows
--     through the single shared applyInvoiceReview path unchanged.
--   * RLS member-read only; there is NO browser insert/update/delete policy, so
--     writes stay server/service-role only and the public API surface is not
--     widened. Rows cascade with their workspace/invoices.
--
-- Forward-only and re-runnable (IF NOT EXISTS / guarded DO blocks).

create table if not exists public.duplicate_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The invoice just received / re-scanned that tripped the duplicate flag.
  incoming_invoice_id uuid not null,
  -- The PRIOR live invoice it shares an identity (or exact file) with.
  canonical_invoice_id uuid not null,
  -- Which detection layer fired. 'identity' = blind-index collision,
  -- 'file' = exact SHA-256 re-upload. Never a judgement, only provenance.
  match_layer text not null default 'identity'
    check (match_layer in ('identity', 'file')),
  -- Non-reversible proof of the match (HMAC blind index or file SHA-256).
  -- NEVER plaintext; bytea so it is not accidentally readable via the API.
  match_evidence bytea,
  -- Machine writes 'pending' only; a HUMAN moves it to a terminal state.
  review_status text not null default 'pending'
    check (review_status in ('pending', 'confirmed_duplicate', 'distinct', 'resolved')),
  decision text,                       -- short human note, nullable
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Tenant-scoped composite FKs: an incoming/canonical invoice must belong to the
  -- SAME workspace, and either invoice's deletion takes the relationship record
  -- with it (no orphan decisions).
  foreign key (incoming_invoice_id, workspace_id)
    references public.invoices(id, workspace_id) on delete cascade,
  foreign key (canonical_invoice_id, workspace_id)
    references public.invoices(id, workspace_id) on delete cascade,
  -- Idempotent: re-detecting the same pair refreshes the existing row instead of
  -- piling up duplicate decision records across re-scans / job retries.
  unique (workspace_id, incoming_invoice_id, canonical_invoice_id)
);

comment on table public.duplicate_reviews is
  '§3.5 human decision records for possible-duplicate invoices. Detection flags a pair; a human resolves it. Machine never auto-resolves.';
comment on column public.duplicate_reviews.match_evidence is
  'Non-reversible HMAC blind index (identity) or file SHA-256 (file) proving WHY the pair was flagged. Never plaintext. service_role writes only.';

-- Backs the "pending duplicates for this workspace/invoice" review queries.
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'duplicate_reviews'
      and indexname = 'duplicate_reviews_ws_status_idx'
  ) then
    create index duplicate_reviews_ws_status_idx
      on public.duplicate_reviews (workspace_id, review_status);
  end if;
end $$;

-- Enable RLS; read is limited to workspace members, writes are service-role only.
alter table public.duplicate_reviews enable row level security;

drop policy if exists "members can read duplicate reviews" on public.duplicate_reviews;
create policy "members can read duplicate reviews"
on public.duplicate_reviews for select to authenticated
using (public.is_workspace_member(workspace_id));

-- Read-only for the browser/API; the worker + review path write via service_role.
grant select on public.duplicate_reviews to authenticated;
