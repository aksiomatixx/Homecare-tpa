<div align="center">

<img src="docs/assets/claimlayer-mark.png" width="84" alt="ClaimLayer logo"/>

# ClaimLayer

**Agentic AI for workers' compensation claims — deterministic guardrails, a licensed human at every decision.**

A regulatory-aware execution layer that runs AI agents on top of existing claims systems — without replacing them.

**[claimlayer.org](https://claimlayer.org)** — product site, narrated tour, and the interactive demo

`1,352 tests · 92 suites` · Node.js / Express · React / Vite · PostgreSQL · Anthropic Claude API

</div>

## Production readiness

HIPAA readiness and an independent SOC 2 examination are production launch requirements, not current certifications. The public demo remains synthetic. See [pilot readiness](docs/pilot-readiness.md) for deployment prerequisites and unresolved controls.

RFA approval recommendations now require human disposition. Referral submission does not generate determination or IMR notices. Apply `20260904000001_rfa_diary_scope.sql` before deploying this backend; unmatched historical RFA diaries stay open for manual reconciliation.

## What this is

ClaimLayer is a reference implementation of how to deploy AI agents into a highly regulated workflow — California workers' compensation claims — with the model boxed in by code rather than trusted. Five Claude agents draft compensability analyses, evaluate treatment authorizations, price settlements, and extract intake; a deterministic gate screens for Medicare interests. Each agent runs inside guardrails enforced in code, with a licensed human at every consequential decision and a queryable audit trail behind every model call. It runs on synthetic demo data — a worked example, not a live system (see [Status & scope](#status--scope)).

**The hard problem it demonstrates:** how to get real leverage from LLM agents in a domain where a wrong automated decision has legal and financial consequences — which means deciding, concretely and in code, where the model must *not* be trusted, and proving those limits hold.

## What I designed and own

I'm a California workers' compensation claims professional with a decade in the field. I owned the work that makes this credible: the domain model and claim lifecycle, the product requirements, the system architecture, the agent boundaries and the deterministic guardrails, the eval design, the acceptance criteria, code review, and delivery. Claude Code accelerated the implementation; the judgment about what to build and where AI belongs is mine, and it's the substance on display here.

## Reviewer path

Three steps, ~90 seconds, to judge the work directly:

1. **Try one prepared decision.** Open the [interactive demo](https://claimlayer.org/demo) → open any claim → **Complete action**. You'll see the dry-run of exactly what completing will do, with a required decision rationale, before anything commits.
2. **Inspect one model call.** In the demo, open the **Agents** tab → open any decision. Every Claude call is logged with its inputs, outputs, confidence, and the guardrails it tripped.
3. **Read the proof.** The [architecture writeup](docs/architecture.md); a guardrail enforced in code, not prompts ([`rfaService.js`](backend/src/services/rfaService.js) — no deny path); and the live-model eval gate ([`liveIngestionTest.js`](backend/src/scripts/liveIngestionTest.js), run by [this workflow](.github/workflows/live-ingestion-test.yml)).

## Why it's different

Most AI in the claims space does prediction — scoring which claims are likely to be expensive, litigate, or go sideways. ClaimLayer does execution: it carries out the regulatory workflow itself — drafting the analysis, applying the statutory math, generating the notices, tracking the deadlines — inside guardrails a licensed adjuster designed and enforced in code.

The deeper change is to the shape of the adjuster's day. Traditional adjusting is **reactive**: medical reports, work status reports, and legal documents arrive all day, and the job is to notice them, read them, file them, and work out what each one requires. ClaimLayer inverts that loop:

- **Inbound is automated.** Every incoming document is ingested, classified against a controlled category list, documented to the claim file, and translated into the action it requires — what reaches the adjuster is a queued decision, not a PDF.
- **The human makes the decision.** Compensability, authorization, settlement — every consequential call is a licensed adjuster's, made from a ranked action queue where the analysis is already drafted and the deadline already computed.
- **Outbound is automated.** Once the decision is made, the aftermath executes itself: the decision is documented in the audit trail, statutory notices generate and mail, completed diaries close, and the next deadline diaries are set.

The adjuster stops being a router of paperwork and becomes what the license is for: the decision-maker.

That loop is implemented end to end: a document arrives as an **actual PDF** (uploaded in the drawer, or as an email attachment via the inbound-email webhook) or as extracted text; PDFs extract their text layer locally, and scanned documents with no text layer fall back to classification of the document itself via a Claude document block — same guardrails either way; the document is classified into a controlled category by a Claude agent (every call logged to the audit trail); it is matched to its claim — or routed to a **human triage queue** when confidence is low, never silently filed; key fields are extracted and an AI summary attached; a **deterministic rules table** translates the document into the action it requires; the action surfaces in the claim drawer with the source document one click away; the adjuster sees a dry-run of **exactly what completing will do**, then approves, edits (audited — penalty diaries refuse to move), or declines with a documented reason; on approval the decision note writes back to the retained system of record, the diary completes, the successor deadline is set, and the statutory notice generates and queues. One integration test walks all ten steps.

The wedge is agentic execution within hard regulatory limits, where every AI decision is bounded, auditable, and reversible by a human.

## Architecture at a glance

The system is a layer, not a replacement: it runs agentic workflows on top of a customer's retained system of record via a pluggable integration layer. ([Full architecture writeup →](docs/architecture.md) and an in-app `/architecture` view.)

- **Six specialized agents** — compensability assessment, MTUS treatment authorization, C&R settlement pricing, voice-intake extraction, and inbound document classification (Claude), plus a **deterministic** MSA screening gate (no model — Medicare eligibility is a threshold rule) — each with authored prompts, explicit invocation triggers, and bounded output schemas.
- **Guardrails enforced in code** — not in prompts. The model cannot take certain actions regardless of what it returns (see below).
- **Human-in-the-loop checkpoints** at every compensability, authorization, and settlement decision, backed by a licensed adjuster's judgment.
- **Full AI decision audit trail** — every model call is logged with its input snapshot, output, guardrails triggered, and human-override status, surfaced in an in-app `/agents` review console.
- **Legacy-system integration layer** — pluggable adapters ingest claims from an existing system and push diaries, documents, and notices back, so agents deploy onto a system of record rather than demanding migration off it.
- **Regulatory data discipline** — statutory values come from authoritative DWC sources, never from the model.

## Engineering decisions that signal the intent

These are the choices that show, in code, where the model is and isn't trusted. Guardrails live in the [service layer, not the prompts](backend/src/services/documentIngestionService.js) — the model cannot reach past them regardless of what it returns:

- **No auto-deny pathway exists anywhere in the system.** On treatment authorizations, an agent may only return `auto_approve` or `physician_review` — never a denial ([`rfaService.js`](backend/src/services/rfaService.js)). Denials are a licensed-human-only action by construction.
- **Reserve changes require a licensed adjuster's approval.** The AI may suggest reserves; nothing is written to the financial system of record until an adjuster approves it.
- **A deterministic MSA screen gates every settlement** — Medicare-interest screening is not left to the model's discretion.
- **Statutory values are never model-generated.** Rating schedules, fee schedules, and caps are sourced from authoritative DWC publications and version-controlled; the model reasons over them but never invents them.
- **Penalty and deadline diaries cannot be snoozed**, and statutory deadlines use the correct calendar/business-day basis per the governing code section.
- **Supervisor oversight is deterministic.** A daily business-morning digest lists every CRITICAL/no-snooze diary due today and every overdue diary across the book, grouped by adjuster — plain queries, no model involvement, acknowledged with an audit trail.

## Testing

1,352 automated tests across 92 suites: 1,268 backend tests (Jest) covering benefits-calculation math, statutory-deadline logic, state-machine transitions, atomic decision workflows, and adversarial guardrail tests that attempt to push agents past their bounds and assert that the guardrails hold — plus 84 frontend tests (Vitest + Testing Library) covering the drawer tabs, decision-loop services, and a full-app smoke render.

Worth a reviewer's eye specifically:

- **Live-model eval gate** — [`liveIngestionTest.js`](backend/src/scripts/liveIngestionTest.js), run in CI by [`live-ingestion-test.yml`](.github/workflows/live-ingestion-test.yml): 13 golden documents through the *real* classifier, asserting category, claim match, and routing on every run. It has already caught the model over-applying a signal — fixed deterministically in code.
- **End-to-end document-to-action path** — [`document-to-action.e2e.test.js`](backend/tests/integration/document-to-action.e2e.test.js) walks arrival → classification → claim match → triage-or-file → action diary → write-back.
- **Schema-contract test** — [`migration-contract-test.js`](backend/scripts/migration-contract-test.js) asserts every write shape the code performs against a schema built only from the migrations, so code and schema cannot silently drift.

## Tech stack

Node.js / Express · React / Vite · PostgreSQL (Supabase) · Anthropic Claude API · server-side PDF generation (pdf-lib).

## How this was built

Built solo: I owned the domain model, architecture, agent boundaries, guardrails, eval design, acceptance criteria, review, and delivery (see [What I designed and own](#what-i-designed-and-own)); Claude Code accelerated the implementation. ClaimLayer is what a decade of claims domain expertise plus AI-assisted development produces when the architecture and the regulatory constraints come from someone who has lived inside the workflow.

## Status & scope

A reference implementation and active project — not a live system processing real claims. It runs on synthetic demo data and is not affiliated with any employer. It's meant to demonstrate the deployment patterns, not to serve as legal or claims-handling advice.

## Try the demo

### Prerequisites

The demo runs against a real PostgreSQL database via Supabase — there is no in-memory fallback, because the audit trail and row-level security are part of what's being demonstrated.

1. **Node.js 20+** (CI runs on 24).
2. **A Supabase project** — either of:
   - **Local (recommended):** install the [Supabase CLI](https://supabase.com/docs/guides/cli) and Docker, then run `supabase start` from the repo root. The repo ships a `supabase/config.toml`, so this spins up a full local stack and applies every migration in `supabase/migrations/` automatically. The command prints the `API URL`, `anon key`, and `service_role key` to put in `backend/.env`.
   - **Hosted:** a free-tier project at [supabase.com](https://supabase.com); apply the migrations in `supabase/migrations/` in filename order (SQL editor, `psql`, or `supabase db push`).
3. **Environment** — copy `backend/.env.example` to `backend/.env`, then fill in:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (printed by `supabase start`)
   - `JWT_SECRET` (any random string for local use — `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`)
   - `ANTHROPIC_API_KEY` — optional; without it the app runs but agent analyses are unavailable
   - `FILEHANDLER_API_KEY`, `ADP_CLIENT_ID`, `ADP_CLIENT_SECRET` — required to be *set* (the backend refuses to boot without them), but the demo-safe mock values already in `.env.example` (`mock-fh-key` / `mock` / `mock`) are all the demo needs; no real vendor accounts
   - SendGrid / Twilio / Lob keys are **not** required for the demo

### Run it

```bash
npm ci --prefix backend && npm ci --prefix frontend   # lockfile-exact installs (no root install needed)
npm run dev:demo      # wipes demo-flagged rows, seeds 14 synthetic claims, starts backend (:3001) + frontend (:5173)
```

### Test the document pipeline with real PDFs

```bash
npm run gen:test-docs   # writes test-documents/*.pdf + manifest.json
```

Generates 13 realistic inbound claim documents (PR-2s, a DWC Form RFA, a PR-4, a QME notice, bills, a wage statement, attorney filings…) as actual PDFs whose claim numbers, claimants, DOIs, and employers match the seeded demo book — each one is the natural next inbound document for its claim's lifecycle stage. Upload one through the claim drawer (or `POST /api/v1/documents/ingest-file`) and watch it classify, match by extracted claim number, file to the claim, and queue its action diary. One file deliberately carries no claim number so it lands in the human triage queue. Claim numbers embed the current year and dates are relative to the generation date, so regenerate after each re-seed. `manifest.json` lists the expected category and routing for every file.

### Deploying

Apply migrations **before** deploying the matching backend (the code
writes columns the migrations create — `migrate → deploy`, always).
CI proves the chain on every push: all migrations apply in filename
order to a clean PostgreSQL 16, the hardening migration re-applies
idempotently, and schema-contract integration tests assert every write
shape the code performs (`backend/scripts/migration-contract-test.js`).

Three workers must run in production (cron or scheduler, all also
triggerable via authenticated admin endpoints):

| Worker | Module | Endpoint | Schedule |
|---|---|---|---|
| Notice delivery | `backend/src/cron/noticeDeliveryWorker.js` | `POST /api/v1/admin/workers/notice-delivery/run` | every 15 min |
| Integration outbox | `backend/src/cron/outboxWorker.js` | `POST /api/v1/admin/workers/outbox/run` | every 5 min |
| Supervisor alerts | `backend/src/cron/supervisorAlertWorker.js` | `POST /api/v1/admin/workers/supervisor-alerts/run` | 06:30 America/Los_Angeles, Mon–Fri |

Physical mail is only marked **delivered** by a signature-verified Lob
webhook (`POST /webhooks/lob/delivery`); until then a submitted letter
is truthfully `submitted`. Set `LOB_WEBHOOK_SECRET` (and the DxF/Enlyte
secrets) in production — webhook verification fails closed without them.

The email-in document channel (`POST /webhooks/email/inbound`) is shaped
for SendGrid Inbound Parse / Mailgun Routes: point the vendor's route at
it with `?token=` matching `EMAIL_INBOUND_TOKEN` (required in
production — fails closed without it). PDF attachments run through the
standard ingestion pipeline, idempotent on the email Message-ID. The
vendor account + inbound DNS (MX) configuration is the remaining setup.

Then open the `/architecture` and `/agents` views to see the agent registry, guardrail catalog, and live decision audit trail.

## Repository structure

```
backend/    Express API, agent services, prompts/, guardrails, tests
frontend/   React/Vite app — workspace, /architecture, /agents views
supabase/   schema migrations (staged, applied manually)
docs/       architecture writeup, case study, regulatory sources
```
