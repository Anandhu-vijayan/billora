alter table public.workspaces
  add column if not exists gemini_consent_at timestamptz,
  add column if not exists gemini_consent_version text,
  add column if not exists gemini_consent_actor uuid
    references auth.users(id) on delete set null;

comment on column public.workspaces.gemini_consent_at is
  'Timestamp of explicit workspace-owner/admin consent to optional Google Gemini invoice processing.';
comment on column public.workspaces.gemini_consent_version is
  'Version of the customer-facing disclosure accepted for optional Google Gemini processing.';
