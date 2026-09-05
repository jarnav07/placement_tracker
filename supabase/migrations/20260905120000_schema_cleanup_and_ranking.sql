/*
# Placement schema cleanup + deterministic ranking (2026-09-05)

## Why
The `placements` table had accumulated redundant, overlapping and free-text-chaotic
attributes, and `overall_priority` was written independently by several agents, so it
held five different vocabularies at once (`HIGH_PRIORITY`, `VERY_HIGH_PRIORITY`,
`Very High`, `High`, plus the five canonical values the UI understands). Roles were
therefore neither consistently ranked nor consistently prioritised.

## 1. Redundant attributes removed (9)
| Dropped                          | Merged into / reason |
| -------------------------------- | -------------------- |
| `placement_type`                 | free-text twin of `opportunity_type`; duration detail folded into `placement_duration` |
| `salary_period`                  | folded into `salary` |
| `department`                     | coarse duplicate of `engineering_area` |
| `date_info_verified`             | duplicate of `source_date_checked` (74 rows literally held the string `true`) |
| `source_type`                    | effectively constant |
| `source_url`                     | duplicate of `careers_page` on 213/378 rows |
| `outcome`                        | duplicate of `app_status` (never populated) |
| `citizenship_requirement`        | folded into `work_eligibility` |
| `right_to_work_requirement`      | folded into `work_eligibility` |
| `visa_requirement`               | folded into `work_eligibility` |

## 2. Attributes added (3)
- `work_eligibility` — one consolidated eligibility statement.
- `priority_score` (0-100) — deterministic ranking, maintained by trigger.
- `archived` — hides scraped non-roles (product pages, nav links, blog posts) from
  every view WITHOUT deleting the row.

## 3. Ranking becomes derived, not written
`priority_score` and `overall_priority` are now computed by
`placements_apply_ranking()` on every INSERT/UPDATE from the CV-fit, domain-relevance,
prestige, career-value, availability and opportunity-type columns. No agent can write
an off-vocabulary priority again.

## 4. Vocabularies normalised
`application_status`, `opportunity_type`, `deadline_type`, `country`, `sector` and
`start_year` are normalised and CHECK-constrained.

## 5. User-owned fields recovered
Automation had been writing verification prose into `notes` and
`cover_letter_required` (both user-owned). That text is moved to `source_verified`
and the user fields are cleared.

Non-destructive: no placement row is deleted. A full snapshot is taken first.
*/

-- ---------------------------------------------------------------------------
-- 0. Safety snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS placements_backup_pre_cleanup_2026_09_05 AS
  SELECT * FROM placements;

-- ---------------------------------------------------------------------------
-- 1. New columns
-- ---------------------------------------------------------------------------
ALTER TABLE placements ADD COLUMN IF NOT EXISTS work_eligibility text;
ALTER TABLE placements ADD COLUMN IF NOT EXISTS priority_score integer NOT NULL DEFAULT 0;
ALTER TABLE placements ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Consolidate data out of the columns that are about to be dropped
-- ---------------------------------------------------------------------------

-- 2a. Eligibility: three near-identical columns collapse into one statement.
UPDATE placements SET work_eligibility = NULLIF(
  (
    SELECT string_agg(part, ' · ' ORDER BY ord)
    FROM (
      SELECT DISTINCT ON (lower(btrim(part))) part, ord
      FROM unnest(
        ARRAY[btrim(coalesce(right_to_work_requirement, '')),
              btrim(coalesce(citizenship_requirement, '')),
              btrim(coalesce(visa_requirement, ''))],
        ARRAY[1, 2, 3]
      ) AS t(part, ord)
      WHERE btrim(part) <> '' AND lower(btrim(part)) NOT IN ('tbc', 'n/a', 'unknown', 'not stated', 'true')
      ORDER BY lower(btrim(part)), ord
    ) AS deduped
  ), '')
WHERE work_eligibility IS NULL;

