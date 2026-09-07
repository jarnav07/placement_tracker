/*
# Opening automation, the newly-opened marker, and deadline-aware ranking (2026-09-07)

## Why

Three problems, all in the same area of the schema.

1. **The tracker could not act on a published opening date.** `exact_opening_date`
   is free text and years of model output filled it with prose — "Not published
   for 2027", "Autumn 2026", "Vacancy dependent" — mixed in with real dates in
   four different formats. Nothing could read it, so a placement whose employer
   had already announced the day applications go live still sat at
   "Not Yet Published" long after that day passed. Embraer's engineering
   internship carried an opening date of 2026-07-06 and was still marked
   Not Yet Published two months later.

2. **Nothing recorded when a placement opened**, so the board could not show the
   user which cards are new. The only "new" indicator in the UI was a five-second
   CSS flash on a realtime insert, visible solely to whoever had the tab open at
   that instant.

3. **Ranking ignored the deadline entirely.** A role closing in four days and one
   closing in seven months scored identically, and a role whose deadline passed
   months ago still outranked a live one.

## 1. `opened_at` (DERIVED — trigger-owned, never written by hand)

Stamped by `placements_track_opening()` the moment `application_status` becomes
`Open Now` from anything else. The UI marks a card as new for a few days after
that timestamp. Existing `Open Now` rows are deliberately left NULL: they are not
new, and back-dating them would fill the board with false "new" badges on the
first deploy.

## 2. Date columns become machine-readable

`placement_parse_date()` and `placement_date_precision()` mirror
`scripts/verify/dates.mjs` exactly — the same formats, the same refusal to read a
date out of prose that says there is no date. Day-precision values are rewritten
to ISO; month and season values keep their text (they still sort, and the UI
still shows them); pure prose is cleared, after folding its meaning into
`deadline_type` where it has one.

Only a DAY-precision opening date may open a placement automatically. "November
2026" is not a promise that applications open on 1 November, and the tracker must
not invent one.

## 3. Deadline urgency enters the ranking

`placement_priority_score()` gains a deadline term and becomes STABLE (it now
depends on the current date). The daily verification pass touches every row, so
the stored score is refreshed daily; the browser recomputes the same formula live
from `src/lib/ranking.ts`, so the board is never a day stale.

| Days to deadline | Adjustment |
| --- | --- |
| passed | −25, at any status: a claim to apply to something that has closed |
| ≤ 7 | +14 |
| ≤ 14 | +11 |
| ≤ 30 | +8 |
| ≤ 60 | +5 |
| ≤ 120 | +2 |
| none / further out | 0 |

The positive bonuses apply only to `Open Now`: a distant deadline on a role you
cannot yet apply to is not urgency. The passed-deadline penalty always applies.

Non-destructive: no placement row is deleted, and a snapshot is taken first.
*/

-- ---------------------------------------------------------------------------
-- 0. Safety snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS placements_backup_pre_openings_2026_09_07 AS
  SELECT * FROM placements;

-- ---------------------------------------------------------------------------
-- 1. Date parsing, mirroring scripts/verify/dates.mjs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION placement_make_date(p_year integer, p_month integer, p_day integer)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_year IS NULL OR p_month IS NULL OR p_day IS NULL THEN RETURN NULL; END IF;
  IF p_year < 2000 OR p_year > 2100 OR p_month < 1 OR p_month > 12 OR p_day < 1 OR p_day > 31 THEN
    RETURN NULL;
  END IF;
  RETURN make_date(p_year, p_month, p_day);
