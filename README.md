# Billora

Billora is an invoice operations application built with Next.js and Supabase. The repository currently contains the web foundation and the initial Supabase schema. Authentication, workspace screens, invoice upload, and processing workers are not implemented yet; do not deploy it as a working invoice service until those workflows and their security controls are complete.

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
proxy.ts                       # request id + basic in-memory /api rate limiting
scripts/smoke.mjs                # `npm run smoke` — hits both health endpoints
scripts/secret-scan.mjs          # `npm run secret-scan` — blocks secret-looking staged diffs
supabase/migrations/             # workspace-scoped schema + RLS (source of truth)
```

## WhatsApp onboarding V1 (Phase 1)

Flow: `Hi` → Individual / Organization buttons → (org: name → client list / add client) → collecting.
No document-type question in V1 — classification is automatic in a later phase.

### Implemented commands
- `Help` — state-aware help text, no state change.
- `Cancel` — resets to `cancelled`; `Hi` restarts.

### Deferred to next phase
- `Done` — ends the current batch (needs batch lifecycle).
- `Change client` / `Add client` as mid-collection commands — add-client only exists inside onboarding.
- `Change type` — obsolete in V1 (no manual document types).
- Media→batch linking (media still uploads via the existing pipeline; batch linkage is Phase 2).

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
first call was slow. Not yet built (see notes below): image-quality gating,
per-workspace AI consent, and a calibration set of real invoices.

Extraction accuracy against real Indian invoices is **not yet certified**; the
deterministic parsing and review logic are unit-tested, but OCR/render quality
must still be validated on representative documents before production use.

## Quality checks

- `npm run lint` runs ESLint.
- `npm run typecheck` runs the TypeScript compiler without emitting files.
- `npm test` runs the zero-dependency onboarding contract tests (`node --test`).
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
- Security headers in `next.config.ts` (+ CSP and HSTS in production), `proxy.ts` rate-limits `/api/*` (60 req/min/IP, in-memory — use Redis/Upstash for multi-instance prod).
- `robots.ts` disallows indexing; error boundaries never render internals.
- CI runs secret-scan + lint + typecheck + build; build uses placeholder public env only.

## Supabase

The initial migration is in `supabase/migrations`. It defines workspace-scoped records, private storage buckets, and row-level security policies. Review the migration and test the policies against an isolated development project before applying it to production. Never disable RLS to make an application query work. Application endpoints and server actions must independently authenticate each request, authorize the workspace operation, validate input, and avoid returning invoice contents or secrets in errors and logs.

`supabase/config.toml` points its seed path at `./seed.sql`, which is intentionally absent — `supabase db reset` will warn but still work. Add a `supabase/seed.sql` with non-sensitive fixture rows if you want deterministic local resets.

The schema expects invoice content to be encrypted by a trusted server or worker before storage. Key management, upload validation, retention enforcement, job execution, backups, and restore procedures are not implemented in this repository.

## Deployment gate

Before serving real users or financial documents:

- Implement and test sign-in, session handling, workspace authorization, and account recovery.
- Add authenticated invoice upload and processing paths with strict size/type validation, malware scanning, rate limits, and private object access.
- Verify RLS behavior with tests for cross-workspace access and role changes.
- Establish encryption-key storage and rotation, retention/deletion jobs, audit logging, monitoring, and backup/restore drills.
- Configure production environment variables, HTTPS, Supabase redirect allow-lists, email delivery, and operational alerting.
- Add end-to-end tests for critical user and data-isolation workflows.

The app sets baseline response security headers and does not expose stack traces in its error pages. Review headers and the platform configuration together before deployment; security headers alone do not replace authentication, authorization, or application-specific content security policy.
