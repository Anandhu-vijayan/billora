# India privacy and production security readiness (internal)

This is an engineering readiness document, not a published privacy notice, legal opinion, or certification of compliance.

## Current technical controls found in the repository

- WhatsApp webhook signature verification using the Meta app secret.
- HMAC-derived sender identity instead of storing raw WhatsApp sender numbers in the identity table.
- Application-level AES-256-GCM encryption for source files and generated workbooks.
- Private storage buckets and authenticated workbook download with a workspace-membership check.
- Workspace-scoped foreign keys and row-level security policies in the initial schema.
- A durable Postgres job queue with leases, retries, stale-job recovery, and serialized register follow-up.
- Gemini extraction disabled by default through an operator-level privacy gate.
- Production API rate limiting uses a shared Redis REST counter; IPs are HMAC-pseudonymised before being used in Redis keys.

These controls are not a substitute for a complete authorization audit, operational configuration review, legal documentation, or independent security testing.

## Data categories to inventory

Before publishing customer-facing notices, confirm the exact data stored and processed:

- Account identifiers, email addresses, workspace and client names.
- WhatsApp sender identity and provider message identifiers.
- Original invoices, PDFs, images, OCR text, extracted tax/invoice fields and review edits.
- Generated Excel workbooks and download/delivery metadata.
- Security, application, webhook and job logs.
- Support requests and billing/payment records, if enabled.

Do not put invoice content, phone numbers, access tokens, media URLs, or raw webhook payloads in application logs.

## Third-party processing inventory to complete

For each provider, record the legal entity, purpose, data categories, processing region, retention, security terms, transfer terms, and contract/DPA status:

| Provider | Purpose | Must verify before launch |
|---|---|---|
| Meta / WhatsApp Cloud API | Message delivery, sender and media transport | Applicable Meta terms, retention and webhook data handling |
| Supabase | Database, authentication and object storage | Project region, backups, support access, subprocessors and DPA |
| Google Gemini | Optional invoice image/document extraction | Paid account, current data-use terms, region/retention and DPA |
| Hosting provider | Web app and worker execution | Runtime region, logs, backups, access controls and DPA |
| Redis REST provider | Shared rate limiting | Region, retention/TTL, access controls and DPA |

The actual deployed provider configuration must be checked; repository defaults do not prove where customer data is processed.

## Required product and operational work

- Per-workspace AI consent, including purpose, provider disclosure, consent timestamp/version, withdrawal and a no-AI path.
- A customer-facing privacy notice that explains purposes, categories, retention, processors, rights and grievance contact.
- Terms of Service and a Data Processing Agreement for accounting firms processing their clients' invoices through Billora.
- A documented retention schedule and tested deletion workflow for originals, OCR/extracted records, workbooks, logs and backups.
- A process for access, correction, erasure, grievance and consent withdrawal requests.
- Incident response, evidence preservation, escalation, and breach-notification runbooks.
- A designated privacy/grievance contact and CERT-In point of contact where legally applicable.
- Centralised security logs, time synchronisation, access review and the applicable CERT-In logging/retention requirements.
- Data-subject request and incident drills, with evidence retained.

## India legal review

Have Indian privacy counsel assess the Digital Personal Data Protection Act, 2023 and the phased commencement of the DPDP Rules, 2025, along with CERT-In Directions, 2022 and any sector/customer-specific obligations. Determine Billora's role separately for its own account and service data versus invoice data processed on behalf of accounting-firm customers. Do not claim blanket data localisation or compliance without a documented legal and infrastructure assessment.

## Release evidence

Do not mark privacy/security readiness complete until the team can produce:

1. A data-flow and subprocessor register.
2. Approved customer-facing notices and contracts.
3. A per-workspace AI consent audit trail.
4. A retention/deletion test report, including backup expiry.
5. Cross-tenant authorization and storage-access test results.
6. A security incident response and notification exercise.
7. A production region/configuration inventory.
8. A documented security review and remediation log.
