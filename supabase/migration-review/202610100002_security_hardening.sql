-- RLS, least-privilege browser access, timestamp triggers, and private buckets.
-- All service-role credentials must remain server-side.
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;

create or replace function public.current_app_user_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select au.id from public.app_users au where au.auth_user_id = (select auth.uid()) limit 1;
$$;

create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace_id and wm.user_id = (select public.current_app_user_id()));
$$;

create or replace function public.is_workspace_admin(target_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace_id and wm.user_id = (select public.current_app_user_id())
      and wm.role in ('owner','admin'));
$$;

create or replace function public.add_workspace_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.workspace_members(workspace_id,user_id,role) values (new.id,new.owner_user_id,'owner');
  return new;
end; $$;

create or replace function public.prevent_workspace_owner_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'Workspace owner cannot be changed directly';
  end if;
  return new;
end; $$;

create trigger app_users_set_updated_at before update on public.app_users for each row execute function public.set_updated_at();
create trigger workspaces_set_updated_at before update on public.workspaces for each row execute function public.set_updated_at();
create trigger clients_set_updated_at before update on public.clients for each row execute function public.set_updated_at();
create trigger batches_set_updated_at before update on public.invoice_batches for each row execute function public.set_updated_at();
create trigger invoices_set_updated_at before update on public.invoices for each row execute function public.set_updated_at();
create trigger extracted_records_set_updated_at before update on public.extracted_records for each row execute function public.set_updated_at();
create trigger jobs_set_updated_at before update on public.processing_jobs for each row execute function public.set_updated_at();
create trigger workbooks_set_updated_at before update on public.generated_workbooks for each row execute function public.set_updated_at();
create trigger add_workspace_owner_after_insert after insert on public.workspaces for each row execute function public.add_workspace_owner();
create trigger prevent_workspace_owner_change_before_update before update on public.workspaces for each row execute function public.prevent_workspace_owner_change();

alter table public.app_users enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.clients enable row level security;
alter table public.invoice_batches enable row level security;
alter table public.invoices enable row level security;
alter table public.extracted_records enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.webhook_events enable row level security;
alter table public.generated_workbooks enable row level security;
alter table public.platform_admins enable row level security;
alter table public.audit_events enable row level security;

revoke all on function public.current_app_user_id() from public,anon;
revoke all on function public.is_workspace_member(uuid) from public,anon;
revoke all on function public.is_workspace_admin(uuid) from public,anon;
grant execute on function public.current_app_user_id() to authenticated;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_admin(uuid) to authenticated;

create policy app_users_select_self on public.app_users for select to authenticated using (auth_user_id = (select auth.uid()));
create policy workspaces_select_member on public.workspaces for select to authenticated using (public.is_workspace_member(id));
create policy workspaces_insert_self on public.workspaces for insert to authenticated with check (owner_user_id = (select public.current_app_user_id()));
create policy workspaces_update_admin on public.workspaces for update to authenticated using (public.is_workspace_admin(id)) with check (public.is_workspace_admin(id));
create policy workspace_members_select_member on public.workspace_members for select to authenticated using (public.is_workspace_member(workspace_id));
create policy clients_select_member on public.clients for select to authenticated using (public.is_workspace_member(workspace_id));
create policy clients_insert_admin on public.clients for insert to authenticated with check (public.is_workspace_admin(workspace_id));
create policy clients_update_admin on public.clients for update to authenticated using (public.is_workspace_admin(workspace_id)) with check (public.is_workspace_admin(workspace_id));
create policy batches_select_member on public.invoice_batches for select to authenticated using (public.is_workspace_member(workspace_id));
create policy invoices_select_member on public.invoices for select to authenticated using (public.is_workspace_member(workspace_id));
create policy workbooks_select_member on public.generated_workbooks for select to authenticated using (public.is_workspace_member(workspace_id));

-- Sensitive/internal tables have no browser policies and no authenticated grants.
grant usage on schema public to authenticated;
grant select on public.app_users to authenticated;
grant select,insert on public.workspaces to authenticated;
grant update (name,default_document_mode,retention_days) on public.workspaces to authenticated;
grant select on public.workspace_members to authenticated;
grant select,insert,update on public.clients to authenticated;
grant select on public.invoice_batches,public.invoices,public.generated_workbooks to authenticated;
revoke all on public.extracted_records,public.processing_jobs,public.webhook_events,public.platform_admins,public.audit_events from anon,authenticated;
revoke insert,update,delete on public.app_users from anon,authenticated;
revoke insert,update,delete on public.workspace_members from anon,authenticated;
revoke insert,update,delete on public.invoice_batches,public.invoices,public.generated_workbooks from anon,authenticated;

-- Corrects privacy, limits, and MIME types even if these buckets already exist.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('billora-invoices','billora-invoices',false,20971520,array['application/pdf','image/jpeg','image/png']),
 ('billora-exports','billora-exports',false,20971520,array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update set name=excluded.name,public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

-- Intentionally no storage.objects policies. Upload/download/delete via server routes
-- after tenant authorization. Audit existing storage policies on previously used projects.
