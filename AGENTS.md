# AGENTS.md — Placement Tracker

## 1. Purpose and repository identity

Placement Tracker is a personal web application for finding, prioritising, verifying, and tracking university placement opportunities for the 2027–28 placement cycle.

**Canonical repository:** `jarnav07/placement_tracker`

**GitHub owner rule:** Always work in the `jarnav07` GitHub account. Do not substitute another user's repository, fork, similarly named repository, or an older project copy unless the user explicitly tells you to.

**Default branch:** `main`

The production frontend is a React/Vite application backed by Supabase. Automated placement discovery and verification are also part of the repository and are run by GitHub Actions.

This file is the primary operating manual for coding agents. Read it before making repository, database, UI, or automation changes.

---

## 2. Core agent principles

1. **Work in `jarnav07/placement_tracker`.** This is the authoritative project repository.
2. **Inspect the current repository before changing anything.** Do not rely on old conversation snippets, old commits, or assumptions when the current code can answer the question.
3. **Make focused changes.** Do not refactor or redesign unrelated functionality.
4. **Preserve existing user data.** In particular, never delete placement records merely because they are obsolete, closed, duplicated in an external source, or Not Interested.
5. **Do not invent placement facts.** Dates, status, salary, eligibility, links, locations, degree requirements, and other factual fields require evidence.
6. **Prefer primary evidence.** Employer/student-programme/ATS evidence is stronger than generic aggregators or search snippets.
7. **Never confuse application opening date with placement start date.** A placement beginning in September 2027 does not mean applications open in September 2027.
8. **Never treat an expired 2026 role as proof that the 2027 intake is closed.** Check the current employer programme and current vacancies.
9. **Never expose secrets.** Do not commit `.env` files or credentials, and never put service-role or Azure/OpenAI secrets into browser code.
10. **Do not claim a change was tested, deployed, searched, or verified unless it actually was.**
11. **Protect application-tracking data.** Role research must not overwrite the user's application progress, notes, dates, contacts, or other personal tracking information.
12. **If evidence is insufficient, preserve the existing value or use an explicitly supported unknown state rather than guessing.**
13. **Before bulk database work, establish row counts and use targeted updates.** Afterward, verify that the record count has not unexpectedly changed.
14. **When a request affects both desktop and mobile, inspect both implementations.** Do not assume the desktop implementation controls the mobile UI.
15. **After code changes, run the relevant tests/build and inspect the changed files/diff before declaring success.**

---

## 3. Current product behaviour

The app displays a placement board with:

- opportunity discovery;
- application status/opening status;
- priority classification;
- sector and geographic filters;
- search and sorting;
- application tracking;
- a separate Not Interested view;
- desktop and mobile-specific interfaces;
- Excel export;
- realtime Supabase updates.

The current sector groups in the frontend are:

- `Aerospace & Space`
- `Defence`
- `Motorsport`
- `Engineering & Technology`
- `Research & Advanced Tech`

The current geographic groups are:

- `UK`
- `Europe`
- `Asia`
- `Oceania`
- `America`

`America` includes the project's intended North/South American opportunities. **US roles are allowed in discovery only when UK citizens are eligible for the role.** This eligibility constraint is important and must be preserved in discovery/verification logic.

The main priority groups are:

- `APPLY_IMMEDIATELY` — UI label `Apply Now`
- `APPLY_WHEN_OPENING` — UI label `Prepare`
- `HIGH_PRIORITY_WATCH` — UI label `High Priority`
- `GOOD_BACKUP` — UI label `Backup`
- `LOW_PRIORITY` — UI label `Low`

Application stages are:

`Not Applied → Saved → Applied → Assessment → Interview → Final Interview → Offer → Accepted / Rejected / Withdrawn`

Not Interested is a separate organisational state. It hides a record from the normal opportunity view but does **not** delete the row.

---

## 4. Architecture

### Frontend

The project is a React 18 + TypeScript + Vite SPA.

Important files:

- `src/App.tsx` — top-level application state, data loading, realtime subscription, filtering/sorting orchestration, views, desktop/mobile composition, and placement updates.
- `src/components/PlacementCard.tsx` — desktop placement card and placement editing/tracking UI.
- `src/components/PlacementCard.css` — desktop card styling.
- `src/components/MobilePlacementCard.tsx` — mobile-specific placement card.
- `src/components/MobilePlacementCard.css` — mobile card styling.
- `src/lib/supabase.ts` — browser Supabase client and `Placement`/status types.
- `src/lib/filtering.ts` — search, filters, and sorting.
- `src/lib/utils.ts` — shared utility/priority logic.
- `src/lib/excel.ts` — Excel export.
- `src/App.css` — desktop/global app styling.
- `src/mobile.css` — mobile layout and interaction styling.
- `src/index.css` — global CSS.

