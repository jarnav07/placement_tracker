# Placement Tracker

A personal board for finding, ranking, verifying and tracking student placements for the
**2027–28 intake**, aimed at aerospace, space, Formula 1/motorsport and adjacent engineering.

React + TypeScript + Vite on the front, Supabase (Postgres) underneath, and a daily GitHub
Actions job that re-researches every tracked role with Azure OpenAI.

---

## What the project is for

Three jobs, in order of importance:

1. **Know what is actually open.** A student placement cycle turns over fast, and a role that
   says "Open Now" when it is not costs a wasted afternoon. Every status must be backed by
   evidence about *the exact role, for the 2027 intake*.
2. **Rank hundreds of roles honestly.** With ~380 tracked rows, the board is only useful if
   the best-matching role is at the top and the ranking is explainable.
3. **Track applications** without automation ever trampling what the user wrote.

Everything in the codebase serves one of those three.

---

## Architecture

```text
                       ┌─────────────────────────────┐
   GitHub Actions      │  placement-maintenance.yml  │  16:00 Europe/London, daily
   (16:00 UK)          └──────────────┬──────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
        placement-discovery.mjs                azure-placement-audit.mjs
        crawls tracked careers pages           re-researches every tracked role
        role-quality.mjs gates candidates      Azure OpenAI + web search
        placement-verifier.mjs verifies        writes RESEARCHED columns only
                    │                                   │
                    └─────────────────┬─────────────────┘
                                      ▼
                            public.placements
                       (trigger derives the ranking)
                                      │
                     Supabase REST + Realtime │
                                      ▼
                        React app (desktop + mobile)
```

### Files that matter

| Path | Role |
| --- | --- |
| `src/lib/supabase.ts` | Client, the `Placement` type, and the **column-ownership rules** |
| `src/lib/ranking.ts` | TypeScript mirror of the Postgres ranking |
| `src/lib/filtering.ts` | Views, filters, sorting, sector/region normalisation |
| `src/lib/excel.ts` | Excel export |
| `src/App.tsx` | State, realtime, the single write path, desktop + mobile shells |
| `src/components/PlacementCard.tsx` | Board card — **one card per role** |
| `src/components/PlacementDetail.tsx` | Full record; the only editable surface |
| `src/components/MobilePlacementCard.tsx` | Mobile row with swipe actions |
| `scripts/role-quality.mjs` | The shared "is this actually a vacancy?" rule |
| `scripts/azure-placement-audit.mjs` | The scheduled verifier |
| `scripts/placement-discovery.mjs` | Deterministic crawl for new roles |
| `scripts/check-invariants.mjs` | `npm run check` — guards the rules below |
| `supabase/migrations/` | Schema, ranking functions, constraints |

---

## Column ownership

This is the rule the project keeps breaking, so it is stated once and enforced by
`npm run check`:

| Class | Columns | Who writes them |
| --- | --- | --- |
| **Identity** | `company`, `specific_role` | Set once at insert. The audit must never rewrite them — a hallucinated rename destroys the row. |
| **Derived** | `priority_score`, `overall_priority` | A Postgres trigger, on every insert and update. Nothing else. |
| **User-owned** | `app_status`, `date_applied`, `cv_version`, `cover_letter_required`, `referral_contact`, `interview_date`, `notes`, `not_interested`, `archived` | Only the browser. Automation must never touch them. |
| **Researched** | everything else | The audit, and only when it actually established a value. |

The browser can only send user-owned columns: `PlacementPatch` is typed as
`Partial<Pick<Placement, UserEditableField>>`, and `App.tsx` has a single writer.

---

## Ranking

Every role gets a `priority_score` from 0 to 100 and a priority band derived from it. Both
are computed by `placements_apply_ranking()` in Postgres, so a role is never unranked and no
agent can invent a new priority vocabulary.

```text
weighted fit (0–80) = 8 × ( 0.45 × cv_fit
                          + 0.30 × best domain match
                          + 0.15 × career_value
                          + 0.10 × prestige )

availability bonus  = Open Now +18 · Opening Soon +10 · Expected +4 · Closed −40
opportunity bonus   = Industrial Placement +8 · Internship/Co-op +2
                    · Spring Week 0 · Other Student Programme −10

priority_score      = clamp(sum, 0, 100)
```

**Best domain match** is the *maximum* of the six relevance scores, not their average: a pure
F1 aerodynamics role must not be pushed down the board for scoring zero on rocket/space.

Bands:

| Band | Condition |
| --- | --- |
| `APPLY_IMMEDIATELY` | score ≥ 75 **and** Open Now |
| `APPLY_WHEN_OPENING` | score ≥ 58 **and** Opening Soon / Expected |
| `HIGH_PRIORITY_WATCH` | score ≥ 58 |
| `GOOD_BACKUP` | score ≥ 42 |
| `LOW_PRIORITY` | otherwise, and always when Closed |

`src/lib/ranking.ts` mirrors this so the card can show **why** a role ranks where it does.
`npm run check` fails if the two implementations drift apart.

---

## Status semantics

| Status | Meaning |
| --- | --- |
| `Open Now` | The exact 2027 role is accepting applications today, with a confirmed application route. |
| `Opening Soon` | 2027 intake confirmed, published opening date not yet reached. |
| `Expected` | 2027 intake confirmed, no opening details published. |
| `Not Yet Published` | The programme exists; its 2027 intake is not published. |
| `Closed` | The exact 2027 intake has closed, filled or passed its deadline. |
| `Unknown` | Evidence insufficient or contradictory. |

Two rules the audit enforces mechanically:

