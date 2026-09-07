---
name: placement-table-audit
description: Exhaustive, evidence-backed audit of public.placements for the Placement Tracker. Use when the tracker's data needs to be made trustworthy — every row, every researched column, verified against official employer sources.
---

# Placement Table Audit

Make `public.placements` trustworthy enough to be the user's primary placement search.
This is an **exhaustive audit**, not a spot check.

Read `AGENTS.md` first — it defines column ownership, status semantics and the safety rules.
This skill is the procedure; `AGENTS.md` is the law.

---

## Before you touch anything

```sql
select count(*) total,
       count(*) filter (where archived) archived,
       count(*) filter (where not_interested) not_interested,
       count(*) filter (where app_status <> 'Not Applied') tracked_applications
from placements;
```

Record those numbers. They must still hold at the end, unless you deliberately changed one
and can say why.

---

## What you may write

| Class | Columns | May you write it? |
| --- | --- | --- |
| Identity | `company`, `specific_role` | **No** — only to fix a demonstrably malformed value (scraped HTML, `See Gradcracker listing`), and say so in the report. |
| Derived | `priority_score`, `overall_priority` | **Never.** A Postgres trigger owns them. They recompute themselves when you write `cv_fit`, the relevance scores, `prestige`, `career_value`, `application_status`, `opportunity_type` or `exact_deadline`. |
| Derived | `opened_at` | **Never.** The `placements_opening` trigger stamps it when `application_status` becomes `Open Now`. Writing it by hand fakes a role being new. |
| User-owned | `app_status`, `date_applied`, `cv_version`, `cover_letter_required`, `referral_contact`, `interview_date`, `notes`, `not_interested`, `archived` | **Never**, unless the user explicitly asks. |
| Researched | everything else | Yes, when you have evidence. |

**To raise a role's priority, improve its scores — not its priority.** Writing
`overall_priority = 'VERY_HIGH_PRIORITY'` is how the table ended up with five different
priority vocabularies and 86 rows the UI could not render.

---

## Per-row procedure

For every row, in this order:

1. **Read the whole row.** Note what is already verified and when (`source_date_checked`).
2. **Identify the exact opportunity**: employer, role, programme, location, 2027 intake.
3. **Find the employer's official student/early-careers page.**
4. **Search the exact role title plus the employer.**
5. **Check the employer's ATS** — Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Taleo,
   SuccessFactors.
6. **Separate the application opening date from the placement start date.**
7. **Confirm it is genuinely a student opportunity**, not a graduate scheme, an
   experienced-hire vacancy or a non-degree apprenticeship.
8. **For non-UK roles, verify UK-citizen eligibility** — sponsorship, US-person requirements,
   ITAR/EAR, security clearance. Record the finding in `work_eligibility`. Silence is not
   evidence of eligibility.
9. **Verify the application URL** actually leads to this role.
10. **Write only what the evidence supports**, and record the evidence in `source_verified`
    with `source_date_checked = today`.

### Evidence hierarchy

official exact vacancy → official student programme page → official ATS listing → official
careers page with an explicit intake statement → reputable aggregator (Gradcracker, Trackr) →
search snippets. **A weaker source never overwrites a stronger, current, verified value.**

---

## Column-by-column checklist

| Group | Columns | What "correct" means |
| --- | --- | --- |
| Identity | `company`, `specific_role`, `start_year` | A real employer and one actionable role. `start_year` is 2027. |
| Classification | `sector`, `engineering_area`, `opportunity_type`, `country`, `city` | `opportunity_type` is one of the four allowed values and reflects what the programme actually is. |
| Programme | `placement_duration`, `placement_start_date`, `placement_end_date`, `salary`, `other_benefits` | Published facts only. `TBC` where the employer has not said. |
| Availability | `application_status`, `exact_opening_date`, `exact_deadline`, `deadline_type` | See the status rules below. **Dates must be ISO `YYYY-MM-DD`, or `Month YYYY` when only the month is known — never prose.** "Not published" is an empty value plus a `deadline_type`; prose in a date column breaks the automatic opening rule and the deadline weighting. A day-precision `exact_opening_date` will open the placement automatically on that day, so never invent one. |
| Links | `website`, `careers_page`, `application_link` | `application_link` points at this role, not a job search. |
| Eligibility | `degree_requirements`, `min_grade_requirement`, `year_of_study_requirement`, `required_technical_skills`, `work_eligibility`, `security_clearance_requirement` | As published. |
| Fit | `cv_fit`, the six relevance scores, `prestige`, `career_value`, `why_it_fits`, `potential_weaknesses` | Scored for **this** user, role-specific prose, never copied between rows. |
| Trail | `source_date_checked`, `source_verified` | Today's date and the evidence you actually used. |

### Status rules

`Open Now` · `Opening Soon` · `Expected` · `Not Yet Published` · `Closed` · `Unknown`

- **A closed 2026 intake never means the 2027 intake is closed.** If only a 2026 intake is
  visible, that is `Not Yet Published` — or `Expected` if the 2027 programme is confirmed.
- `Open Now` needs the exact role, the 2027 intake, an official source and a real application
  route. A reachable page or a generic Apply button is not enough.
- `Closed` needs evidence that **this** 2027 intake closed, filled or expired.
- When genuinely uncertain, use `Unknown` rather than guessing — but do not downgrade a
  well-evidenced `Expected` or `Not Yet Published` just because today's search was thin.

### Scoring for this user

Targets: aerospace and space, Formula 1 and motorsport, aerodynamics/CFD, propulsion,
controls/avionics.

Score the six relevance dimensions **independently** — a pure F1 aerodynamics role should be
10 on F1 and on aero/CFD and low on rocket/space. The ranking takes the *best* of them, so an
honest zero costs nothing.

---

## Splitting and hiding rows

- **Split distinct opportunities.** One employer running several materially different
  placements needs one row each. The board shows one card per role, so a merged row hides
  opportunities.
- **A row that is not a vacancy** (product page, navigation link, article) gets
  `archived = true`. Do not delete it.
- **A role the user rejected** keeps `not_interested = true`. Do not delete it, and do not
  re-create it under a new title.
- **Never delete a row** without explicit user approval.

---

## Finish with verification

```sql
-- Nothing off-vocabulary, nothing unranked.
select count(*) filter (where application_status not in
         ('Open Now','Opening Soon','Expected','Not Yet Published','Closed','Unknown')) bad_status,
       count(*) filter (where opportunity_type not in
         ('Industrial Placement','Spring Week / Insight','Internship / Co-op','Other Student Programme')) bad_type,
       count(*) filter (where priority_score is null) unranked,
       count(*) filter (where source_date_checked = current_date) checked_today,
       count(*) total
from placements;

-- User data untouched.
select count(*) filter (where app_status <> 'Not Applied') tracked_applications,
       count(*) filter (where notes is not null) rows_with_notes
from placements;
```

The audit is complete only when the row count is unchanged, the user's tracking numbers are
unchanged, no vocabulary is violated, and your report states what you verified, what you
changed, and what you could not establish.
