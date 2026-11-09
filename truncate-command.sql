DO $$
DECLARE
    table_list text;
BEGIN
    SELECT string_agg(
        format('%I.%I', schemaname, tablename),
        ', '
    )
    INTO table_list
    FROM pg_tables
    WHERE schemaname = 'public';

    IF table_list IS NOT NULL THEN
        EXECUTE
            'TRUNCATE TABLE ' || table_list ||
            ' RESTART IDENTITY CASCADE';
    END IF;
END
$$;

/*  

truncate table
  public.workbook_deliveries,
  public.generated_workbooks,
  public.duplicate_reviews,
  public.extracted_records,
  public.processing_jobs,
  public.webhook_events,
  public.pending_uploads,
  public.whatsapp_sessions,
  public.whatsapp_identities,
  public.invoice_batches,
  public.invoices,
  public.tally_ledger_mappings,
  public.workspace_preferences,
  public.workspace_members,
  public.clients,
  public.workspaces
restart identity cascade;
*/