# AGENTS.md — Placement Tracker

Operating manual for coding agents. Read it before changing the repository, the database,
the UI or the automation.

**Repository:** `jarnav07/placement_tracker` · **Default branch:** `main`
Always work in the `jarnav07` account. Do not substitute a fork or an older copy.

---

## 1. What this project is

A personal board for the **2027–28 student placement intake**, focused on aerospace, space,
Formula 1/motorsport, aerodynamics/CFD, propulsion and controls/avionics.

It has to do three things well, in this order:

1. **Report availability truthfully.** A wrong "Open Now" wastes the user's time; a wrong
   "Closed" loses them a role. Status needs evidence about the *exact role, 2027 intake*.
2. **Rank every role honestly and explainably.**
3. **Never damage the user's own data.**

`README.md` documents the system. This file documents how to work on it.

---

## 2. Standing facts about the user

- UK passport holder, undergraduate engineering student.
- **UK right-to-work is not a blocker for UK roles.** Do not flag it as one.
- For non-UK roles, and especially US roles, UK-citizen eligibility must be *verified*:
  sponsorship, US-person requirements, ITAR/EAR export controls, security clearance. Silence
  is not evidence of eligibility.
- Target intake year: **2027**.

(These belong here, in the agent instructions. An earlier agent copied the same profile note
onto 177 individual `notes` rows, which destroyed the user's own notes. Do not do that.)

---

## 3. Column ownership — the rule that keeps getting broken

| Class | Columns | Who may write |
| --- | --- | --- |
| **Identity** | `company`, `specific_role` | Set at insert only. Never rewritten by the audit. |
| **Derived** | `priority_score`, `overall_priority` | The `placements_ranking` trigger. Nothing else, ever. |
| **Derived** | `opened_at` | The `placements_opening` trigger. Writing it by hand fakes a role being new. |
| **User-owned** | `app_status`, `date_applied`, `cv_version`, `cover_letter_required`, `referral_contact`, `interview_date`, `notes`, `not_interested`, `archived` | The browser only. |
| **Researched** | everything else | The audit, only when it established a value. |

`npm run check` enforces all four rows. If you add a column, put it in a class first.

Historic failures this table exists to prevent:

- The audit wrote verification prose into `notes` and `cover_letter_required` — 179 rows of
  the user's own field, gone.
- Four agents wrote `overall_priority` in four different vocabularies (`HIGH_PRIORITY`,
  `VERY_HIGH_PRIORITY`, `Very High`, `High`), none of which the UI understood, so 86 rows
  rendered with a blank priority badge and matched no filter.
- The audit rewrote `company` and `specific_role` from model output on every run.

---

## 4. Database

`public.placements`, 54 columns. The current shape is set by
`supabase/migrations/20260907120000_opening_automation_and_deadline_priority.sql`
(on top of `20260905120000_schema_cleanup_and_ranking.sql`).

**Inspect the live schema before changing it.** The TypeScript interface is a mirror, not the
source of truth.

### Never, during ordinary work

- `DELETE FROM public.placements` / `TRUNCATE` / bulk table replacement.
- Deleting a row because it is closed, obsolete, duplicated, Not Interested or looks like junk.
  Use `not_interested` (user rejected it) or `archived` (not really a vacancy) instead — both
  hide the row and both are reversible from the UI.
- Writing a column outside the class you are allowed to write.
- Dropping a column without first folding its data into the column that replaces it.

### Always

1. Read the affected rows first, and record the row count.
2. Identify rows by `id`.
3. Update only fields the evidence supports.
4. Re-check the row count afterwards and report what changed.

### Vocabularies (CHECK-constrained — an off-list value is rejected)

- `application_status`: `Open Now` · `Opening Soon` · `Expected` · `Not Yet Published` · `Closed` · `Unknown`
- `opportunity_type`: `Industrial Placement` · `Spring Week / Insight` · `Internship / Co-op` · `Other Student Programme`
- `app_status`: `Not Applied` · `Saved` · `Applied` · `Assessment` · `Interview` · `Final Interview` · `Offer` · `Accepted` · `Rejected` · `Withdrawn`
- `deadline_type`: `Rolling` · `Fixed` · `Vacancy dependent` · `TBC`
- `overall_priority`: `APPLY_IMMEDIATELY` · `APPLY_WHEN_OPENING` · `HIGH_PRIORITY_WATCH` · `GOOD_BACKUP` · `LOW_PRIORITY` — **derived, never written**

Frontend groupings are derived from the raw columns, not stored:
sectors `Aerospace & Space` · `Defence` · `Motorsport` · `Engineering & Technology` ·
`Research & Advanced Tech`; regions `UK` · `Europe` · `America` · `Asia` · `Oceania`.

---

## 5. Verification rules

The scheduled pass is `scripts/placement-verification.mjs`. It has three stages and there is
**exactly one implementation of each** — `scripts/placement-verifier.mjs` (used by discovery
and `npm run audit`) is a thin adapter over the same modules, not a second copy.

| Stage | Module | What it is |
| --- | --- | --- |
| 1. Deterministic | `scripts/verify/evidence.mjs` | Fetches the tracked pages and queries the employer's applicant tracking system for the exact role. Cannot hallucinate. |
| 2. Primary | `scripts/verify/gemini.mjs` | Gemini, grounded with Google Search and URL context, reasoning over stage 1's evidence. |
| 3. Secondary | `scripts/verify/azure.mjs` | Azure OpenAI, asked independently when the decision is consequential, contested or low-confidence. |
| Gate | `scripts/verify/record.mjs` | Combines the three into a status. |

Evidence hierarchy, strongest first:

1. the employer's applicant tracking system listing the exact role live (stage 1 — decisive)
2. the employer's current exact vacancy page
3. the employer's student/placement programme page
4. the employer's careers page with an explicit intake or opening statement
5. a reputable aggregator (Gradcracker, Trackr)
6. search snippets, social posts, forums

A weaker source must not overwrite a stronger, current, verified value.

Hard rules:

- **A closed 2026 intake is never evidence that the 2027 intake is closed.**
- **The application opening date is not the placement start date.** A September 2027 start
  does not mean applications open in September 2026.
- **A reachable page proves nothing.** Neither does a generic careers page, an "Apply" button
  with no destination, or a stale board hit.
- **A missing intake year is NOT a contradiction.** Do not re-add a requirement that a posting
  print "2027". Most postings never do; the previous gate demanded it, so ordinary open
  placements failed, the answer was discarded, and rows sat at `Not Yet Published`
  indefinitely. `npm run check` now fails if that requirement comes back.
- **A live ATS listing of the exact student role opens it**, on its own, even with no printed
  year. Employers take listings down when a cycle closes.
- **`Closed` needs corroboration**: a fully enumerated job board that does not list the role,
  or both providers agreeing. A wrong `Closed` costs the user the placement.
- **An inconclusive run asserts nothing.** The row keeps its stored status. `Unknown` is
  written only to clear a standing `Open Now` / `Closed` that today's evidence cannot
  reproduce. Do not go back to stamping `Unknown` on every unresolved row — that is what made
  every result invisible.
- **A verification failure changes nothing.** Record it in `source_verified` and leave the
  researched values alone. Do not stamp `Unknown` because an API call timed out.

Student opportunities only. Graduate schemes, experienced-hire vacancies, non-degree
apprenticeships and short summer internships that are not the placement year do not qualify.

### Dates and automatic opening

`exact_opening_date` and `exact_deadline` are free text, but they now drive automation, so
**never write prose into them**. `scripts/verify/dates.mjs` and the SQL functions
`placement_parse_date()` / `placement_date_precision()` are mirrors of each other; change both
or neither.

`scripts/apply-scheduled-openings.mjs` sets a placement to `Open Now` on the day its employer
published as the opening day. It only ever acts on a **day-precision** date. "November 2026" is
not a promise that applications open on 1 November — month and season dates only make the row
due for re-verification. Do not loosen that.

## 6. Discovery

`scripts/placement-discovery.mjs` crawls careers pages already in the tracker.

The candidate gate is `looksLikeStudentRole()` in `scripts/role-quality.mjs`, and it judges
**the link's own label and URL** — never the text of the page it was found on. The previous
version tested whole-page text, which always passed (every careers page says "internship"
somewhere), so the crawler inserted product pages, navigation links and blog posts as
vacancies: 122 of 378 rows.

If you loosen that gate, add the new accept/reject cases to `scripts/check-invariants.mjs`
first and watch them fail before you make them pass.

Do not remove the source-page, candidate, concurrency or delay limits without a reason.

---

## 7. Automation

| Workflow | Trigger | Does |
| --- | --- | --- |
| `.github/workflows/placement-maintenance.yml` | 16:00 Europe/London daily, plus manual | Discovery, verification, then scheduled openings |
| `.github/workflows/placement-maintenance.yml` | 07:00 and 12:00 Europe/London | Scheduled openings only (no AI provider, no crawl) |
| `.github/workflows/deploy-pages.yml` | push to `main`, manual | Build and publish to GitHub Pages |
| `.github/workflows/ci.yml` | push, pull request | `npm run check` and `npm run build` |

Each London time fires at both its GMT and its BST hour, and the `gate` job keeps whichever is
the real London time and decides which mode to run. **The gate applies to `schedule` only** —
a manual run always proceeds. (An earlier version gated manual runs too, so
`workflow_dispatch` silently did nothing unless it happened to be started at exactly 4 PM UK.)

Do not casually change the schedule, concurrency (`cancel-in-progress: false` is deliberate)
or timeout.

Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` (primary verifier),
`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT_NAME` (secondary
verifier), and `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` for the Pages build. Optional
repository *variable* `GEMINI_MODEL` pins the Gemini model; unset, the verifier picks the
strongest model the key can reach from the API's model list.

Never put a service-role, Gemini or Azure key in `src/` or any `VITE_*` variable. If one is
missing, name it — never print its value.

---

## 8. Frontend

Desktop and mobile are separate presentations over shared logic. Both render the same
`PlacementDetail`.

- `src/App.tsx` — state, realtime, and the **single write path** (`patchPlacement`)
- `src/lib/filtering.ts` — views, filters, sorting, sector/region derivation
- `src/lib/ranking.ts` — TypeScript mirror of the Postgres ranking, plus the "newly opened"
  rule. The score depends on today's date (the deadline term), so the browser recomputes it
  live; `priority_score` in Postgres remains the server-side ordering key.
- `src/components/` — cards, detail panel, filter controls, shared primitives
- `src/index.css` — **the only place** tokens are defined; no other file declares `:root`

Rules:

- **One card per role, never per company.** A company running four placements gets four
  cards. A previous version de-duplicated by company and hid 270 of 378 roles; `npm run check`
  now fails if that logic comes back.
- Do not duplicate filtering or ranking logic inside a component.
- Do not add an editor for a researched column — the next audit would overwrite it.
- Do not replace a mobile interaction with a desktop one. Preserve the swipe gestures, the
  bottom tab bar and the safe-area insets.
- Check both presentations after a UI change.

---

## 9. Before you say you are done

1. `npm run check` passes.
2. `npm run build` passes.
3. You have read your own diff.
4. Any database change was targeted, non-destructive, and the row count is unchanged (or the
   change is explained).
5. User-owned columns are untouched.
6. No secrets committed.
7. Your report says what you actually did and actually tested — not what you intended.

**When in doubt: inspect first, preserve data, prefer evidence, make the smallest change,
test it, report honestly.**
