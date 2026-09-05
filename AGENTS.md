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

`public.placements`, 53 columns. The current shape is set by
`supabase/migrations/20260905120000_schema_cleanup_and_ranking.sql`.

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

The scheduled verifier is `scripts/azure-placement-audit.mjs` (Azure OpenAI + web search).
`scripts/placement-verifier.mjs` is the deterministic path used by discovery and by
`npm run audit`; it is not the scheduled verifier.

Evidence hierarchy, strongest first:

1. the employer's current exact vacancy page
2. the employer's student/placement programme page
3. the employer's ATS listing (Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Taleo…)
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
- **`Open Now` and `Closed` are gated**: ≥ 80 % confidence, exact role found, 2027 intake
  confirmed, official source, and a real application link. Anything weaker → `Unknown`.
- **A verification failure changes nothing.** Record it in `source_verified` and leave the
  researched values alone. Do not stamp `Unknown` because an API call timed out.
- An unresolved run may clear a stale `Open Now` or `Closed`, but must not clear a stable
  `Expected` / `Not Yet Published` / `Opening Soon`.

Student opportunities only. Graduate schemes, experienced-hire vacancies, non-degree
apprenticeships and short summer internships that are not the placement year do not qualify.

---

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
| `.github/workflows/placement-maintenance.yml` | 16:00 Europe/London daily, plus manual | Discovery, then the Azure audit |
| `.github/workflows/deploy-pages.yml` | push to `main`, manual | Build and publish to GitHub Pages |
| `.github/workflows/ci.yml` | push, pull request | `npm run check` and `npm run build` |

The maintenance schedule fires at 15:00 and 16:00 UTC and a `gate` job keeps whichever is
16:00 in London. **The gate applies to `schedule` only** — a manual run always proceeds. (The
previous version gated manual runs too, so `workflow_dispatch` silently did nothing unless it
happened to be started at exactly 4 PM UK.)

Do not casually change the schedule, concurrency (`cancel-in-progress: false` is deliberate)
or timeout.

Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AZURE_OPENAI_ENDPOINT`,
`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT_NAME`, and `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` for the Pages build. Never put a service-role or Azure key in `src/`
or any `VITE_*` variable. If one is missing, name it — never print its value.

---

## 8. Frontend

Desktop and mobile are separate presentations over shared logic. Both render the same
`PlacementDetail`.

- `src/App.tsx` — state, realtime, and the **single write path** (`patchPlacement`)
- `src/lib/filtering.ts` — views, filters, sorting, sector/region derivation
- `src/lib/ranking.ts` — TypeScript mirror of the Postgres ranking
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
