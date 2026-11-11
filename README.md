# Billora

Billora is a WhatsApp-first invoice-to-Excel service built with Next.js, Supabase/Postgres, private object storage, and durable database-backed processing jobs. It accepts invoice PDFs and images, extracts and validates invoice fields, supports human review, and generates monthly workbooks. The repository includes OCR, encryption, WhatsApp intake, worker, delivery, and workspace-scoped data-access code. A passing CI build is not a production security or compliance certification; use the release gates below before onboarding real customers.

## Requirements

- Node.js 22 or newer (supabase-js no longer supports Node 20 and below)
- npm
- A Supabase project for database-backed development

## Local development

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env.local` and fill in the values required by your environment.
3. Start the Next.js development server with `npm run dev`.
4. Open `http://localhost:3001`.

Keep secret keys server-side, never add a secret to a `NEXT_PUBLIC_` variable, and use separate credentials for local, preview, and production environments. The publishable key is designed for client use when a browser integration is added; access control must still rely on authenticated sessions and database row-level security.

## Project structure

```text
app/
  api/health/route.ts            # liveness probe (no dependencies)
  api/health/supabase/route.ts   # Supabase connectivity check (service_role, no secrets in output)
  lib/env.ts                     # zod-validated env, single readable error when misconfigured
  lib/logger.ts                  # JSON logs with automatic secret redaction
  lib/api-response.ts            # ok()/fail() envelope, generic client error messages
  lib/validation.ts              # shared zod schemas (UUIDs, pagination)
  lib/supabase/admin.ts          # lazy service_role client (server only)
  lib/supabase/server.ts         # back-compat re-export (lazy Proxy)
  lib/supabase/client.ts         # browser client (publishable key only)
proxy.ts                       # request id + shared Redis REST rate limiting in production
scripts/smoke.mjs                # `npm run smoke` — hits both health endpoints
scripts/secret-scan.mjs          # `npm run secret-scan` — blocks secret-looking staged diffs
supabase/migrations/             # workspace-scoped schema + RLS (source of truth)
```

## WhatsApp invoice intake and processing

The current flow supports Individual and Organization workspaces, client selection, batch assignment, invoice PDF/image intake, exact-file duplicate detection, `Done`, `Review`, review editing/approval, register generation, and workbook delivery. The conversation and job state is persisted in Supabase so webhook retries and worker restarts do not rely on process memory. Check the conversation and migration code before changing commands or lifecycle rules; older phase notes in commit history may be obsolete.

### Manual migration (do NOT auto-apply)
1. Review `supabase/migrations/20261010120000_whatsapp_onboarding_v1.sql`.
2. Apply to the dev project first: `supabase db push` (or run the SQL in the dashboard SQL editor).
3. Set `WHATSAPP_IDENTITY_HMAC_KEY` (32+ chars, server only) and restart the server.

### Security notes
- Sender identity is HMAC-SHA256 with `WHATSAPP_IDENTITY_HMAC_KEY`; raw phone numbers are never stored or logged.
- Bot workspaces use `created_via='whatsapp'` with NULL `owner_user_id`; existing web workspaces keep their owners. New tables have RLS with no browser policies (service-role only).
- Client selections are re-verified against the sender's workspace; unknown reply IDs re-prompt safely.

## Invoice extraction architecture (hybrid — not fully offline)

Billora extracts invoice fields using a **hybrid local-first pipeline**. It is
explicitly **not** an offline product: an optional cloud assistant exists behind
an operator-controlled privacy gate.

1. **Local-first extraction (private, default).** `pdf.js` (`pdfjs-dist`) reads
    up to 10 pages of embedded PDF text; scanned PDFs are rendered and OCR'd page
  by page within the same limit. Uploaded images use Tesseract.js. Sharp
  normalizes orientation, contrast and resolution before OCR. The English
  `eng.traineddata` model is loaded locally; no OCR text or image is sent to a
  network service by this step. A deterministic parser maps recognized text to
  fields, and `lib/ocr/ledger.ts` evaluates the actual field values and
  validation checks before any row can be approved.
  Money arithmetic is reconciled in integer paise. Printed tax rates and total
  amounts in words are independent cross-checks; a disagreement sends the row
  to review and never rewrites an extracted value.
2. **Optional AI assistant (gated).** Only when an operator sets
  `EXTRACTION_ALLOW_AI=true`, confirms a paid tier (`EXTRACTION_AI_TIER=paid`
  after completing paid API activation), and supplies a usable Gemini API key
  with `EXTRACTION_PROVIDER=gemini` is Google Gemini consulted — for the fields
  the local parser could not resolve. AI **assists**: valid local values
   are kept and AI only fills gaps (`mergeCandidates`); its output is
   independently re-validated and can never silently overrule good local data or
   bypass the deterministic checks. Transient provider errors requeue; malformed
   or refused responses are handled as permanent failures.
3. **Human review.** Anything still incomplete, inconsistent or low-confidence is
   stored with `review_status='needs_review'` and a clear reason. Nothing is ever
   fabricated to force an approval.

> **Data-exposure note:** enabling AI sends a rendered image (or the document
> bytes) of a real customer invoice to Google. Keep `EXTRACTION_ALLOW_AI=false`
> until paid activation is actually complete and the provider's data-processing
> terms are acceptable. The original files and generated workbooks are encrypted
> at rest; workbooks are served only through the authenticated
> `/api/exports/[id]/download` route after a workspace-membership re-check.

### Validation rules (what decides approved vs needs_review)

`lib/ocr/ledger.ts` never trusts an extractor's own confidence; a row is
auto-approved only when every check passes:

