ALTER TABLE public.placements
  ADD COLUMN IF NOT EXISTS opportunity_type text;

UPDATE public.placements
SET opportunity_type = CASE
  WHEN lower(coalesce(placement_type, '')) ~ '(spring week|spring insight|insight week|insight programme|insight program)' THEN 'Spring Week / Insight'
  ELSE 'Industrial Placement'
END
WHERE opportunity_type IS NULL;

COMMENT ON COLUMN public.placements.opportunity_type IS 'High-level opportunity category, e.g. Industrial Placement or Spring Week / Insight.';
