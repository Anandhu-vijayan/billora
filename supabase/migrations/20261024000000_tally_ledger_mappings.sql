-- 20261024000000_tally_ledger_mappings.sql
-- Workspace-scoped Tally purchase-import LEDGER MAPPINGS.
--
-- Why this table exists: a GST rate is NOT a ledger name. The accountant chooses
-- which target ledger a class of purchase posts to (e.g. rate-class `local@18` ->
-- "Purchase @ 18%"); the extraction pipeline never knows this. We persist only
-- that explicit choice here so the register can fill its Ledger Name column from
-- CONFIGURATION, never from a guessed/invented name (§4 rule 2).
--
-- Forward-only and re-runnable (IF NOT EXISTS / guarded DO). Applied migrations
-- are NOT modified. Security posture mirrors extracted_records: readable to a
-- workspace MEMBER via RLS for a future settings surface, but WRITABLE only by
-- the trusted server/worker (service_role bypasses RLS) — there is deliberately
-- NO insert/update/delete policy for authenticated, so a browser can never write
-- another tenant's mapping. No credentials, tokens or invoice data are stored.
--
-- Tenant isolation is enforced two ways: the RLS read policy gates any member
-- access by is_workspace_member(workspace_id), and every worker read filters by
-- its own job's workspace_id, so one workspace's mapping can never be applied to
-- another (§4 rules 6/7).

create table if not exists public.tally_ledger_mappings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The class a line resolves to, e.g. 'local@18' / 'interstate@12' / 'local@0'.
  -- A line whose rate/treatment is unestablished resolves to 'unresolved', which
  -- is intentionally NOT a mappable key — it must be corrected at the invoice.
  rate_class_key text not null check (rate_class_key <> '' and rate_class_key <> 'unresolved'),
  -- The accountant's target ledger name. Never blank; never auto-generated.
  ledger_name text not null check (ledger_name <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Composite key so a mapping is unique per workspace + class; also the FK
  -- anchor pattern used elsewhere (id, workspace_id) for future cascade needs.
  unique (workspace_id, rate_class_key)
);

-- Fast workspace-scoped lookup during register generation.
create index if not exists tally_ledger_mappings_workspace_idx
  on public.tally_ledger_mappings (workspace_id);

alter table public.tally_ledger_mappings enable row level security;

-- Members may READ their own workspace's mappings (for a future settings view).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tally_ledger_mappings'
      and policyname = 'members can read tally ledger mappings'
  ) then
    create policy "members can read tally ledger mappings"
      on public.tally_ledger_mappings for select to authenticated
      using (public.is_workspace_member(workspace_id));
  end if;
end $$;

-- Explicit privileges: members get SELECT only (RLS still limits rows). Writes go
-- through the service-role server/worker, which bypasses RLS entirely — so the
-- browser/anon surface is read-only and workspace-isolated, never a write path.
grant usage on schema public to authenticated;
grant select on public.tally_ledger_mappings to authenticated;
revoke all on public.tally_ledger_mappings from anon;

comment on table public.tally_ledger_mappings is
  'Workspace-scoped Tally rate-class -> ledger-name mappings. Read by register generation; never a fabricated ledger. service_role writes only.';
