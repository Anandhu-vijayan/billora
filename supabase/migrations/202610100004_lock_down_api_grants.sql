
-- Billora: reduce direct PostgREST access to application tables.
-- Existing RLS policies remain in force.

BEGIN;

-- Remove broad direct privileges from public API roles.
REVOKE ALL PRIVILEGES ON TABLE
  public.workspaces,
  public.workspace_members,
  public.clients,
  public.invoice_batches,
  public.invoices,
  public.extracted_records,
  public.processing_jobs,
  public.webhook_events,
  public.generated_workbooks
FROM anon, authenticated;

-- Workspace dashboard: only the operations currently required.
GRANT SELECT, INSERT, UPDATE
ON TABLE public.workspaces
TO authenticated;

GRANT SELECT
ON TABLE public.workspace_members
TO authenticated;

GRANT SELECT, INSERT, UPDATE
ON TABLE public.clients,
         public.invoice_batches,
         public.invoices
TO authenticated;

-- Read-only access to stored results.
GRANT SELECT
ON TABLE public.extracted_records,
         public.generated_workbooks
TO authenticated;

-- No direct browser/API access to internal queue or webhook tables.
-- Keep server-side service_role access intact.

-- Trigger function: it should not be directly callable by API users.
REVOKE EXECUTE ON FUNCTION public.add_workspace_owner()
FROM PUBLIC, anon, authenticated;

COMMIT;