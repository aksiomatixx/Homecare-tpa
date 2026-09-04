# Pilot readiness — September 4, 2026

Status: preparation only. No HIPAA compliance determination, SOC 2 report, production approval, or vendor BAA is conferred by this branch. Do not accept unredacted records into this reference deployment.

## Scope

The proposed first offer is a 30-day assessment of one medical-document review workflow using synthetic or fully redacted records. The draft page proposes $2,500 for up to 100 reports / 1,500 pages. These are unvalidated commercial assumptions. No claims-system writeback, notices, treatment authorization, payments, or automatic decisions are part of this offer.

## Changes in this branch

- RFA approval recommendations queue for human review. Inconsistent or missing MTUS consistency cannot lead to model approval.
- Response diaries have an explicit rfa_id. Completion affects only the matching RFA; the migration backfills exact legacy note matches and leaves ambiguous diaries unresolved.
- Failed URO submission throws and does not mark an RFA sent. A durable retry workflow remains to be implemented.
- Referral submission does not trigger determination or IMR notices. A verified physician determination return workflow remains required.
- Date-only interest inputs use UTC midnight to avoid a daylight-saving off-by-one error. Timestamp semantics and other date helpers still require a separate domain review.
- The draft pilot page removes the expired free offer and narrows capability claims.

## Before deploying this branch

1. Apply and validate all migrations, including 20260904000001_rfa_diary_scope.sql, on an isolated database before deploying backend code.
2. Reconcile legacy open RFA diaries without rfa_id; do not auto-close them.
3. Confirm the receiving operation understands human approval is now required for previously automatically approved RFAs. Historical records retain their historical status.
4. Confirm URO failures remain visible and manually monitored until a durable retry mechanism is implemented.
5. Keep the public demo and all testing synthetic. No real claim records in Git, CI, screenshots, coding assistants, or contact forms.

## Production blockers to resolve

| Area | Required implementation/evidence |
| --- | --- |
| Tenant and claim authorization | Tenant-scoped access on every route, document, background job and export; remove service-role bypass from normal user requests; negative cross-tenant tests against real database policies. Review RFA read endpoints as well as writes. |
| Authentication | Enforce MFA for staff production access, privileged separation, session revocation and offboarding; verify MFA flow with real identity provider. |
| Document storage | Private object storage; authorization before signed short-lived URLs; lifecycle, backup, restore and deletion behavior; no public claim files. |
| Audit | Required durable audit for in-scope processing, exact evaluation-to-review IDs, read/download access events, restricted immutable evidence, protected PHI payloads separately from operational logs. |
| Workflow integrity | Real transaction boundary for state and outbox records; workers see committed operations only; crash/retry and concurrency tests using real PostgreSQL. |
| Vendor processing | Actual BAAs and covered configurations for each PHI processor; explicit approved model/features; verify document/PDF processing eligibility and retention. |
| Operations | Asset and data inventory, risk assessment, incident and breach procedures, tested backups, monitoring, patching, access reviews and workforce training. |
| Independent assurance | External security review and penetration testing with remediation; CPA-agreed SOC 2 system boundary, controls and observation period. |

## Current vendor requirements

Supabase requires a signed BAA and HIPAA add-on. Its High Compliance project configuration includes point-in-time recovery, SSL enforcement, network restrictions and connection logging. Verify the shared-responsibility requirements for the purchased plan: https://supabase.com/docs/guides/platform/hipaa-projects

Anthropic requires a signed BAA and HIPAA-ready API organization activation. Coverage is feature-specific; ordinary API access does not establish coverage. Do not assume Files, Batch, beta features, coding tools or PDF processing are eligible merely because Messages API is covered. Obtain confirmation for the exact implementation: https://privacy.claude.com/en/articles/8114513-business-associate-agreements-baa-for-commercial-customers

HHS cloud guidance requires applicable risk analysis and appropriate business associate agreements; vendor arrangements do not replace ClaimLayer's obligations: https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html

SOC 2 is an independent examination/report. A vendor's report is supporting evidence, not a report on ClaimLayer: https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services
