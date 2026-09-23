-- ---------------------------------------------------------------------------
-- Application stage ladder: Applied -> Assessment -> Portfolio ->
--                           Assessment Centre -> Offer
--
-- The user's pipeline is a UK placement pipeline, and it does not run through a
-- first and a final interview. It runs through a portfolio review and then an
-- assessment centre, so `Interview` and `Final Interview` leave the vocabulary
-- and `Portfolio` and `Assessment Centre` take their place.
--
-- `app_status` is USER-OWNED — the automation never writes it and this migration
-- is the only thing that ever will. It therefore MAPS the two retired values
-- rather than resetting them: `Interview` and `Final Interview` both become
-- `Assessment Centre`, the nearest rung and the one that keeps "got a long way
-- through" true. Resetting them to `Not Applied` would delete the record that
-- the user applied at all, which is the one thing this schema exists to protect.
--
-- No row held either value when this was written — the only stages in use were
-- Not Applied, Saved, Applied and Assessment — so the mapping is a safety net
-- for a row that moves between now and this migration running, not a rewrite of
-- live data.
--
-- `Accepted`, `Rejected` and `Withdrawn` are unchanged. They are outcomes, not
-- rungs: the ladder ends at the offer and the browser lists them separately.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. The old constraint goes first: it does not know 'Assessment Centre' and
--    would reject step 2.
ALTER TABLE placements DROP CONSTRAINT IF EXISTS placements_app_status_check;

-- 2. Retire the two interview stages, keeping how far each application got.
UPDATE placements
   SET app_status = 'Assessment Centre'
 WHERE app_status IN ('Interview', 'Final Interview');

-- 3. The new vocabulary.
ALTER TABLE placements ADD CONSTRAINT placements_app_status_check
  CHECK (app_status IN ('Not Applied', 'Saved', 'Applied', 'Assessment', 'Portfolio',
                        'Assessment Centre', 'Offer', 'Accepted', 'Rejected', 'Withdrawn'));

COMMIT;