- **A closed 2026 intake never closes the 2027 intake.**
- **`Open Now` and `Closed` are gated.** They are only written at ≥ 80 % confidence with the
  exact role found, the 2027 intake confirmed, an official source, and a real application
  link. Anything weaker becomes `Unknown`.
- An unresolved run **does not** overwrite a stable status (`Expected`, `Not Yet Published`,
  `Opening Soon`), but it **does** clear a stale `Open Now` or `Closed` — those make the user
  act, so leaving one standing without evidence is worse than admitting uncertainty.

---

## Views

| View | Shows |
| --- | --- |
| Opportunities | Everything not archived and not marked Not Interested |
| My applications | Anything with a stage past *Not Applied* |
| Not interested | Roles the user rejected — hidden, never deleted |
| Archived | Links the crawler mistook for vacancies — hidden, never deleted, restorable |

**No view collapses roles by company.** One company can run several distinct placements and
each carries its own fit, deadline and rank.

---

## Discovery

`placement-discovery.mjs` crawls careers pages already present in the tracker and extracts
candidate links. A candidate must pass `looksLikeStudentRole()` in `scripts/role-quality.mjs`
on the strength of **its own label and URL** — not the page it was found on. That distinction
matters: every careers page contains the word "internship" somewhere, so testing the page
text let product pages ("Propulsion systems"), navigation links ("View all placements") and
blog posts ("Why be an engineer at Babcock?") into the database as if they were vacancies.

The same rule backs the `archived` flag, so the crawler and the database agree on what a role is.

Candidates are then verified, and only inserted with a confirmed 2027 intake, an exact role
match and a usable link. Discovery never deletes a row and never re-creates a Not Interested one.

---

## Getting started

```bash
npm install
cp .env.example .env      # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check and build for production |
| `npm run preview` | Serve the production build |
| `npm run check` | Verify the invariants above (offline, no credentials) |
| `npm run discover` | Crawl tracked careers pages for new 2027 roles |
| `npm run audit:azure` | Re-verify and enrich every tracked role (scheduled job) |
| `npm run audit` | Deterministic, no-AI availability check |
| `npm run monitor` | Read-only report of tracked links that no longer resolve |

### Database

Apply `supabase/migrations/` in order. The current schema is defined by:

- `20260811130410_create_placements_table.sql` — the original table
- `20260813100000_add_not_interested.sql`
- `20260818000000_create_placements_backup.sql`
- `20260901120000_add_opportunity_type_for_spring_weeks.sql`
- `20260905120000_schema_cleanup_and_ranking.sql` — **the current shape**: removes ten
  redundant columns, adds `work_eligibility` / `priority_score` / `archived`, normalises every
  vocabulary, installs the ranking trigger and the CHECK constraints

---

## Scheduled maintenance

`.github/workflows/placement-maintenance.yml` runs at **16:00 Europe/London** every day.
GitHub cron is UTC-only, so it fires at 15:00 and 16:00 UTC and a gate job keeps whichever
invocation is 16:00 in London. **Manual runs are never gated** — `workflow_dispatch` always
proceeds, and takes inputs:

| Input | Purpose |
| --- | --- |
| `steps` | `discover-and-audit` (default), `audit-only`, `discover-only` |
| `limit` | Verify at most N roles, least recently verified first |
| `only_stale_days` | Only verify roles not checked in the last N days |
| `include_not_interested` | Also verify rejected roles |

The audit skips archived rows and (by default) Not Interested rows, retries Azure on 429/5xx
with backoff, records a failure in `source_verified` while leaving the row's data intact, and
fails the job only when more than a quarter of verifications fail — which means credentials
or the deployment name are wrong, not that a few sites timed out.

### Required secrets

| Secret | Used by |
| --- | --- |
| `SUPABASE_URL` (or `VITE_SUPABASE_URL`) | discovery + audit |
| `SUPABASE_SERVICE_ROLE_KEY` | discovery + audit |
| `AZURE_OPENAI_ENDPOINT` | audit |
| `AZURE_OPENAI_API_KEY` | audit |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | audit (e.g. `gpt-4.1-mini`) |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | the Pages build |

The workflow fails fast with a named list if any are missing.

---

## Deployment

`.github/workflows/deploy-pages.yml` builds and publishes to GitHub Pages on every push to
`main`. `.github/workflows/ci.yml` runs `npm run check` and `npm run build` on pushes and
pull requests.

---

## Security

- Never commit `.env`. Only `VITE_*` variables reach the browser, and they must be the
  anon/publishable key.
- `SUPABASE_SERVICE_ROLE_KEY` and `AZURE_OPENAI_API_KEY` belong in GitHub Actions secrets only.
- `public.placements` has RLS enabled with permissive single-tenant policies.

> **Backup snapshots.** The `create_placements_backup` RPC has produced 27
> `placements_backup_*` tables (~18 MB). Those created from 2026-08-20 onward had **RLS
> disabled**, meaning anyone with the public anon key could read or modify a full copy of the
> tracker. `20260905130000_harden_placements_backup.sql` fixes this: every future snapshot is
> created with RLS enabled and anon/authenticated privileges revoked, and the same has been
> applied to the existing ones. They are now reachable only by the service role.
>
> The snapshots themselves are kept — they are backups, and dropping them is your call:
>
> ```sql
> SELECT tablename,
>        pg_size_pretty(pg_total_relation_size(format('public.%I', tablename))) AS size
> FROM pg_tables
> WHERE schemaname = 'public' AND tablename LIKE 'placements_backup%'
> ORDER BY tablename;
>
> DROP TABLE public.placements_backup_2026_08_20_09_18_46;   -- one at a time, deliberately
> ```