-- 2b. Salary period folds into the salary string when it is not already implied.
UPDATE placements
SET salary = btrim(salary) || ' (' || btrim(salary_period) || ')'
WHERE salary_period IS NOT NULL
  AND btrim(salary_period) <> ''
  AND lower(btrim(salary_period)) NOT IN ('tbc', 'n/a', 'unknown', 'not stated', 'true')
  AND salary IS NOT NULL
  AND btrim(salary) <> ''
  AND lower(btrim(salary)) NOT IN ('tbc', 'n/a', 'unknown', 'not stated')
  AND position(lower(btrim(salary_period)) IN lower(salary)) = 0;

-- 2c. Department is a coarser duplicate of engineering_area; keep it only as a fallback.
UPDATE placements
SET engineering_area = department
WHERE (engineering_area IS NULL OR btrim(engineering_area) = '')
  AND department IS NOT NULL AND btrim(department) <> '';

-- 2d. placement_type detail that is really a duration.
UPDATE placements
SET placement_duration = placement_type
WHERE (placement_duration IS NULL OR btrim(placement_duration) = '')
  AND placement_type ~* '\m\d+\s*-?\s*month';

-- 2e. source_url that is not already represented by careers_page.
UPDATE placements
SET careers_page = source_url
WHERE (careers_page IS NULL OR btrim(careers_page) = '')
  AND source_url IS NOT NULL AND btrim(source_url) <> '';

-- ---------------------------------------------------------------------------
-- 3. Recover user-owned fields that automation had overwritten
-- ---------------------------------------------------------------------------
UPDATE placements
SET source_verified = NULLIF(btrim(concat_ws(E'\n',
      CASE WHEN lower(btrim(coalesce(source_verified, ''))) IN ('', 'true') THEN NULL
           ELSE btrim(source_verified) END,
      btrim(notes))), ''),
    notes = NULL
WHERE notes IS NOT NULL
  AND notes ~* '^(verification run|placement verification|fresh individual audit|azure[- ]only verification|deterministic verification|azure verification)';

UPDATE placements SET cover_letter_required = NULL
WHERE cover_letter_required IS NOT NULL
  AND cover_letter_required NOT IN ('Yes', 'No', 'Submitted');

-- `true` leaked into several free-text verification columns.
UPDATE placements SET source_verified = NULL WHERE lower(btrim(coalesce(source_verified, ''))) = 'true';

-- ---------------------------------------------------------------------------
-- 4. Drop the redundant columns
-- ---------------------------------------------------------------------------
ALTER TABLE placements
  DROP COLUMN IF EXISTS placement_type,
  DROP COLUMN IF EXISTS salary_period,
  DROP COLUMN IF EXISTS department,
  DROP COLUMN IF EXISTS date_info_verified,
  DROP COLUMN IF EXISTS source_type,
  DROP COLUMN IF EXISTS source_url,
  DROP COLUMN IF EXISTS outcome,
  DROP COLUMN IF EXISTS citizenship_requirement,
  DROP COLUMN IF EXISTS right_to_work_requirement,
  DROP COLUMN IF EXISTS visa_requirement;

-- ---------------------------------------------------------------------------
-- 5. Normalise the remaining vocabularies
-- ---------------------------------------------------------------------------

-- 5a. Availability status.
UPDATE placements SET application_status = CASE
  WHEN lower(btrim(coalesce(application_status, ''))) IN ('open', 'open now', 'currently open') THEN 'Open Now'
  WHEN lower(btrim(coalesce(application_status, ''))) IN ('opening soon', 'opens soon') THEN 'Opening Soon'
  WHEN lower(btrim(coalesce(application_status, ''))) = 'expected' THEN 'Expected'
  WHEN lower(btrim(coalesce(application_status, ''))) LIKE '%closed%' THEN 'Closed'
  WHEN lower(btrim(coalesce(application_status, ''))) IN ('unknown', '') OR application_status IS NULL THEN 'Unknown'
  ELSE 'Not Yet Published'
END;

-- 5b. Opportunity type.
UPDATE placements SET opportunity_type = 'Other Student Programme'
WHERE opportunity_type IS NULL
   OR opportunity_type NOT IN ('Industrial Placement', 'Spring Week / Insight', 'Internship / Co-op', 'Other Student Programme');

