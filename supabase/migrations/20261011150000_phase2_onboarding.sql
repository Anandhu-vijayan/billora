-- Billora Phase 2 (onboarding): workspace preferences, held uploads, client switching.
-- Forward-only and rerunnable (IF NOT EXISTS / guarded constraint swaps).
-- Applied migrations are NOT modified. RLS: new tables are service-role only
-- (no policies, no grants to anon/authenticated) — same pattern as 20261010120000.
--
-- Design (master plan §4 + §6):
--   * workspace_preferences: one row per workspace, defaults attached on creation.
--   * pending_uploads: "receive first, ask later". Media that arrives before the
--     sender has a workspace (or before an org client is confirmed) is stored
--     privately and held here; assignment binds workspace/client at confirm time
--     and creates the invoice + job rows. Never silently reassigned.
--   * whatsapp_sessions: pending_client_id + awaiting_pending_confirm state
--     implement "Apply [New Client] to those pending files?" across restarts.

-- 1) Workspace preferences.
create table if not exists public.workspace_preferences (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  default_document_type text not null default 'invoice'
    check (default_document_type in ('invoice', 'receipt', 'both')),
  batch_mode text not null default 'per_message'
    check (batch_mode in ('per_message', 'daily', 'manual')),
  notify_on_completion boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Defaults attach at workspace creation (security definer: trigger context).
create or replace function public.attach_default_preferences()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_preferences (workspace_id)
  values (new.id)
  on conflict (workspace_id) do nothing;
  return new;
end;
$$;
revoke execute on function public.attach_default_preferences() from public, anon, authenticated;
drop trigger if exists workspace_preferences_after_insert on public.workspaces;
create trigger workspace_preferences_after_insert
after insert on public.workspaces
for each row execute function public.attach_default_preferences();

-- Backfill workspaces that already exist.
insert into public.workspace_preferences (workspace_id)
select id from public.workspaces on conflict (workspace_id) do nothing;

-- 2) Held uploads awaiting workspace/client assignment.
create table if not exists public.pending_uploads (
  id uuid primary key default gen_random_uuid(),
  sender_hmac text not null references public.whatsapp_identities(sender_hmac) on delete cascade,
  object_path text not null unique,
  original_file_name text,
  content_type text not null
    check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  file_sha256 bytea,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  provider_media_id text,
  status text not null default 'waiting_assignment'
    check (status in ('waiting_assignment', 'assigned', 'discarded')),
  assigned_invoice_id uuid references public.invoices(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pending_uploads_sender_status_idx
  on public.pending_uploads (sender_hmac, status);

-- 3) Sessions: the client awaiting a pending-files confirmation (persisted
--    pending question — survives restarts and webhook retries).
alter table public.whatsapp_sessions add column if not exists pending_client_id uuid
  references public.clients(id) on delete set null;

alter table public.whatsapp_sessions drop constraint if exists whatsapp_sessions_state_check;
alter table public.whatsapp_sessions
  add constraint whatsapp_sessions_state_check
  check (state in (
    'new', 'awaiting_account_type', 'awaiting_org_name', 'awaiting_client_select',
    'awaiting_client_name', 'individual_ready', 'organization_ready',
    'awaiting_pending_confirm', 'collecting', 'cancelled'
  ));

-- 4) RLS: service-role only. Intentionally no policies and no grants.
alter table public.workspace_preferences enable row level security;
alter table public.pending_uploads enable row level security;
