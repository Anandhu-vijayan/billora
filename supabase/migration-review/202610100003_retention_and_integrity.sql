-- Integrity checks and worker queue helper. Scheduled deletion remains application work.
create or replace function public.validate_invoice_batch_client()
returns trigger language plpgsql set search_path = '' as $$
declare batch_client_id uuid;
begin
  if new.batch_id is not null then
    select b.client_id into batch_client_id from public.invoice_batches b
      where b.id = new.batch_id and b.workspace_id = new.workspace_id;
    if batch_client_id is null then raise exception 'Batch not found in invoice workspace'; end if;
    if new.client_id is distinct from batch_client_id then raise exception 'Invoice client must match its batch client'; end if;
  end if;
  return new;
end; $$;
create trigger validate_invoice_batch_client_before_write
before insert or update of batch_id,client_id,workspace_id on public.invoices
for each row execute function public.validate_invoice_batch_client();

create or replace function public.validate_workbook_batch_client()
returns trigger language plpgsql set search_path = '' as $$
declare batch_client_id uuid;
begin
  if new.batch_id is not null then
    select b.client_id into batch_client_id from public.invoice_batches b
      where b.id = new.batch_id and b.workspace_id = new.workspace_id;
    if batch_client_id is null then raise exception 'Workbook batch not found in workbook workspace'; end if;
    if new.client_id is distinct from batch_client_id then raise exception 'Workbook client must match its batch client'; end if;
  end if;
  return new;
end; $$;
create trigger validate_workbook_batch_client_before_write
before insert or update of batch_id,client_id,workspace_id on public.generated_workbooks
for each row execute function public.validate_workbook_batch_client();

create or replace view public.billora_due_job_ids with (security_invoker = true) as
select id,available_at,created_at from public.processing_jobs
where status in ('queued','retry') and available_at <= now();
revoke all on public.billora_due_job_ids from public,anon,authenticated;

comment on table public.app_users is 'Internal Billora identity. Encrypt WhatsApp identifiers and store a keyed HMAC for lookup.';
comment on table public.extracted_records is 'Encrypted extracted invoice fields; encryption keys must live outside the database.';
comment on table public.processing_jobs is 'Durable queue; implement atomic claims, retries/backoff, and stale-lock recovery in worker code.';
comment on table public.webhook_events is 'Idempotency ledger for WhatsApp provider message IDs.';
comment on table public.audit_events is 'Allowlisted audit metadata only; never store invoice text, phone numbers, tokens, or signed URLs.';