### Data flow

The normal browser flow is:

```text
React App
  ↓
Supabase browser client
  ↓
public.placements
  ↓
Initial SELECT + Supabase Realtime postgres_changes
  ↓
React state
  ↓
Filtering/sorting
  ↓
Desktop or mobile placement cards
```

`App.tsx` initially selects all placement rows ordered by `created_at DESC`. It then subscribes to `public.placements` Realtime events.

Realtime behaviour currently handles:

- `INSERT` — adds the new row and briefly marks it as new;
- `UPDATE` — replaces the row and updates the selected placement if applicable;
- `DELETE` — removes the row from the local UI if a deletion occurs externally.

Do not interpret the frontend's ability to handle DELETE events as permission to delete records during normal maintenance.

---

## 5. Supabase and placement schema

The principal table is:

`public.placements`

The TypeScript model in `src/lib/supabase.ts` currently defines fields including:

```text
id
company
sector
country
city
website
careers_page
specific_role
department
engineering_area
placement_type
placement_duration
placement_start_date
placement_end_date
application_status
exact_opening_date
exact_deadline
deadline_type
date_info_verified
application_link
degree_requirements
min_grade_requirement
year_of_study_requirement
required_technical_skills
citizenship_requirement
right_to_work_requirement
security_clearance_requirement
visa_requirement
salary
salary_period
other_benefits
cv_fit
aerospace_relevance
rocket_space_relevance
f1_motorsport_relevance
aero_cfd_relevance
propulsion_relevance
controls_avionics_relevance
prestige
career_value
overall_priority
why_it_fits
potential_weaknesses
app_status
date_applied
cv_version
cover_letter_required
referral_contact
interview_date
outcome
notes
not_interested
source_url
source_type
source_date_checked
source_verified
created_at
updated_at
```

**Important:** the TypeScript interface is not a substitute for inspecting the live database schema. Before adding/updating columns, query or inspect the actual current schema.

The browser client uses:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

These are public browser-side credentials. Privileged automation uses:

- `SUPABASE_URL` or `VITE_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The service-role key must never be exposed to the frontend or committed to source control.

---

## 6. Database safety rules

Placement data is high-value project data. Database edits must be conservative.

### Never do this during ordinary maintenance

- `DELETE FROM public.placements ...`
- `TRUNCATE public.placements`
- bulk replacement of the entire table;
- destructive migrations to make a script easier;
- deletion of Not Interested rows;
- deletion of old/closed roles merely because they are no longer advertised;
- overwriting application-tracking fields during role verification.

### Prefer this

1. Read the relevant rows first.
2. Identify rows by stable primary key (`id`).
3. Update only fields supported by the evidence/request.
4. Preserve unrelated fields.
5. Preserve application tracking.
6. Verify the row count after bulk operations.
7. Report exactly what changed.

If a user asks to remove a role from the normal UI, prefer the existing `not_interested` mechanism where appropriate rather than deleting the database record.

---

## 7. Placement status semantics

The application currently uses these user-facing statuses:

- `Open Now`
- `Opening Soon`
- `Expected`
- `Not Yet Published`
- `Closed`
- `Unknown` may be used by verification logic when evidence is insufficient.

### Open Now

Use only when the relevant student placement for the target intake is currently accepting applications and the evidence supports the exact role/application route.

### Opening Soon

Use when the employer has explicitly indicated when the relevant 2027 application window will open, but it is not open yet.

### Expected

Use when the employer has a relevant student placement programme/intake, especially where a recurring cycle is established, but the 2027 opening information is not sufficiently published for `Opening Soon`.

### Not Yet Published

Use when the student programme exists but the relevant 2027 intake/application information has not been published sufficiently to determine an opening window.

### Closed

Use only when credible evidence establishes that the relevant tracked 2027 role/intake has closed, expired, been withdrawn, filled, or passed its application deadline.

### Unknown

Use when reasonable research leaves the state genuinely uncertain or contradictory.

**Critical anti-error rule:** a generic careers page, a generic `Apply` button, a stale job-board result, or an expired 2026 vacancy is not enough to mark an exact 2027 student placement `Open Now` or `Closed`.

---

## 8. Placement discovery workflow

The current scheduled workflow runs:

```text
4:00 PM Europe/London every day
        ↓
