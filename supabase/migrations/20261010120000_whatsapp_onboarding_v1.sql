-- Billora Phase 1 (v2): WhatsApp-first identity + persistent sessions + durable intake.
-- Forward-only and rerunnable (IF NOT EXISTS / guarded DO blocks). Review before applying; do NOT auto-apply.
-- Applied base migration 20261002143735_initial_schema.sql is NOT modified by this file.
--
-- Design:
--   * WhatsApp senders have no auth.users row, and fabricating one is forbidden.
--     workspaces.owner_user_id becomes NULLABLE; created_via marks bot origin; a CHECK
--     guarantees every workspace has an owner OR a WhatsApp origin. Existing web rows
--     keep created_via='web' via the column default and pass the CHECK via owner.
--   * Sender identity is a keyed HMAC-SHA256 (WHATSAPP_IDENTITY_HMAC_KEY). No raw phones.
--   * webhook_events gains a status lifecycle (received -> accepted | failed) so a retry
--     after a failed attempt reprocesses instead of being permanently deduplicated.
--   * RLS enabled on new tables with NO browser policies and NO grants to anon/
--     authenticated: service-role (trusted server) only. Existing RLS untouched.

-- 1) WhatsApp-origin workspaces without a web-auth owner.
alter table public.workspaces add column if not exists created_via text not null default 'web';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_created_via_ck') then
    alter table public.workspaces
      add constraint workspaces_created_via_ck
      check (created_via in ('web', 'whatsapp'));
  end if;
end $$;
alter table public.workspaces alter column owner_user_id drop not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_owner_or_whatsapp_ck') then
    alter table public.workspaces
      add constraint workspaces_owner_or_whatsapp_ck
      check (owner_user_id is not null or created_via = 'whatsapp');
  end if;
end $$;

-- 2) Owner trigger: membership only for workspaces that HAVE an owner.
-- Base migration created the trigger; OR REPLACE only changes function behavior.
create or replace function public.add_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.owner_user_id is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (new.id, new.owner_user_id, 'owner');
  end if;
  return new;
end;
$$;

-- 3) WhatsApp sender identities (HMAC only, no raw phone numbers).
create table if not exists public.whatsapp_identities (
  id uuid primary key default gen_random_uuid(),
  sender_hmac text not null unique,
  workspace_id uuid references public.workspaces(id) on delete set null,
  account_type text check (account_type is null or account_type in ('individual', 'organization')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists whatsapp_identities_workspace_idx on public.whatsapp_identities (workspace_id);

-- 4) Persistent conversation sessions: one row per sender, survives restarts/retries.
-- workspace/client/batch references give DB-level integrity; SET NULL keeps history
-- if a referenced row is removed. Cross check "client belongs to workspace" stays
-- application-enforced (route verifies before persisting).
create table if not exists public.whatsapp_sessions (
  sender_hmac text primary key references public.whatsapp_identities(sender_hmac) on delete cascade,
  state text not null default 'new'
    check (state in (
      'new', 'awaiting_account_type', 'awaiting_org_name', 'awaiting_client_select',
      'awaiting_client_name', 'collecting', 'cancelled'
    )),
  workspace_id uuid references public.workspaces(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  batch_id uuid references public.invoice_batches(id) on delete set null,
  last_provider_message_id text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 5) Durable intake lifecycle on the existing webhook_events table.
alter table public.webhook_events add column if not exists status text not null default 'received';
alter table public.webhook_events add column if not exists attempts integer not null default 0;
alter table public.webhook_events add column if not exists last_error_code text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'webhook_events_status_ck') then
    alter table public.webhook_events
      add constraint webhook_events_status_ck
      check (status in ('received', 'accepted', 'failed'));
  end if;
end $$;
create index if not exists webhook_events_pending_idx
  on public.webhook_events (received_at)
  where processed_at is null and status in ('received', 'failed');

-- 6) RLS: service-role only. No policies for anon/authenticated, no grants.
alter table public.whatsapp_identities enable row level security;
alter table public.whatsapp_sessions enable row level security;
-- (Intentionally no CREATE POLICY and no GRANT to anon/authenticated:
--  the server uses the service-role key which bypasses RLS. Browser access stays denied.)
