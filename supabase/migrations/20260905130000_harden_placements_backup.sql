/*
# Harden the automated backup helper (2026-09-05)

`create_placements_backup()` created each snapshot with `CREATE TABLE ... AS SELECT`, which
produces a table with **Row Level Security disabled**. Because the automation ran twice a day,
the project accumulated 25+ `placements_backup_*` tables, every one of them fully readable and
writable by anyone holding the public anon key — a complete copy of the tracker, exposed.

This migration:

1. rewrites the function so every future snapshot has RLS enabled and no policies, which
   leaves it readable only by the service role;
2. revokes anon/authenticated access on the snapshots that already exist and enables RLS on
   them, without dropping any of them (they are backups; deleting them is the user's call);
3. prunes nothing automatically — see the query at the bottom for cleaning up by hand.
*/

CREATE OR REPLACE FUNCTION public.create_placements_backup()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  backup_name text;
BEGIN
  backup_name := 'placements_backup_' || to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM_DD_HH24_MI_SS');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I AS SELECT * FROM public.placements', backup_name);
  -- A snapshot with RLS on and no policies is reachable only by the service role.
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', backup_name);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', backup_name);
  RETURN backup_name;
END;
$$;

REVOKE ALL ON FUNCTION public.create_placements_backup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_placements_backup() TO service_role;

-- Close the existing snapshots.
DO $$
DECLARE
  snapshot text;
BEGIN
  FOR snapshot IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'placements_backup%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', snapshot);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', snapshot);
  END LOOP;
END $$;

/*
To list the snapshots and decide which to drop:

  SELECT tablename,
         pg_size_pretty(pg_total_relation_size(format('public.%I', tablename))) AS size
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename LIKE 'placements_backup%'
  ORDER BY tablename;

  DROP TABLE public.placements_backup_2026_08_20_09_18_46;   -- one at a time, deliberately
*/
