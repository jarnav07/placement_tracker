# Placement Tracker

A personal board for finding, ranking, verifying and tracking student placements for the
**2027–28 intake**, aimed at aerospace, space, Formula 1/motorsport and adjacent engineering.

React + TypeScript + Vite on the front, Supabase (Postgres) underneath, and a GitHub Actions
job that re-researches every tracked role — deterministically first, then with Gemini as the
primary AI verifier and Azure OpenAI as an independent second opinion.

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
   GitHub Actions      │  placement-maintenance.yml  │  07:00 · 12:00 · 16:00 Europe/London
                       └──────────────┬──────────────┘
                                      │
             ┌────────────────────────┼────────────────────────┐
             ▼                        ▼                        ▼
  placement-discovery.mjs   placement-verification.mjs   apply-scheduled-openings.mjs
  crawls tracked careers    the three-stage pass below   opens a placement on the day
  pages; role-quality.mjs   (16:00 only)                 its employer said it would
  gates candidates                                       (07:00, 12:00 and 16:00)
             │                        │                        │
             └────────────────────────┼────────────────────────┘
                                      ▼
                            public.placements
              (triggers derive the ranking and stamp opened_at)
                                      │
                     Supabase REST + Realtime │
                                      ▼
                        React app (desktop + mobile)
```

### How a status is decided

Every role goes through the same three stages, in this order. There is exactly one
implementation, shared by the scheduled pass and by discovery.

```text
1. DETERMINISTIC   scripts/verify/evidence.mjs
   Fetch the tracked pages. Follow the apply link into the employer's applicant
   tracking system (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Workable,
   Recruitee, Teamtailor, Personio) and query its public listing for the EXACT role.
   Cannot hallucinate. A live listing is proof applications are open; a fully
   enumerated board without the role is proof they are not; anything else asserts
   nothing.

2. PRIMARY         scripts/verify/gemini.mjs
   Gemini, grounded with Google Search and URL context, reasoning over stage 1's
   evidence rather than rediscovering it. Research and extraction are separate calls,
   so a judgement is never compressed into a schema mid-reasoning.

3. SECONDARY       scripts/verify/azure.mjs
   Azure OpenAI, asked independently — and only when it matters: a consequential
   change (to or from Open Now / Closed), a contradiction of the job board, or a
   low-confidence primary answer.

   scripts/verify/record.mjs combines the three. The job board can carry a decision
   on its own; closing a role needs the board's silence or BOTH providers agreeing.
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
| `scripts/verify/evidence.mjs` | Deterministic pages + applicant tracking systems |
| `scripts/verify/dates.mjs` | Free-text date parsing, shared with the SQL functions |
| `scripts/verify/record.mjs` | The record schema and the status gate |
| `scripts/verify/gemini.mjs` | Primary AI verifier |
| `scripts/verify/azure.mjs` | Secondary AI verifier |
| `scripts/placement-verification.mjs` | The scheduled pass |
| `scripts/apply-scheduled-openings.mjs` | Opens a role on its published opening day |
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
| **Derived** | `priority_score`, `overall_priority`, `opened_at` | Postgres triggers, on every insert and update. Nothing else. |
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

deadline adjustment = deadline passed −25 (at any status)
                    · Open Now and closing in ≤ 7 days +14 · ≤ 14 +11
                    · ≤ 30 +8 · ≤ 60 +5 · ≤ 120 +2