- **GSTIN**: shape, state code **and mod-36 checksum** (`lib/ocr/gstin.ts`). A
  regex-valid GSTIN that fails the checksum is treated as an OCR/transcription
  error. When an invoice prints two GSTINs, the supplier is chosen by label
  (seller / sold by vs bill to / buyer), checksum validity and, when known, by
  excluding the recipient — never "first match".
- **Arithmetic**: taxable + CGST + SGST + IGST = total (±₹1.01 round-off). An
  unprinted tax head counts as 0 only if this still reconciles.
- **Structure**: total is non-zero; IGST and CGST/SGST are not both charged;
  CGST = SGST; and when both GSTINs were read, IGST vs CGST+SGST must agree with
  the two state codes.
- **Date**: parses day-first, is not in the future and not before GST (1 Jul
  2017). An implausible date is flagged and the invoice is not batched.

When the AI read fails a re-readable check (checksum, arithmetic, swapped
parties, date), the handler makes **one** targeted second AI call that names the
failed checks, adopts it only if it is strictly better, and skips it when the
first call was slow. Raster image-quality gating is implemented. Per-workspace
AI consent and a representative, labelled real-invoice calibration corpus remain
outstanding; the operator-level AI flag is not a substitute for customer consent.

Extraction accuracy against real Indian invoices is **not yet certified**; the
deterministic parsing and review logic are unit-tested, but OCR/render quality
must still be validated on representative documents before production use.

## Quality checks

- `npm run lint` runs ESLint.
- `npm run typecheck` runs the TypeScript compiler without emitting files.
- `npm test` runs the invoice, OCR, deduplication, workbook, delivery, and security source-contract regression suite.
- `npm run secret-scan` fails on secret-looking staged diffs.
- `npm run check` runs secret-scan, lint, and typecheck.
- `npm run build` creates an optimized production build.
- `npm run start` serves the production build.
- `npm run smoke` hits `/api/health` and `/api/health/supabase` (dev server must be running).

`GET /api/health` is a process liveness check only. `GET /api/health/supabase` verifies service_role connectivity with a `workspaces` count query and returns `{ ok, data }` or a generic `{ ok:false, error }` envelope — never stack traces or secrets.

## Security baseline (implemented)

- Zod-validated env at request time (`lib/env.ts`); one clear error instead of `supabaseUrl is required` crashes.
- Lazy Supabase admin client; no secrets in browser bundles, no `NEXT_PUBLIC_` secrets.
- Generic API error envelope; logs carry `x-request-id`, secrets auto-redacted by `lib/logger.ts`.
- Security headers in `next.config.ts` (+ CSP and HSTS in production). `proxy.ts` uses an atomic Redis REST counter and HMAC-pseudonymised client-IP keys in production; configure `RATE_LIMIT_REDIS_REST_URL`, `RATE_LIMIT_REDIS_REST_TOKEN`, and `RATE_LIMIT_HMAC_KEY`. Production non-exempt API requests fail closed with 503 if the shared limiter is unavailable. The signed WhatsApp webhook and secret-protected worker have separate authentication controls.
- `robots.ts` disallows indexing; error boundaries never render internals.
- CI runs secret-scan + lint + typecheck + build; build uses placeholder public env only.

## Supabase

The initial migration is in `supabase/migrations`. It defines workspace-scoped records, private storage buckets, and row-level security policies. Review the migration and test the policies against an isolated development project before applying it to production. Never disable RLS to make an application query work. Application endpoints and server actions must independently authenticate each request, authorize the workspace operation, validate input, and avoid returning invoice contents or secrets in errors and logs.

`supabase/config.toml` points its seed path at `./seed.sql`, which is intentionally absent — `supabase db reset` will warn but still work. Add a `supabase/seed.sql` with non-sensitive fixture rows if you want deterministic local resets.

Application-level AES-256-GCM encryption, upload validation, and database-backed job execution are implemented in the application code. Managed KMS integration and tested key rotation, retention/deletion enforcement, backup/restore drills, and a full operational audit are not established by the repository alone. Configure and verify the live Supabase project and hosting platform separately.

## Deployment gate

Before opening general commercial access, complete and evidence these release gates:

- Run end-to-end tests for five-file batches, concurrent webhook redelivery, simultaneous workers, worker crashes, stale leases, and register follow-up rebuilds against real PostgreSQL.
- Add atomic webhook-event leases/claims; current insert-or-read intake is idempotent downstream but does not itself provide an exclusive processing lease for simultaneous deliveries.
- Complete an endpoint-by-endpoint authorization review, including every service-role query, workspace membership/role changes, object access, and signed download lifecycle.
- Implement and test retention/deletion across source files, extracted payloads, workbooks, logs, and backups; the presence of `retention_expires_at` alone does not enforce deletion.
- Add per-workspace AI-processing consent and document Gemini/Supabase/Meta/hosting subprocessors, processing regions, retention and contract terms.
- Publish legally reviewed Privacy Policy, Terms, and (for accounting-firm customers) Data Processing Agreement; establish rights/grievance handling and an incident-response process.
- Assess DPDP Act/Rules and CERT-In applicability with Indian counsel; implement the required security logging, incident reporting and point-of-contact controls where applicable.
- Configure Redis REST rate-limiter secrets in production, verify its outage behavior, and load-test rate limits and worker/provider concurrency.
- Establish global worker/Gemini concurrency budgets, queue-age alerts, central monitoring, key rotation, backup verification and restore drills.
- Verify production environment variables, HTTPS, Supabase redirect allow-lists, email delivery, storage bucket privacy, database region, and operational alerting.
- Run a real representative invoice corpus evaluation. OCR unit tests do not certify extraction accuracy on unseen customer documents.

The app sets baseline response security headers and does not expose stack traces in its error pages. Review headers and the platform configuration together before deployment; security headers alone do not replace authentication, authorization, or application-specific content security policy.
