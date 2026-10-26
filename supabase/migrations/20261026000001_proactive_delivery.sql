-- 20261026000001_proactive_delivery.sql — P1 opt-in proactive register delivery.
-- Forward-only and rerunnable (IF NOT EXISTS). Applied migrations are NOT modified.
-- whatsapp_sessions already has RLS enabled with NO anon/authenticated policies
-- (service-role only), so adding columns grants no new access: the browser can
-- still never read them.
--
-- Privacy posture (§P1-6): Billora normally stores only a one-way HMAC of the
-- sender id and never the phone. Proactive delivery is a DELIBERATE, REVERSIBLE
-- exception the owner opts into:
--   * wa_id_encrypted holds the phone SEALED under a SEPARATE AES-256-GCM key
--     (WHATSAPP_PROACTIVE_KEY) — never the invoice master key, so a leaked
--     register key cannot unmask identities and vice-versa. It is written by the
--     server only, is never logged, and is never read back into any client-facing
--     payload.
--   * proactive_consent records the owner's explicit opt-in. Opting OUT sets the
--     flag false AND nulls wa_id_encrypted, so the sealed value is deleted (the
--     row keeps no residue once consent is withdrawn).
--   * The actual spontaneous push additionally requires the feature switch
--     (WHATSAPP_PROACTIVE_DELIVERY=true) and the sender's last inbound to be
--     inside Meta's 24h service window; outside it delivery falls back to the
--     existing next-inbound queue. That gating lives in the app, not here.

alter table public.whatsapp_sessions
  add column if not exists proactive_consent boolean not null default false;

alter table public.whatsapp_sessions
  add column if not exists wa_id_encrypted bytea;