EXCEPTION WHEN others THEN
  -- 31 February and friends.
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION placement_month_number(p_name text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(left(btrim(coalesce(p_name, '')), 3))
    WHEN 'jan' THEN 1 WHEN 'feb' THEN 2  WHEN 'mar' THEN 3  WHEN 'apr' THEN 4
    WHEN 'may' THEN 5 WHEN 'jun' THEN 6  WHEN 'jul' THEN 7  WHEN 'aug' THEN 8
    WHEN 'sep' THEN 9 WHEN 'oct' THEN 10 WHEN 'nov' THEN 11 WHEN 'dec' THEN 12
  END
$$;

-- Text that asserts there is no date, even when a year appears beside it.
CREATE OR REPLACE FUNCTION placement_text_says_no_date(p_text text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_text, '') ~* '(not\s+(yet\s+)?(published|stated|announced|available|applicable|specified|confirmed|disclosed|listed)|no\s+(specific|published|annual|confirmed)|vacancy[- ]dependent|role[- ]dependent|year[- ]round|rolling|ongoing|continuous|\mtbc\M|\mtba\M|to be confirmed|to be announced|\munknown\M|unspecified|\mn/a\M|\mnone\M)'
$$;

/**
 * A date only when the text names a specific calendar DAY.
 *
 * Kept separate from `placement_parse_date` so precision cannot be overstated:
 * "31 February 2027" matches a day-shaped pattern but is not a real day, and
 * must not be reported as one — a day-precision value is what the automation
 * uses to open a placement.
 */
CREATE OR REPLACE FUNCTION placement_parse_day_date(p_text text)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  t text := btrim(coalesce(p_text, ''));
  m text[];
  parsed date;
BEGIN
  IF t = '' THEN RETURN NULL; END IF;

  -- 2026-09-14
  m := regexp_match(t, '\m(20\d{2})-(\d{1,2})-(\d{1,2})\M');
  IF m IS NOT NULL THEN
    parsed := placement_make_date(m[1]::int, m[2]::int, m[3]::int);
    IF parsed IS NOT NULL THEN RETURN parsed; END IF;
  END IF;

  -- 4 September 2026
  m := regexp_match(t, '\m(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})\M', 'i');
  IF m IS NOT NULL THEN
    parsed := placement_make_date(m[3]::int, placement_month_number(m[2]), m[1]::int);
    IF parsed IS NOT NULL THEN RETURN parsed; END IF;
  END IF;

  -- September 4, 2026
  m := regexp_match(t, '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\M', 'i');
  IF m IS NOT NULL THEN
    parsed := placement_make_date(m[3]::int, placement_month_number(m[1]), m[2]::int);
    IF parsed IS NOT NULL THEN RETURN parsed; END IF;
  END IF;

  -- 04/09/2026, read day-first: the tracker is UK-based and every ambiguous
  -- case would otherwise silently shift by months.
  m := regexp_match(t, '\m(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\M');
  IF m IS NOT NULL THEN
    parsed := placement_make_date(m[3]::int, m[2]::int, m[1]::int);
    IF parsed IS NOT NULL THEN RETURN parsed; END IF;
  END IF;

  RETURN NULL;
END;
$$;

/** The first real date in free text, or NULL. Month and season anchor to the 1st. */
CREATE OR REPLACE FUNCTION placement_parse_date(p_text text)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  t text := btrim(coalesce(p_text, ''));
  m text[];
  parsed date;
BEGIN
  IF t = '' THEN RETURN NULL; END IF;

  parsed := placement_parse_day_date(t);
  IF parsed IS NOT NULL THEN RETURN parsed; END IF;

  -- Prose that asserts there is no date wins over any month or season below.
  IF placement_text_says_no_date(t) THEN RETURN NULL; END IF;

  -- Month precision ---------------------------------------------------------
  m := regexp_match(t, '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(20\d{2})\M', 'i');
  IF m IS NOT NULL THEN RETURN placement_make_date(m[2]::int, placement_month_number(m[1]), 1); END IF;

  m := regexp_match(t, '\m(20\d{2})-(\d{1,2})\M');
  IF m IS NOT NULL THEN RETURN placement_make_date(m[1]::int, m[2]::int, 1); END IF;

  -- Season precision --------------------------------------------------------
  m := regexp_match(t, '\m(spring|summer|autumn|fall|winter)\s+(20\d{2})\M', 'i');
  IF m IS NOT NULL THEN
    RETURN placement_make_date(m[2]::int, CASE lower(m[1])
      WHEN 'spring' THEN 3 WHEN 'summer' THEN 6
      WHEN 'autumn' THEN 9 WHEN 'fall' THEN 9 ELSE 12 END, 1);
  END IF;

  RETURN NULL;
END;
$$;

/**
 * 'day' | 'month' | 'season' | 'none'. Season is anchored to its first month and
 * is always approximate; only 'day' may open a placement automatically.
 */
CREATE OR REPLACE FUNCTION placement_date_precision(p_text text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  t text := btrim(coalesce(p_text, ''));
BEGIN
  IF t = '' THEN RETURN 'none'; END IF;
  IF placement_parse_day_date(t) IS NOT NULL THEN RETURN 'day'; END IF;
  IF placement_text_says_no_date(t) THEN RETURN 'none'; END IF;

  IF regexp_match(t, '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(20\d{2})\M', 'i') IS NOT NULL
     OR regexp_match(t, '\m(20\d{2})-(\d{1,2})\M') IS NOT NULL
  THEN
    RETURN 'month';
  END IF;

  IF regexp_match(t, '\m(spring|summer|autumn|fall|winter)\s+(20\d{2})\M', 'i') IS NOT NULL THEN
    RETURN 'season';
  END IF;

  RETURN 'none';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Clean the date columns
-- ---------------------------------------------------------------------------

-- 2a. Preserve the meaning of deadline prose before it is cleared.
UPDATE placements SET deadline_type = CASE
    WHEN exact_deadline ~* 'vacancy|role dependent|project dependent|country dependent' THEN 'Vacancy dependent'
    WHEN exact_deadline ~* 'rolling|ongoing|year[- ]round|continuous' THEN 'Rolling'
    ELSE 'TBC'
  END
WHERE deadline_type IS NULL
  AND coalesce(btrim(exact_deadline), '') <> ''
  AND placement_date_precision(exact_deadline) = 'none';

-- 2b. Day-precision values become ISO so they sort and compare correctly.
UPDATE placements SET exact_opening_date = to_char(placement_parse_date(exact_opening_date), 'YYYY-MM-DD')
WHERE placement_date_precision(exact_opening_date) = 'day'
  AND exact_opening_date IS DISTINCT FROM to_char(placement_parse_date(exact_opening_date), 'YYYY-MM-DD');

UPDATE placements SET exact_deadline = to_char(placement_parse_date(exact_deadline), 'YYYY-MM-DD')
WHERE placement_date_precision(exact_deadline) = 'day'
  AND exact_deadline IS DISTINCT FROM to_char(placement_parse_date(exact_deadline), 'YYYY-MM-DD');

-- 2c. Prose that holds no date at all is not a date. Month and season text is
--     kept — it is real information, it sorts, and the UI shows it as written.
UPDATE placements SET exact_opening_date = NULL
WHERE exact_opening_date IS NOT NULL AND placement_date_precision(exact_opening_date) = 'none';

UPDATE placements SET exact_deadline = NULL
WHERE exact_deadline IS NOT NULL AND placement_date_precision(exact_deadline) = 'none';

-- ---------------------------------------------------------------------------
-- 3. `opened_at` — when this placement's applications opened
-- ---------------------------------------------------------------------------
ALTER TABLE placements ADD COLUMN IF NOT EXISTS opened_at timestamptz;

COMMENT ON COLUMN placements.opened_at IS
  'DERIVED. Set by placements_track_opening() when application_status becomes '
  '''Open Now''. Drives the "new" marker on the board. Never write it by hand.';

CREATE OR REPLACE FUNCTION placements_track_opening() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.application_status = 'Open Now' THEN
      NEW.opened_at := coalesce(NEW.opened_at, now());
    END IF;
    RETURN NEW;
  END IF;

  -- `opened_at` is derived: an UPDATE may not set it, only a transition may.
  NEW.opened_at := OLD.opened_at;
  IF NEW.application_status = 'Open Now' AND OLD.application_status IS DISTINCT FROM 'Open Now' THEN
    NEW.opened_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS placements_opening ON placements;
CREATE TRIGGER placements_opening BEFORE INSERT OR UPDATE ON placements
  FOR EACH ROW EXECUTE FUNCTION placements_track_opening();

-- Rows that are already open are NOT back-dated: they are not new, and marking
-- them so would fill the board with false badges on the first deploy.

-- ---------------------------------------------------------------------------
-- 4. Deadline-aware ranking
-- ---------------------------------------------------------------------------
-- IF YOU CHANGE THESE NUMBERS, CHANGE THEM IN src/lib/ranking.ts TOO.
-- `npm run check` fails when the two drift apart.

/** Days from today to the deadline; NULL when there is no readable deadline. */
CREATE OR REPLACE FUNCTION placement_deadline_days(p_exact_deadline text)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT (placement_parse_date(p_exact_deadline) - current_date)::integer
$$;

/**
 * How much the deadline moves a role.
 * A deadline that has passed is a penalty at any status. Urgency is a bonus only
 * for a role you can actually apply to today.
 */
CREATE OR REPLACE FUNCTION placement_deadline_bonus(p_deadline_days integer, p_application_status text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_deadline_days IS NULL             THEN 0
    WHEN p_deadline_days < 0                 THEN -25
    WHEN p_application_status <> 'Open Now'  THEN 0
    WHEN p_deadline_days <= 7                THEN 14
    WHEN p_deadline_days <= 14               THEN 11
    WHEN p_deadline_days <= 30               THEN 8
    WHEN p_deadline_days <= 60               THEN 5
    WHEN p_deadline_days <= 120              THEN 2
    ELSE 0
  END
$$;

DROP FUNCTION IF EXISTS placement_priority_score(
  integer, integer, integer, integer, integer, integer, integer, integer, integer, text, text);

CREATE OR REPLACE FUNCTION placement_priority_score(
  p_cv_fit integer, p_aerospace integer, p_rocket_space integer, p_f1 integer,
  p_aero_cfd integer, p_propulsion integer, p_controls integer,
  p_prestige integer, p_career_value integer,
  p_application_status text, p_opportunity_type text, p_exact_deadline text
) RETURNS integer
LANGUAGE sql STABLE AS $$
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
      + placement_deadline_bonus(placement_deadline_days(p_exact_deadline), p_application_status)
  )::integer))
$$;

DROP FUNCTION IF EXISTS placement_priority_band(integer, text);

CREATE OR REPLACE FUNCTION placement_priority_band(
  p_score integer, p_application_status text, p_deadline_days integer
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_application_status = 'Closed'                                        THEN 'LOW_PRIORITY'
    -- A good role that closes this week outranks a better one that does not.
    WHEN p_application_status = 'Open Now' AND p_deadline_days BETWEEN 0 AND 7
         AND p_score >= 55                                                      THEN 'APPLY_IMMEDIATELY'
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
    NEW.prestige, NEW.career_value, NEW.application_status, NEW.opportunity_type, NEW.exact_deadline);
  NEW.overall_priority := placement_priority_band(
    NEW.priority_score, NEW.application_status, placement_deadline_days(NEW.exact_deadline));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS placements_ranking ON placements;
CREATE TRIGGER placements_ranking BEFORE INSERT OR UPDATE ON placements
  FOR EACH ROW EXECUTE FUNCTION placements_apply_ranking();

-- Backfill every existing row through both triggers.
UPDATE placements SET updated_at = updated_at;

-- ---------------------------------------------------------------------------
-- 5. Indexes
-- ---------------------------------------------------------------------------
-- The board asks "what opened recently?" on every load.
CREATE INDEX IF NOT EXISTS placements_opened_at_idx
  ON placements (opened_at DESC NULLS LAST) WHERE archived = false;