placement-maintenance.yml
        ↓
npm run discover
        ↓
placement-discovery.mjs
        ↓
existing tracked employer career/source pages
        ↓
candidate student-role links
        ↓
placement-verifier.mjs
        ↓
new qualifying rows only
```

`npm run discover` is the `scripts/placement-discovery.mjs` entry point.

Discovery is deliberately conservative. It starts from career/source URLs already represented in the tracker rather than blindly generating arbitrary companies. It builds an existing-role index and avoids inserting existing or Not Interested roles.

The script contains limits for source pages, candidates, concurrency, and delays. Do not remove these safeguards without a clear reason.

Discovery must only add **new qualifying 2027-start student opportunities**.

A qualifying opportunity generally includes:

- industrial placement;
- year-in-industry placement;
- undergraduate placement;
- student placement;
- co-op/equivalent student work placement;
- long internship that genuinely represents the placement year.

Do not treat the following as equivalent automatically:

- graduate schemes;
- graduate jobs;
- experienced-hire positions;
- apprenticeships;
- summer-only internships that do not satisfy the placement-year requirement.

### US eligibility rule

US opportunities may be discovered, but **only if UK citizens are eligible to apply/work for the opportunity** according to the role/programme evidence.

Do not infer UK eligibility merely because a role is visible to international applicants. Look for explicit citizenship, work-authorisation, visa, export-control, security-clearance, or programme eligibility requirements. If the evidence does not establish UK-citizen eligibility, the role should not be added as an eligible US placement.

---

## 9. Current Azure verification workflow

The current daily maintenance workflow intentionally uses **Azure OpenAI for the verification stage** rather than relying on the older deterministic verification system as the final verifier.

The scheduled workflow is:

```text
GitHub Actions
  ↓
4 PM Europe/London daily
  ↓
npm run discover
  ↓
npm run audit:azure
  ↓
Azure OpenAI web-search verification
  ↓
Supabase updates
```

The workflow file is:

`.github/workflows/placement-maintenance.yml`

It triggers at both `15:00 UTC` and `16:00 UTC` and runs only the invocation whose `Europe/London` local time is exactly `16:00`. This handles UK daylight-saving transitions while retaining a 4 PM UK execution time.

The workflow also supports `workflow_dispatch` for manual runs.

It uses Node.js 22 and `npm ci`.

### Azure environment variables/secrets

The workflow provides:

- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_DEPLOYMENT_NAME`

It also provides:

- `SUPABASE_URL` (falling back to `VITE_SUPABASE_URL`)
- `SUPABASE_SERVICE_ROLE_KEY`

The Azure verifier is implemented in:

`scripts/azure-placement-audit.mjs`

The script uses Azure OpenAI's Responses API and a `web_search` tool. It asks the model to independently research each tracked 2027 student placement and return a strict structured result.

The current design intentionally bypasses deterministic verification for the **final scheduled verification decision**. Do not reintroduce deterministic verification as a hidden gate unless the user explicitly requests that architecture.

The script still contains defensive validation around the Azure response. In particular, `OPEN_NOW` is only accepted when the result meets the required evidence/confidence conditions, including confirmation of the 2027 intake, student programme, exact role, direct exact-role application, official programme source, and a verified application URL.

### Azure verification must distinguish

- exact role vs generic careers page;
- student programme vs graduate programme;
- 2027 intake vs 2026 intake;
- application opening date vs placement start date;
- direct application URL vs generic Apply/Search Jobs button;
- UK eligibility for US roles;
- current role availability vs stale search results.

The verifier can consult secondary sources such as Gradcracker/Trackr for discovery/corroboration, but official employer evidence should be preferred for final decisions.

---

## 10. Verification research methodology

For an individual role, use this order of reasoning:

1. Read the current database row completely.
2. Identify the exact company, role, programme, location, and target intake.
3. Check the employer's official student/early-careers programme.
4. Search the exact role title and company.
5. Search the employer's current vacancy/ATS system.
6. Check sensible title/location variants.
7. Check application opening dates and deadlines separately from placement start dates.
8. Confirm the role is actually a student placement.
9. For US roles, confirm UK-citizen eligibility.
10. Verify the application URL.
11. Record evidence and sources.
12. Update only evidence-supported fields.
13. Preserve application-tracking fields.