priority_score      = clamp(sum, 0, 100)
```

The deadline bonuses apply only to `Open Now`: a distant deadline on a role you cannot apply
to yet is not urgency. The passed-deadline penalty applies at every status, because a card
telling you to apply to something that closed in June is worse than useless.

Because the score now depends on today's date, the browser recomputes it live from the same
formula. `priority_score` in Postgres stays the server-side ordering key and is refreshed by
the daily pass; the board never shows a day-stale countdown.

**Best domain match** is the *maximum* of the six relevance scores, not their average: a pure
F1 aerodynamics role must not be pushed down the board for scoring zero on rocket/space.

Bands:

| Band | Condition |
| --- | --- |
| `APPLY_IMMEDIATELY` | score ≥ 75 **and** Open Now — or score ≥ 55, Open Now and closing within 7 days |
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

Rules the verification pass enforces mechanically:

- **A closed 2026 intake never closes the 2027 intake.**
- **A live listing on the employer's own applicant tracking system opens the role**, on its
  own, even when the posting does not print an intake year. Most genuine postings never do,
  and employers take listings down once a cycle closes.
- **A missing intake year is not a contradiction.** It counts as consistent with 2027 unless
  the posting positively names a different year. *(The previous pipeline demanded
  `intake_year == 2027`, so ordinary postings failed the gate, the result was discarded, and
  the row sat at `Not Yet Published` indefinitely — the tracker's main false-negative source.)*
- **`Closed` needs corroboration**: either a fully enumerated job board that does not list the
  role, or both AI providers agreeing. A wrong `Closed` costs the placement entirely.
- **A published opening day is honoured.** If the employer said applications open on a given
  day, the role is marked `Open Now` on that day — see below.
- An inconclusive run **asserts nothing**: the row keeps its stored status rather than being
  stamped `Unknown`. The one exception is a standing `Open Now` or `Closed` that today's
  evidence can no longer reproduce — those make the user act, so they are cleared.

### Opening on the published day

`npm run openings` runs at 07:00, 12:00 and 16:00 UK. It needs no AI provider and no crawl.

A placement is opened when its `exact_opening_date` names a specific **calendar day** that has
arrived, its deadline has not passed, and it is not already open or closed. `"November 2026"`
is *not* a promise that applications open on 1 November, so month- and season-precision dates
never open a role — they only push it to the front of the verification queue once that month
arrives.

### The "new" mark

`opened_at` is stamped by a Postgres trigger the moment `application_status` becomes
`Open Now`. Roles carry a **New** mark on the board for 10 days after that, the stat row shows
a "Just opened" count, and `Just opened` is a sort option. Roles that were already open before
the trigger existed have no `opened_at` and correctly never show as new.

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

Candidates are then put through the same three-stage verification as everything else, and are
only inserted with an acceptable 2027 intake, an exact role match and a usable link.
"Acceptable" means the year is stated as 2027 *or* unstated with nothing contradicting it —
requiring a printed year here silently rejected real vacancies. Discovery never deletes a row
and never re-creates a Not Interested one.

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
| `npm run verify` | Re-verify and enrich every tracked role (the scheduled pass) |
| `npm run openings` | Open placements whose published opening day has arrived |
| `npm run audit` | Lightweight availability check over the same shared verifier |
| `npm run monitor` | Read-only report of tracked links that no longer resolve |

### Database

Apply `supabase/migrations/` in order. The current schema is defined by:

- `20260811130410_create_placements_table.sql` — the original table
- `20260813100000_add_not_interested.sql`
- `20260818000000_create_placements_backup.sql`
- `20260901120000_add_opportunity_type_for_spring_weeks.sql`
- `20260905120000_schema_cleanup_and_ranking.sql` — removes ten redundant columns, adds
  `work_eligibility` / `priority_score` / `archived`, normalises every vocabulary, installs the
  ranking trigger and the CHECK constraints
- `20260905130000_harden_placements_backup.sql`
- `20260907120000_opening_automation_and_deadline_priority.sql` — **the current shape**: adds
  `opened_at` and its trigger, makes the free-text date columns machine-readable (day-precision
  values become ISO, prose is cleared into `deadline_type`), and adds the deadline term to the
  ranking

---

## Scheduled maintenance

`.github/workflows/placement-maintenance.yml` runs the **full pass at 16:00 Europe/London**
every day, and the cheap **scheduled-openings pass at 07:00 and 12:00** — so a placement whose
employer published today as its opening day is flipped before the working day starts rather
than in the evening.

GitHub cron is UTC-only, so each London time fires at both its GMT and its BST hour and a gate
job keeps whichever invocation is the real London time, and decides which mode to run.
**Manual runs are never gated** — `workflow_dispatch` always
proceeds, and takes inputs:

| Input | Purpose |
| --- | --- |
| `steps` | `discover-and-verify` (default), `verify-only`, `discover-only`, `openings-only` |
| `limit` | Verify at most N roles, least recently verified first |
| `only_stale_days` | Only verify roles not checked in the last N days |
| `include_not_interested` | Also verify rejected roles |

The verification pass skips archived rows and (by default) Not Interested rows, retries both providers on 429/5xx
with backoff, records a failure in `source_verified` while leaving the row's data intact, and
fails the job only when more than a quarter of verifications fail — which means credentials
or the deployment name are wrong, not that a few sites timed out.

### Required secrets

| Secret | Used by |
| --- | --- |
| `SUPABASE_URL` (or `VITE_SUPABASE_URL`) | discovery, verification, openings |
| `SUPABASE_SERVICE_ROLE_KEY` | discovery, verification, openings |
| `GEMINI_API_KEY` | **primary verifier** — get one at <https://aistudio.google.com/apikey> |
| `AZURE_OPENAI_ENDPOINT` | secondary verifier |
| `AZURE_OPENAI_API_KEY` | secondary verifier |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | secondary verifier (e.g. `gpt-4.1-mini`) |

Optional repository **variable** (not a secret): `GEMINI_MODEL` pins the model. Leave it unset
and the verifier reads the API's own model list and picks the strongest one your key can
reach, so a model deprecation degrades instead of breaking the nightly run.

The workflow fails fast if `GEMINI_API_KEY` is missing, and warns — without failing — if the
Azure secrets are missing, since the second opinion is what allows a role to be closed.
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
- `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` and `AZURE_OPENAI_API_KEY` belong in GitHub
  Actions secrets only.
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
