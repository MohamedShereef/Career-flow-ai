# CareerFlow AI

An AI job-application agent: discover → evaluate → tailor → apply → verify → track.
This repository is **release 1 (Foundation)**. It is a working web application with
accounts, a verified applicant profile, an encrypted saved-answers knowledge base, a
questions inbox and a durable background worker. Discovery, AI matching, CV tailoring,
auto-apply and Gmail tracking are built on top of it in later releases.

## Architecture

```
apps/web      Next.js 15 (App Router) on Vercel — UI, server actions, /api/health
apps/worker   Node worker on Railway — durable task queue, scheduler, /health
packages/db   Drizzle ORM schema + SQL migrations for Neon Postgres (34 tables)
packages/core Business logic shared by web and worker (auth, profile, answers,
              queue, quotas, storage, crypto). Every query is scoped by user_id.
```

Why these choices:

- **One database, no Redis.** The task queue lives in Postgres (`FOR UPDATE SKIP LOCKED`),
  so tasks survive restarts and redeploys with one fewer service to run and pay for.
- **The worker is separate from Vercel.** Browser automation and long AI chains run for
  minutes, longer than Vercel request limits allow. The web app only enqueues work.
- **Business logic sits in `packages/core`**, not in pages, so it is tested directly
  against real Postgres and reused by the worker.

### Safety controls built into the foundation

| Control | Where |
|---|---|
| AES-256-GCM field encryption (phone, salaries, residency details, saved answers, OAuth tokens); key rotation supported | `core/crypto.ts` |
| scrypt password hashing, hashed session tokens, lockout after 8 failures, Postgres-backed rate limits | `core/services/auth.ts` |
| Password reset: single use, 60-minute expiry, revokes every session, never reveals whether an account exists | same |
| Numeric career facts can't be verified until the user confirms what the number means; only verified facts are usable | `core/services/profile.ts` |
| "In progress" qualifications (e.g. CIPS) are stored separately from completed ones | schema `qualifications.state` |
| Legal, protected-category, identity and conflict-of-interest questions are always flagged for review; a saved answer can't downgrade them | `core/services/answers.ts` |
| Permanent `submission_ledger` (unique per user + job) that resets never delete | schema |
| A task whose checkpoint is `irreversible` (set just before Submit) is never retried automatically; it becomes `blocked` for review | `core/services/queue.ts` |
| Pilot ceilings: 5 submissions/day, 15 inspections/day, 5 jobs/batch, manual approval for the first 5; enforced by DB constraints and validation | `core/services/settings.ts` |
| Atomic daily quotas that hold up under concurrency | same |
| Uploads are checked by file content (magic bytes), stored privately, hash-checked when downloaded, and served only to their owner | `core/services/documents.ts` |
| Append-only audit log for auth, profile, consent and document events | `audit_logs` |

## Run locally

```bash
npm install
cp .env.example .env.local     # set DATABASE_URL to a local Postgres
npm run keys                   # paste the output into .env.local
npm run db:migrate
npm run dev                    # web on http://localhost:3000
npm run dev:worker             # worker in a second terminal
```

Tests (they need a Postgres you can drop: `TEST_DATABASE_URL`, default `postgres://postgres@localhost:5432/careerflow_test`):

```bash
npm test          # 36 unit + integration tests on real Postgres
npm run e2e       # real-browser smoke test against a running app (BASE_URL, CHROME_PATH)
```

## Deploy

### Recommended: one free server (Oracle Cloud Always Free)

Postgres, web, worker, HTTPS (Caddy) and nightly backups all run on one machine through
`deploy/docker-compose.yml`. The Always Free ARM server has more memory than the
Chromium-based worker in later releases needs, and nothing here bills per request.

1. **Create the server:** Oracle Cloud → Compute → Instances → Create.
   - Image: **Ubuntu 24.04**. Shape: **VM.Standard.A1.Flex** (marked *Always Free-eligible*), 2 OCPU / 12 GB.
   - Under "Add SSH keys" choose **Generate a key pair** and **download the private key**.
   - If you get "Out of capacity", try another availability domain or try again later.