Useful ATS platforms to check where relevant include SmartRecruiters, Workday, Greenhouse, Lever, Taleo, SuccessFactors, Jobvite, and similar employer-hosted systems.

### Evidence hierarchy

Strongest to weakest:

1. current official employer exact vacancy;
2. official employer student/placement programme page;
3. official employer ATS listing;
4. official employer careers page with explicit intake/opening information;
5. reputable secondary listing such as Gradcracker/Trackr;
6. search-engine snippets/social posts/forums.

A weaker source should not overwrite a stronger, current verified value without justification.

---

## 11. Automation files

The current repository contains several historical/current scripts. Do not assume that every script is scheduled.

Important scripts include:

- `scripts/placement-discovery.mjs` — discovers new 2027 student placement links from existing source pages.
- `scripts/azure-placement-audit.mjs` — current Azure-only daily verification/audit logic.
- `scripts/placement-verifier.mjs` — older/shared deterministic verification implementation used by discovery and retained in the repository for compatibility/history. It is **not** the final verifier in the current scheduled daily audit architecture.
- `scripts/reliable-role-verification.mjs` — retained verification utility; do not assume it is scheduled or authoritative without inspecting the current workflow.
- `scripts/role-monitor.mjs` — legacy/utility role-monitor script; do not assume it is scheduled.
- `scripts/placement-audit.mjs` — legacy/general audit utility; do not assume it is the current scheduled audit.
- `scripts/job-discovery.mjs` — job-discovery utility.
- `scripts/gradcracker-discovery.mjs` — Gradcracker discovery utility.
- `scripts/repair-career-links.mjs` and `scripts/repair-career-links-v2.mjs` — career-link repair utilities.
- `scripts/verify-tracking-features.mjs` and `scripts/verify-tracking-features-v2.mjs` — application-tracking verification scripts.
- `scripts/ai-role-status.mjs` — small AI role-status utility.
- `scripts/remove-initial-companies.mjs` — historical/maintenance utility; never run destructively without inspecting its current behaviour and obtaining explicit permission if records may be removed.

**Workflow files, not script names, determine what is actually scheduled.** Always inspect `.github/workflows/` before claiming an automation is active.

---

## 12. Current GitHub Actions

The current workflow directory contains:

- `.github/workflows/deploy-pages.yml`
- `.github/workflows/placement-maintenance.yml`

### Deployment

`deploy-pages.yml` builds and deploys the frontend to GitHub Pages.

The intended production flow is:

```text
push to main
  ↓
GitHub Actions
  ↓
npm ci
  ↓
npm run build
  ↓
Vite dist output
  ↓
GitHub Pages deployment
```

### Placement maintenance

`placement-maintenance.yml` performs the daily 4 PM UK maintenance process described above.

Its concurrency group is `placement-maintenance` and `cancel-in-progress: false`. This is intentional: an in-progress placement maintenance run should not be cancelled midway and leave the database partially updated.

The job timeout is intentionally long enough for web research across the tracked roles.

Do not casually change the schedule, concurrency, or timeout.

---

## 13. Frontend details

`src/App.tsx` maintains the main state:

- placements;
- loading/error state;
- priority filter;
- sector filter;
- country filter;
- application-status filter;
- application-stage filter;
- search;
- sort option;
- current view;
- new-role highlighting;
- realtime connection state;
- mobile filters/search;
- selected placement.

Views are:

- `opportunities`
- `applications`
- `not-interested`

### Filtering/sorting

`src/lib/filtering.ts` owns filtering and sorting. The supported sort options currently exposed by the app are:

- Deadline;
- CV Fit;
- Relevance;
- A–Z/company.

When changing filters, do not duplicate filtering logic inside individual cards.

### Excel export

`src/lib/excel.ts` handles the `Download Excel` action. Do not remove fields from exports merely because they are not displayed on the card.

---

## 14. Desktop/mobile UI rules

Desktop and mobile are deliberately separate presentations sharing the same underlying data/business logic.

Desktop uses `PlacementCard`; mobile uses `MobilePlacementCard`.

When changing UI:

1. inspect the relevant desktop and mobile components;
2. inspect both CSS files where applicable;
3. preserve mobile-specific interactions;
4. preserve bottom navigation and mobile filtering/search behaviour;
5. preserve safe-area spacing for iOS/mobile layouts;
6. do not replace a mobile interaction with a desktop interaction merely because it is easier;
7. do not perform broad CSS rewrites for a small visual change;
8. test both desktop and mobile after UI changes.

The mobile card has deliberately been refined for touch interaction. If changing swipe/drag behaviour, preserve responsive pointer/touch handling and do not introduce a dead/non-responsive region in the drag path.

If an existing UI feature appears to have disappeared, compare the current code with recent commits/known-good history before designing a replacement.

---

## 15. Application tracker rules

Application tracking is a first-class product feature and must survive automated role verification.

The application status field is separate from the role's public availability status.

Public role status:

`Open Now / Opening Soon / Expected / Not Yet Published / Closed`

User application status:

`Not Applied / Saved / Applied / Assessment / Interview / Final Interview / Offer / Accepted / Rejected / Withdrawn`

Automated verification must not overwrite an active user application state merely because a role's public availability changes.

For example, if the user has applied to a role, the role being later marked `Closed` does not mean `app_status` should become `Not Applied`.

The same preservation principle applies to:

- `date_applied`;
- `cv_version`;
- `cover_letter_required`;
- `referral_contact`;
- `interview_date`;
- `outcome`;
- `notes`.

---

## 16. Not Interested rules

`not_interested` is a boolean organisational flag.

When true, the role is hidden from the normal opportunity board and shown in the Not Interested view.

**Never delete the row to implement Not Interested.**

Automated discovery must also avoid recreating a Not Interested role simply because it finds the same employer/title again.

---

## 17. Links and application buttons

One recurring failure mode is confusing a generic careers URL with an exact application URL.

A valid exact application link should point to the specific tracked role or sufficiently specific application route.

Do not treat these as exact-role evidence by themselves:

- `Careers`;
- `Search Jobs`;
- `View Jobs`;
- `Apply` without an exact destination;
- generic employer homepages;
- a secondary listing that only links to the employer homepage.

If the exact application URL cannot be verified, preserve the existing link rather than fabricating one.

When fixing missing Apply Now/Website buttons, inspect the actual card rendering and the underlying URL fields before changing the UI. A missing button may be caused by bad/missing database data rather than a component bug.

---

## 18. Environment variables and secrets

Never commit:

- `.env`;
- `.env.local`;
- Supabase service-role keys;
- Azure OpenAI API keys;
- GitHub tokens;
- other credentials.

Browser-safe variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Server/Actions-only secrets:

