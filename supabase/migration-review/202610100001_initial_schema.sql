-- Billora core schema. Apply to a NEW Supabase project only.
create extension if not exists pgcrypto;

create type public.billora_account_type as enum ('individual','organization');
create type public.billora_document_mode as enum ('purchase','expense','both');
create type public.billora_invoice_status as enum ('received','queued','processing','needs_review','completed','failed','deleted');
create type public.billora_batch_status as enum ('open','processing','completed','partial','failed','cancelled');
create type public.billora_job_status as enum ('queued','running','retry','succeeded','failed','cancelled');
create type public.billora_job_type as enum ('download_media','extract','generate_workbook','deliver','cleanup');
create type public.billora_review_status as enum ('needs_review','approved','rejected');
create type public.billora_workbook_status as enum ('ready','sent','expired','failed','deleted');

-- WhatsApp-only identities do not need an auth.users row. Populate ciphertext and
-- keyed HMAC in trusted server code; keep all keys outside PostgreSQL.
create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  whatsapp_id_ciphertext bytea,
  whatsapp_id_hmac bytea unique,
  encryption_key_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((whatsapp_id_ciphertext is null and whatsapp_id_hmac is null and encryption_key_version is null)
      or (whatsapp_id_ciphertext is not null and whatsapp_id_hmac is not null and encryption_key_version is not null))
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 160),
  account_type public.billora_account_type not null,
  owner_user_id uuid not null references public.app_users(id) on delete restrict,
  default_document_mode public.billora_document_mode not null default 'both',
  retention_days integer not null default 30 check (retention_days between 1 and 365),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id,user_id)
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  default_document_mode public.billora_document_mode,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id,workspace_id)
);

create table public.invoice_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null,
  created_by_user_id uuid references public.app_users(id) on delete set null,
  document_mode public.billora_document_mode not null,
  status public.billora_batch_status not null default 'open',
  item_count integer not null default 0 check (item_count >= 0),
  completed_count integer not null default 0 check (completed_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  opened_at timestamptz not null default now(),
  processing_started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id,workspace_id) references public.clients(id,workspace_id) on delete restrict,
  unique (id,workspace_id),
  check (completed_count <= item_count),
  check (failed_count <= item_count)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  batch_id uuid,
  client_id uuid not null,
  document_type public.billora_document_mode not null,
  file_object_path text,
  original_file_name text,
  content_type text not null check (content_type in ('application/pdf','image/jpeg','image/png')),
  file_size_bytes bigint not null check (file_size_bytes between 1 and 20971520),
  file_sha256 bytea check (file_sha256 is null or octet_length(file_sha256) = 32),
  status public.billora_invoice_status not null default 'received',
  invoice_month date check (invoice_month is null or extract(day from invoice_month) = 1),
  received_at timestamptz not null default now(),
  source_deleted_at timestamptz,
  retention_expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (batch_id,workspace_id) references public.invoice_batches(id,workspace_id) on delete restrict,
  foreign key (client_id,workspace_id) references public.clients(id,workspace_id) on delete restrict,
  unique (id,workspace_id),
  check (file_object_path is null or (length(file_object_path) between 1 and 1024 and file_object_path !~* '(^|/)\.\.(/|$)' and file_object_path !~* '^https?://'))
);

create table public.extracted_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_id uuid not null unique,
  encrypted_payload bytea not null,
  encryption_key_version text not null,
  review_status public.billora_review_status not null default 'needs_review',
  reviewed_by_user_id uuid references public.app_users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (invoice_id,workspace_id) references public.invoices(id,workspace_id) on delete cascade
);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_id uuid,
  batch_id uuid,
  job_type public.billora_job_type not null,
  status public.billora_job_status not null default 'queued',
  idempotency_key text not null unique,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  safe_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (invoice_id,workspace_id) references public.invoices(id,workspace_id) on delete cascade,
  foreign key (batch_id,workspace_id) references public.invoice_batches(id,workspace_id) on delete cascade,
  check (invoice_id is not null or batch_id is not null)
);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'whatsapp_cloud' check (provider = 'whatsapp_cloud'),
  provider_message_id text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received' check (processing_status in ('received','processing','processed','failed','ignored')),
  safe_error_code text,
  unique (provider,provider_message_id)
);

create table public.generated_workbooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null,
  batch_id uuid,
  period_month date not null check (extract(day from period_month) = 1),
  file_object_path text not null check (length(file_object_path) between 1 and 1024 and file_object_path !~* '(^|/)\.\.(/|$)' and file_object_path !~* '^https?://'),
  invoice_count integer not null default 0 check (invoice_count >= 0),
  status public.billora_workbook_status not null default 'ready',
  expires_at timestamptz not null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id,workspace_id) references public.clients(id,workspace_id) on delete restrict,
  foreign key (batch_id,workspace_id) references public.invoice_batches(id,workspace_id) on delete restrict
);

create table public.platform_admins (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by_auth_user_id uuid references auth.users(id) on delete set null
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete set null,
  actor_app_user_id uuid references public.app_users(id) on delete set null,
  actor_auth_user_id uuid references auth.users(id) on delete set null,
  action text not null check (length(action) between 1 and 100),
  target_type text check (target_type is null or length(target_type) <= 80),
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index clients_workspace_idx on public.clients(workspace_id);
create unique index clients_workspace_name_ci_uq on public.clients(workspace_id,lower(name));
create index batches_workspace_created_idx on public.invoice_batches(workspace_id,created_at desc);
create index invoices_workspace_client_month_idx on public.invoices(workspace_id,client_id,invoice_month);
create index invoices_retention_idx on public.invoices(retention_expires_at) where retention_expires_at is not null;
create index invoices_batch_idx on public.invoices(batch_id) where batch_id is not null;
create index extracted_records_workspace_idx on public.extracted_records(workspace_id);
create index jobs_ready_idx on public.processing_jobs(available_at,created_at) where status in ('queued','retry');
create index jobs_stale_lock_idx on public.processing_jobs(locked_at) where status = 'running';
create index webhook_events_unprocessed_idx on public.webhook_events(received_at) where processed_at is null;
create index workbooks_workspace_month_idx on public.generated_workbooks(workspace_id,client_id,period_month);
create index workbooks_expiry_idx on public.generated_workbooks(expires_at) where status in ('ready','sent');
create unique index workbooks_batch_client_month_uq on public.generated_workbooks(batch_id,client_id,period_month) where batch_id is not null;
create index audit_events_workspace_created_idx on public.audit_events(workspace_id,created_at desc);
