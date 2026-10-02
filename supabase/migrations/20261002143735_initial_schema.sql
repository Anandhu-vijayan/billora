-- Billora core schema
-- Invoice text is NOT stored as plain text here.
-- Store extracted content in encrypted_payload, encrypted by your server
-- with an appropriately managed encryption key.

create extension if not exists pgcrypto;

-- Workspaces are the tenant boundary.
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_type text not null
    check (account_type in ('individual', 'organization')),
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member'
    check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- Add the creator as the workspace owner automatically.
create or replace function public.add_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_user_id, 'owner');
  return new;
end;
$$;

create trigger add_workspace_owner_after_insert
after insert on public.workspaces
for each row execute function public.add_workspace_owner();

-- RLS helper functions. SECURITY DEFINER avoids recursive membership policies.
create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_workspace_admin(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = (select auth.uid())
      and wm.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.is_workspace_admin(uuid) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_admin(uuid) to authenticated;

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (id, workspace_id)
);

create table public.invoice_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid,
  period_start date,
  period_end date,
  status text not null default 'open'
    check (status in ('open', 'processing', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  foreign key (client_id, workspace_id)
    references public.clients(id, workspace_id),
  unique (id, workspace_id)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  batch_id uuid,
  client_id uuid,
  file_object_path text,
  original_file_name text,
  content_type text
    check (content_type is null or content_type in (
      'application/pdf',
      'image/jpeg',
      'image/png'
    )),
  file_sha256 bytea,
  status text not null default 'received'
    check (status in (
      'received', 'queued', 'processing', 'needs_review',
      'completed', 'failed', 'deleted'
    )),
  received_at timestamptz not null default now(),
  source_deleted_at timestamptz,
  retention_expires_at timestamptz,
  foreign key (batch_id, workspace_id)
    references public.invoice_batches(id, workspace_id),
  foreign key (client_id, workspace_id)
    references public.clients(id, workspace_id),
  unique (id, workspace_id)
);

-- Store extracted invoice data encrypted by the application, not as readable JSON.
create table public.extracted_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_id uuid not null,
  encrypted_payload bytea not null,
  encryption_key_version text not null,
  review_status text not null default 'needs_review'
    check (review_status in ('needs_review', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (invoice_id, workspace_id)
    references public.invoices(id, workspace_id) on delete cascade,
  unique (invoice_id)
);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_id uuid,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  safe_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (invoice_id, workspace_id)
    references public.invoices(id, workspace_id)
);

-- Keep only a provider message ID for deduplication: never store the raw
-- WhatsApp webhook body, invoice text, tokens, or media URLs here.
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider_message_id text not null unique,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table public.generated_workbooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  batch_id uuid,
  file_object_path text not null,
  status text not null default 'ready'
    check (status in ('ready', 'sent', 'expired', 'deleted')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (batch_id, workspace_id)
    references public.invoice_batches(id, workspace_id)
);

-- Enable RLS on every app table.
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.clients enable row level security;
alter table public.invoice_batches enable row level security;
alter table public.invoices enable row level security;
alter table public.extracted_records enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.webhook_events enable row level security;
alter table public.generated_workbooks enable row level security;

-- Workspace policies.
create policy "members can read their workspaces"
on public.workspaces for select to authenticated
using (public.is_workspace_member(id));

create policy "users can create their own workspace"
on public.workspaces for insert to authenticated
with check (owner_user_id = (select auth.uid()));

create policy "workspace admins can update workspace"
on public.workspaces for update to authenticated
using (public.is_workspace_admin(id))
with check (public.is_workspace_admin(id));

create policy "members can read workspace membership"
on public.workspace_members for select to authenticated
using (public.is_workspace_member(workspace_id));

-- Clients.
create policy "members can read clients"
on public.clients for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "members can add clients"
on public.clients for insert to authenticated
with check (public.is_workspace_member(workspace_id));

create policy "members can update clients"
on public.clients for update to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

-- Batches.
create policy "members can read batches"
on public.invoice_batches for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "members can add batches"
on public.invoice_batches for insert to authenticated
with check (public.is_workspace_member(workspace_id));

create policy "members can update batches"
on public.invoice_batches for update to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

-- Invoice metadata.
create policy "members can read invoices"
on public.invoices for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "members can add invoices"
on public.invoices for insert to authenticated
with check (public.is_workspace_member(workspace_id));

create policy "members can update invoices"
on public.invoices for update to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

-- Extracted content is readable to workspace members only.
-- No browser insert/update policy: write it through your trusted server/worker.
create policy "members can read extracted records"
on public.extracted_records for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "members can read processing status"
on public.processing_jobs for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "members can read generated workbook metadata"
on public.generated_workbooks for select to authenticated
using (public.is_workspace_member(workspace_id));

-- Explicit table privileges; RLS still limits which rows are accessible.
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.workspaces,
  public.workspace_members,
  public.clients,
  public.invoice_batches,
  public.invoices,
  public.extracted_records,
  public.processing_jobs,
  public.generated_workbooks
to authenticated;

-- Create private buckets. No direct browser access policies are added.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'billora-invoices',
    'billora-invoices',
    false,
    20971520,
    array['application/pdf', 'image/jpeg', 'image/png']
  ),
  (
    'billora-exports',
    'billora-exports',
    false,
    20971520,
    array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
  )
on conflict (id) do nothing;