- `SUPABASE_SERVICE_ROLE_KEY`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_ENDPOINT` where treated as secret by the deployment environment
- `AZURE_OPENAI_DEPLOYMENT_NAME`

Never put `SUPABASE_SERVICE_ROLE_KEY` or `AZURE_OPENAI_API_KEY` in `src/` or any `VITE_*` variable.

If an environment variable is missing, report the exact variable name needed without exposing its value.

---

## 19. npm commands

`package.json` currently defines:

```text
npm run dev
npm run build
npm run preview
npm run monitor
npm run discover
npm run audit
npm run audit:azure
npm run verify-tracking-features
```

The production build is:

```text
tsc -b && vite build
```

Recommended Node.js version: **22** (the maintenance workflow uses Node 22).

For ordinary frontend changes, run:

```text
npm ci
npm run build
```

For tracking-related changes, also consider:

```text
npm run verify-tracking-features
```

For automation changes, inspect the relevant script and workflow together before testing.

---

## 20. Safe code-change workflow

Before coding:

1. Confirm the repository is `jarnav07/placement_tracker`.
2. Inspect the current `main` branch.
3. Locate the actual implementation rather than guessing the file.
4. Inspect related components, utilities, CSS, scripts, and workflows.
5. Identify data/schema dependencies.
6. Check whether the requested functionality already exists.
7. Identify unrelated behaviour that must remain unchanged.

During coding:

- make the smallest sensible change;
- keep TypeScript types accurate;
- reuse existing helpers where possible;
- avoid duplicate business rules;
- do not silently alter database semantics;
- preserve secrets and environment boundaries.

After coding:

1. run the relevant build/test command;
2. inspect changed files/diff;
3. verify no unrelated files were changed;
4. verify workflow YAML if an automation changed;
5. verify database row counts if database operations occurred;
6. only then report completion.

---

## 21. Recovery and known-good state

A known-good code recovery branch exists:

`savepoint-2026-08-18-restored-project`

Known-good commit:

`676f1d0d5190e4e5550793d427b6f13a66e67be1`

Treat that branch as a recovery reference. Do not modify or replace it unless the user explicitly asks to.

A database recovery copy was also created:

`public.placements_backup_2026_08_18`

It contained 102 placement records when created/verified.

**Git and Supabase are separate recovery layers.** Rolling back Git does not roll back Supabase data, and restoring Supabase does not roll back Git.

If a destructive or high-risk database operation is ever explicitly requested, verify an appropriate backup before proceeding.

---

## 22. Historical context that agents must not misinterpret

The repository contains older scripts from earlier iterations of the placement-monitoring system. Their presence does not mean they are currently scheduled or authoritative.

In particular:

- do not assume `role-monitor.mjs` is the current scheduled monitor;
- do not assume `placement-audit.mjs` is the current daily verifier;
- do not assume `reliable-role-verification.mjs` is the current final verification layer;
- do not reintroduce the old deterministic final-verification architecture unless explicitly requested;
- inspect `.github/workflows/placement-maintenance.yml` to determine current automation.

The current intended scheduled verification architecture is Azure-only for the final verification pass.

---

## 23. Troubleshooting guide

### App shows stale placement data

Check:

1. browser Supabase URL/key;
2. `src/lib/supabase.ts`;
3. initial `placements` query in `App.tsx`;
4. Supabase Realtime configuration;
5. whether the database row was actually updated;
6. browser console/network errors.

### A new role is not appearing

Check:

1. discovery candidate extraction;
2. existing role index/deduplication;
3. Not Interested deduplication;
4. student-placement qualification;
5. 2027 intake evidence;
6. US/UK eligibility if the role is American;
7. verifier result;
8. Supabase insert result;
9. Realtime subscription.

### A role was incorrectly marked Closed

Do not immediately change it back based on intuition. Research:

1. exact role;
2. exact intake;
3. current employer student programme;
4. current ATS;
5. opening/deadline evidence;
6. whether the closed page was only a 2026 vacancy;
7. whether a 2027 opening announcement exists.

### Apply Now button missing

Check the data first:

- `application_link`;
- `careers_page`;
- `website`;
- exact-role verification.

Only change card rendering if the data is correct and the component is actually failing to render the button.

### GitHub Pages deployment failed

Check:

1. `npm run build` locally;
2. Actions run logs;
3. Vite configuration/base path;
4. Pages configuration;
5. required `VITE_*` build secrets.

### Maintenance workflow failed

Check:

1. which scheduled invocation ran;
2. UK-time gate;
3. Node/npm installation;
4. Supabase secrets;
5. Azure secrets/deployment name;
6. discovery logs;
7. Azure audit logs;
8. timeout/concurrency;
9. whether the failure occurred before or after any database writes.

Never blindly rerun a failed maintenance job if it may have partially modified data. First inspect its logs and resulting database state.

---

## 24. What to preserve during future feature work

Unless the user explicitly requests otherwise, preserve:

- the existing placement records;
- application tracking;
- Not Interested behaviour;
- desktop/mobile separation;
- realtime updates;
- Excel export;
- current sector categories;
- current geographic categories;
- current priority semantics;
- UK eligibility requirement for US roles;
- daily 4 PM UK maintenance schedule;
- Azure-based final verification;
- evidence-backed status classification;
- safe environment-variable boundaries;
- GitHub Pages deployment;
- recovery branch and database backup.

When a new requirement conflicts with one of these, follow the user's explicit new requirement, but make the conflict and affected behaviour clear before making a risky change.

---

## 25. Definition of done

A change is complete only when:

- it was made in `jarnav07/placement_tracker`;
- the current implementation was inspected before editing;
- the requested behaviour is implemented rather than merely described;
- unrelated functionality remains intact;
- relevant build/tests pass;
- automation changes match the actual workflow configuration;
- database changes, if any, are targeted and non-destructive unless explicitly requested;
- application-tracking data is preserved;
- no secrets were committed;
- the resulting state was actually verified;
- the final report accurately states what was changed and what was tested.

**When in doubt: inspect first, preserve data, prefer evidence, make the smallest change, test it, and report honestly.**