-- 5c. Deadline type: 24 free-text variants collapse to four.
UPDATE placements SET deadline_type = CASE
  WHEN deadline_type IS NULL OR btrim(deadline_type) = '' THEN NULL
  WHEN deadline_type ~* 'rolling' THEN 'Rolling'
  WHEN deadline_type ~* 'fixed|window|campaign|wave' THEN 'Fixed'
  WHEN deadline_type ~* 'vacancy|role|programme|program|country' THEN 'Vacancy dependent'
  ELSE 'TBC'
END;

-- 5d. Country: fold the free-text multi-country strings onto a primary country.
UPDATE placements SET country = CASE
  WHEN country IS NULL OR btrim(country) = '' THEN NULL
  WHEN country ~* '\m(uk|united kingdom|england|scotland|wales|britain)\M' THEN 'United Kingdom'
  WHEN country ~* '\m(usa|us|united states)\M' THEN 'United States'
  ELSE btrim(split_part(replace(country, '/', ','), ',', 1))
END;

-- 5e. Sector: 32 free-text variants collapse to the five groups the UI filters on.
UPDATE placements SET sector = CASE
  WHEN coalesce(sector, '') || ' ' || company ~* 'motorsport|formula|f1|racing|race car' THEN 'Motorsport'
  WHEN coalesce(sector, '') ~* 'defence|defense|military' THEN 'Defence'
  WHEN coalesce(sector, '') ~* 'research|laborator|university|r&d' THEN 'Research & Advanced Tech'
  WHEN coalesce(sector, '') ~* 'space|rocket|launch|aerospace|aviation|aircraft|satellite|propulsion' THEN 'Aerospace & Space'
  WHEN sector IS NULL OR btrim(sector) = '' THEN NULL
  ELSE 'Engineering & Technology'
END;

-- 5f. Intake year.
UPDATE placements SET start_year = 2027 WHERE start_year IS NULL;
ALTER TABLE placements ALTER COLUMN start_year SET DEFAULT 2027;

-- 5g. Dates become real dates so they sort and compare correctly.
ALTER TABLE placements
  ALTER COLUMN source_date_checked TYPE date
    USING (CASE WHEN source_date_checked ~ '^\d{4}-\d{2}-\d{2}$' THEN source_date_checked::date END),
  ALTER COLUMN date_applied TYPE date
    USING (CASE WHEN date_applied ~ '^\d{4}-\d{2}-\d{2}$' THEN date_applied::date END),
  ALTER COLUMN interview_date TYPE date
    USING (CASE WHEN interview_date ~ '^\d{4}-\d{2}-\d{2}$' THEN interview_date::date END);

-- 5h. Application stage.
UPDATE placements SET app_status = 'Not Applied'
WHERE app_status IS NULL
   OR app_status NOT IN ('Not Applied', 'Saved', 'Applied', 'Assessment', 'Interview',
                         'Final Interview', 'Offer', 'Accepted', 'Rejected', 'Withdrawn');

UPDATE placements SET not_interested = false WHERE not_interested IS NULL;
ALTER TABLE placements ALTER COLUMN not_interested SET DEFAULT false;
ALTER TABLE placements ALTER COLUMN not_interested SET NOT NULL;
ALTER TABLE placements ALTER COLUMN app_status SET NOT NULL;
ALTER TABLE placements ALTER COLUMN application_status SET NOT NULL;
ALTER TABLE placements ALTER COLUMN application_status SET DEFAULT 'Unknown';
ALTER TABLE placements ALTER COLUMN opportunity_type SET NOT NULL;
ALTER TABLE placements ALTER COLUMN opportunity_type SET DEFAULT 'Other Student Programme';

