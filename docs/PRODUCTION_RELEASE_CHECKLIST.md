# Production release checklist

This checklist is an operational gate, not a certification. Complete it separately for staging and production.

## Before deploying this branch

- [ ] Configure RATE_LIMIT_REDIS_REST_URL, RATE_LIMIT_REDIS_REST_TOKEN and RATE_LIMIT_HMAC_KEY in the hosting environment. Generate a unique random 32-byte-or-stronger HMAC key; never reuse encryption, path, sender-identity or review-link keys.
- [ ] Verify the Redis REST endpoint is reachable from every application region and that the token has only the permissions needed for rate-limit commands.
- [ ] Confirm the Redis database region, TTL behavior, access policy, and provider DPA/subprocessor terms.
- [ ] Confirm WHATSAPP_GRAPH_VERSION is set to the Meta Graph API version currently enabled for the app.
- [ ] Confirm all secrets are configured separately in development, preview and production.
- [ ] Apply only reviewed pending Supabase migrations to the intended project; capture the migration list before and after.

## Rate limiter verification

- [ ] Send requests from one client IP across two application instances; the combined count must share one limit.
- [ ] Confirm request 61 in the 60-second fixed window returns 429 with Retry-After.
- [ ] Confirm the Redis key contains only the HMAC digest, never the raw IP address.
- [ ] Temporarily make Redis unavailable in staging; protected API routes must return 503, not silently fall back to per-instance memory.
- [ ] Confirm signed WhatsApp webhook deliveries and the secret-protected worker remain available through their own authentication controls.
- [ ] Verify the hosting edge overwrites forwarded-IP headers; do not trust client-supplied forwarding headers on a direct-origin deployment.

## Invoice and queue verification

- [ ] Upload five distinct invoice files in one WhatsApp burst. Reconcile received, stored, extracted, review-required and workbook row counts.
- [ ] Resend one exact file. Confirm no second invoice or extraction job is created and the acknowledgement reflects the existing invoice status.
- [ ] Redeliver the same provider message concurrently. Confirm one durable intake outcome and no duplicate side effects.
- [ ] Run multiple workers against one queue. Confirm jobs are claimed once, leases are renewed, stale workers cannot settle reclaimed jobs, and retries are bounded.
- [ ] Complete an invoice while its register is building. Confirm exactly one queued follow-up remains and the final workbook contains the late invoice.
- [ ] Kill a worker during extraction and register generation. Confirm lease recovery and no partial workbook is marked ready.
- [ ] Verify needs_review and failed invoices are never silently presented as exported.

## Privacy, deletion and recovery

- [ ] Complete endpoint-by-endpoint cross-workspace authorization tests for user, client, invoice, workbook, storage and signed-link identifiers.
- [ ] Implement and test retention/deletion for source files, extracted payloads, workbooks, webhook/session records, logs and backup expiry.
- [ ] Verify encryption key backup and a restore drill; document key rotation and recovery ownership.
- [ ] Confirm Supabase, hosting, Redis and optional Gemini processing regions and contract terms.
- [ ] Complete per-workspace AI consent and withdrawal before enabling cloud invoice extraction for customers.
- [ ] Approve and publish legally reviewed privacy notice, terms and customer DPA; establish grievance and data-rights request handling.
- [ ] Complete the India legal assessment for DPDP commencement, CERT-In applicability, log retention/location, incident reporting and point-of-contact requirements.

## Go / no-go

A release is NO-GO if CI fails, the production rate limiter is unconfigured, a cross-tenant test passes unexpectedly, a backup cannot be restored, a real five-file batch loses eligible invoices, or a customer-facing privacy/legal requirement is unresolved.