2. **Open ports 80 and 443:** Instance → Subnet → Security List → Add Ingress Rules:
   source `0.0.0.0/0`, TCP, destination ports `80,443`. The OS firewall is opened by the bootstrap script.
3. **GitHub secrets:** repo → Settings → Secrets and variables → Actions → New repository secret:
   - `DEPLOY_HOST`: the server's public IP
   - `DEPLOY_SSH_KEY`: the full contents of the downloaded private key file
   - `OWNER_EMAIL`: the only email allowed to sign up
   - `OPENAI_API_KEY`: optional now, needed from release 2
4. **Deploy:** Actions → **Deploy** → *Run workflow*. After that, every push to `main` that
   passes CI deploys itself.
5. Open `https://<server-ip>.sslip.io` (free HTTPS, no domain needed) and sign up with `OWNER_EMAIL`.

Notes:
- Secrets (`APP_ENCRYPTION_KEY`, the DB password) are **generated on the server** in `deploy/.env`
  and never leave it. Keep a copy: `ssh ubuntu@<ip> cat ~/careerflow/deploy/.env`.
- Forgot your password and email isn't set up? `ssh ubuntu@<ip> ~/careerflow/deploy/admin.sh reset-password <email>`
  prints a one-time link.
- Backups: nightly `pg_dump` into the `backups` volume (14 kept).
- Logs: `cd ~/careerflow/deploy && docker compose logs -f web worker`.
- Rollback: re-run the Deploy workflow on an earlier commit.

### Alternative: Vercel + Railway + Neon

The same code runs on managed services: Vercel for `apps/web` (Root Directory `apps/web`),
Railway for the worker (`railway.json`), and Neon for Postgres. Set the variables from
`.env.example` on each one.

## Tested vs. not tested (release 1)

**Tested here, automatically:**
- 36 unit and integration tests against real PostgreSQL 16, covering: encryption and tamper
  detection, key rotation, password hashing, signup, login, lockout, sessions, the full
  password-reset flow, password change, profile encryption at rest, date validation,
  verification of numeric facts, the saved-answer employer → global precedence, sensitive-question
  classification, inbox dedupe and resume-on-answer, cross-user isolation (answers, experience,
  documents), concurrent queue claiming (30 workers, 20 tasks, no duplicates), retry/backoff,
  irreversible-step blocking, stale-worker reclaim with checkpoint resume, lease fencing,
  scheduler single-fire under concurrency, atomic quotas (12 parallel attempts at a limit of 5),
  and the upload type check and integrity check.
- Migrations apply to an empty database, and running them again is a no-op.
- Production `next build`, then an 11-step real-Chrome walkthrough against the running app and
  worker: sign up → personal details → preferences → experience → numeric highlight verified
  with its meaning → CV upload and download → sensitive saved answer flagged → Home shows live
  data and the worker online → settings reject limits above the pilot ceiling → sign out,
  redirect, wrong password, sign in → a second user gets 404 on the first user's CV.

**Not tested yet:**
- A live deployment. The Docker image build and the compose file are checked in CI. The
  bootstrap script and the Oracle setup are run for the first time on your server.
- Sending a real email through Resend (unit tests cover the reset logic; delivery is untested).
- Anything from later releases: discovery, OpenAI decisions, CV generation, ATS automation, Gmail.

## Roadmap

| Release | Scope |
|---|---|
| **1 · Foundation** ✅ | Schema, auth, profile, verified facts, saved answers, inbox, documents, durable worker, CI |
| 2 · Intelligence | Discovery adapters (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, career sites); OpenAI supervisor and matching with explainable scores; decision trace with cost, latency and tokens; Fresh Discovery / Reindex |
| 3 · Documents | AI CV extraction → user confirmation; tailored ATS-friendly PDF CVs and cover letters built only from verified facts; diff against the original |
| 4 · Application automation | Playwright ATS adapters, form reasoning, upload checks, approval previews tied to a content hash, safe submission and evidence capture |
| 5 · Tracking | Gmail OAuth (read-only), receipt and interview classification, one email ↔ one application matching |
| 6 · Reliability | Recovery agent, Sentry and tracing, root-cause grouping, in-app assistant |
| 7 · Pilot | Supervised real-world pilot, then opt-in autopilot |