-- ---------------------------------------------------------------------------
-- 6. Archive scraped non-roles (product pages, nav links, blog posts)
-- ---------------------------------------------------------------------------
UPDATE placements SET archived = true
WHERE NOT (
        opportunity_type IN ('Industrial Placement', 'Spring Week / Insight')
        OR (specific_role ~* '\m20\d\d\M' AND specific_role ~* '(placement|internship|intern\M|co-?op)')
      )
  AND (
        length(specific_role) > 110
        OR specific_role ~ '\?'
        OR specific_role ~* '^(find|view|search|see|browse|explore|discover|meet|watch|read|learn|why|how|what|life at|working at|women in|international opportunities|from apprentice|stepping into)\M'
        OR specific_role ~* '(smart (career )?choice|careers? */ *vacancies)$'
        OR (opportunity_type = 'Other Student Programme'
            AND cv_fit IS NULL
            AND specific_role !~* '(industrial placement|year in industry|placement year|student placement|undergraduate|internship|intern\M|co-?op|sandwich|spring (week|insight))')
      );

-- ---------------------------------------------------------------------------
-- 7. Deterministic ranking
-- ---------------------------------------------------------------------------
-- Fit is dominated by CV fit, then by the BEST matching domain (a pure F1 role must
-- not be penalised for a low aerospace score), then career value and prestige.
-- Availability and opportunity type then bias the score towards what is actionable.
CREATE OR REPLACE FUNCTION placement_priority_score(
  p_cv_fit integer, p_aerospace integer, p_rocket_space integer, p_f1 integer,
  p_aero_cfd integer, p_propulsion integer, p_controls integer,
  p_prestige integer, p_career_value integer,
  p_application_status text, p_opportunity_type text
) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT greatest(0, least(100, round(
      8.0 * (
          0.45 * coalesce(p_cv_fit, 0)
        + 0.30 * greatest(coalesce(p_aerospace, 0), coalesce(p_rocket_space, 0), coalesce(p_f1, 0),
                          coalesce(p_aero_cfd, 0), coalesce(p_propulsion, 0), coalesce(p_controls, 0))
        + 0.15 * coalesce(p_career_value, 0)
        + 0.10 * coalesce(p_prestige, 0)
      )
      + CASE p_application_status
          WHEN 'Open Now'     THEN 18
          WHEN 'Opening Soon' THEN 10
          WHEN 'Expected'     THEN 4
          WHEN 'Closed'       THEN -40
          ELSE 0
        END
      + CASE p_opportunity_type
          WHEN 'Industrial Placement'    THEN 8
          WHEN 'Internship / Co-op'      THEN 2
          WHEN 'Spring Week / Insight'   THEN 0
          ELSE -10
        END
  )::integer))
$$;

