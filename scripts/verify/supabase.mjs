// The one place a Supabase client is built.
//
// WHY THIS FILE EXISTS
//
// `SUPABASE_URL` is routinely stored as the REST endpoint
// (`https://<ref>.supabase.co/rest/v1/`) rather than the project URL, because
// that is the value the Supabase dashboard shows next to the API keys. The
// client appends its own `/rest/v1/...`, so the request goes to
// `/rest/v1/rest/v1/placements` and PostgREST answers:
//
//     PGRST125  Invalid path specified in request URL
//
// The older scripts defended against this by resetting the pathname; the newer
// ones only stripped a trailing slash, so verification died on its first query
// while discovery kept working. Rather than repeat the guard in five scripts,
// every caller now goes through `connect()`.

import { createClient } from '@supabase/supabase-js'

const env = name => (process.env[name] || '').trim().replace(/^['"]|['"]$/g, '')

/**
 * Reduce anything Supabase-shaped to its bare origin, so a REST endpoint, a
 * trailing slash or a stray query string all resolve to the project URL.
 */
export function projectUrl(raw) {
  const value = String(raw ?? '').trim().replace(/^['"]|['"]$/g, '')
  if (!value) return ''
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    // Bare host, e.g. "abc.supabase.co".
    try { parsed = new URL(`https://${value}`) } catch { return '' }
  }
  return parsed.origin
}

/** A service-role client for the project, or a thrown error naming what is missing. */
export function connect() {
  const url = projectUrl(env('SUPABASE_URL') || env('VITE_SUPABASE_URL'))
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url) throw new Error('Missing or unparseable SUPABASE_URL (or VITE_SUPABASE_URL).')
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY.')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { enabled: false },
  })
}