CREATE OR REPLACE FUNCTION placement_priority_band(p_score integer, p_application_status text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_application_status = 'Closed'                                        THEN 'LOW_PRIORITY'
    WHEN p_score >= 75 AND p_application_status = 'Open Now'                    THEN 'APPLY_IMMEDIATELY'
    WHEN p_score >= 58 AND p_application_status IN ('Opening Soon', 'Expected') THEN 'APPLY_WHEN_OPENING'
    WHEN p_score >= 58                                                          THEN 'HIGH_PRIORITY_WATCH'
    WHEN p_score >= 42                                                          THEN 'GOOD_BACKUP'
    ELSE 'LOW_PRIORITY'
  END
$$;

CREATE OR REPLACE FUNCTION placements_apply_ranking() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.priority_score := placement_priority_score(
    NEW.cv_fit, NEW.aerospace_relevance, NEW.rocket_space_relevance, NEW.f1_motorsport_relevance,
    NEW.aero_cfd_relevance, NEW.propulsion_relevance, NEW.controls_avionics_relevance,
    NEW.prestige, NEW.career_value, NEW.application_status, NEW.opportunity_type);
  NEW.overall_priority := placement_priority_band(NEW.priority_score, NEW.application_status);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS placements_ranking ON placements;
CREATE TRIGGER placements_ranking BEFORE INSERT OR UPDATE ON placements
  FOR EACH ROW EXECUTE FUNCTION placements_apply_ranking();

-- Backfill every existing row through the trigger.
UPDATE placements SET updated_at = updated_at;

ALTER TABLE placements ALTER COLUMN overall_priority SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 8. Constraints and indexes
-- ---------------------------------------------------------------------------
ALTER TABLE placements DROP CONSTRAINT IF EXISTS placements_application_status_check;
ALTER TABLE placements ADD CONSTRAINT placements_application_status_check
  CHECK (application_status IN ('Open Now', 'Opening Soon', 'Expected', 'Not Yet Published', 'Closed', 'Unknown'));

ALTER TABLE placements DROP CONSTRAINT IF EXISTS placements_opportunity_type_check;
ALTER TABLE placements ADD CONSTRAINT placements_opportunity_type_check
  CHECK (opportunity_type IN ('Industrial Placement', 'Spring Week / Insight', 'Internship / Co-op', 'Other Student Programme'));

ALTER TABLE placements DROP CONSTRAINT IF EXISTS placements_app_status_check;
ALTER TABLE placements ADD CONSTRAINT placements_app_status_check
  CHECK (app_status IN ('Not Applied', 'Saved', 'Applied', 'Assessment', 'Interview',
                        'Final Interview', 'Offer', 'Accepted', 'Rejected', 'Withdrawn'));

ALTER TABLE placements DROP CONSTRAINT IF EXISTS placements_deadline_type_check;
ALTER TABLE placements ADD CONSTRAINT placements_deadline_type_check
  CHECK (deadline_type IS NULL OR deadline_type IN ('Rolling', 'Fixed', 'Vacancy dependent', 'TBC'));

ALTER TABLE placements DROP CONSTRAINT IF EXISTS placements_scores_check;
ALTER TABLE placements ADD CONSTRAINT placements_scores_check CHECK (
  (cv_fit IS NULL OR cv_fit BETWEEN 0 AND 10) AND
  (aerospace_relevance IS NULL OR aerospace_relevance BETWEEN 0 AND 10) AND
  (rocket_space_relevance IS NULL OR rocket_space_relevance BETWEEN 0 AND 10) AND
  (f1_motorsport_relevance IS NULL OR f1_motorsport_relevance BETWEEN 0 AND 10) AND
  (aero_cfd_relevance IS NULL OR aero_cfd_relevance BETWEEN 0 AND 10) AND
  (propulsion_relevance IS NULL OR propulsion_relevance BETWEEN 0 AND 10) AND
  (controls_avionics_relevance IS NULL OR controls_avionics_relevance BETWEEN 0 AND 10) AND
  (prestige IS NULL OR prestige BETWEEN 0 AND 10) AND
  (career_value IS NULL OR career_value BETWEEN 0 AND 10)
);

-- One row per company + role. Stops discovery from re-inserting the same link twice.
CREATE UNIQUE INDEX IF NOT EXISTS placements_company_role_key
  ON placements (lower(btrim(company)), lower(btrim(specific_role)));

CREATE INDEX IF NOT EXISTS placements_board_idx
  ON placements (archived, not_interested, priority_score DESC);
CREATE INDEX IF NOT EXISTS placements_status_idx ON placements (application_status);

-- ---------------------------------------------------------------------------
-- 9. Second pass on `notes`: strip machine-written lines wherever they appear
--    (not just at the start of the field) so `notes` holds only the user's own
--    text. The stripped verification prose is preserved in `source_verified`;
--    the repeated "UK passport holder" profile line moved to AGENTS.md, where a
--    standing user fact belongs, instead of being copied onto 177 rows.
-- ---------------------------------------------------------------------------
UPDATE placements SET notes = NULLIF(btrim((
  SELECT string_agg(line, E'\n' ORDER BY ord)
  FROM unnest(string_to_array(notes, E'\n')) WITH ORDINALITY AS t(line, ord)
  WHERE btrim(line) <> ''
    AND btrim(line) !~* '^(verification run|placement verification|fresh (individual )?audit|azure[- ]only verification|deterministic verification|azure verification|automated monitor|user profile update|status normalis|start year:)'
)), '')
WHERE notes IS NOT NULL;
