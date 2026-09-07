// Opens placements on the day their employer said applications would go live.
//
// WHY THIS RUNS SEPARATELY FROM VERIFICATION
//
// The full verification pass is expensive (two AI providers and a web crawl per
// role) and runs once a day. But a placement that opens at 09:00 and is spotted
// at 16:00 the next day has already cost the user a day of a rolling-deadline
// campaign — and if verification cannot reach the employer's site at all, it may
// cost far more. When the employer has already published the exact day, no
// research is needed to know the answer: the date arriving IS the evidence.
//
// This script is cheap enough to run several times a day, needs no AI provider,
// and is deliberately conservative:
//
//   - Only a DAY-precision date qualifies. "November 2026" is not a promise that
//     applications open on 1 November, and the tracker must not invent one.
//     Vaguer dates are reported as due for re-verification instead.
//   - A date more than `grace` days in the past cannot fire, so an opening date
//     left over from an earlier cycle cannot resurrect a dead role.
//   - A role whose deadline has already passed is never opened.
//   - A role verified today as Closed is never re-opened: today's evidence beats
//     a date published earlier.
//
// `opened_at`, which drives the "new" marker in the UI, is set by a Postgres
// trigger when the status becomes "Open Now" — this script never writes it.

import { createClient } from '@supabase/supabase-js'
import { toDatedValue, daysUntil, todayIso } from './verify/dates.mjs'

const env = name => (process.env[name] || '').trim().replace(/^['"]|['"]$/g, '')

/** Built inside `main` so the decision rule below can be imported without credentials. */
function connect() {
  const supabaseUrl = (env('SUPABASE_URL') || env('VITE_SUPABASE_URL')).replace(/\/$/, '')
  const supabaseKey = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !supabaseKey) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.')
  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { enabled: false },
  })
}

const TODAY = todayIso()
const DRY_RUN = env('OPENINGS_DRY_RUN') === 'true'
const GRACE_DAYS = Number(env('OPENINGS_GRACE_DAYS') || 45)

/** Statuses a published opening date is allowed to move. */
const OPENABLE = new Set(['Opening Soon', 'Expected', 'Not Yet Published', 'Unknown'])

/**
 * Should this role be opened today?
 * Pure, so `npm run check` can exercise it without a database.
 */
export function openingDecision(role, today = TODAY, graceDays = GRACE_DAYS) {
  if (!OPENABLE.has(role.application_status)) {
    return { open: false, reason: `status is ${role.application_status}` }
  }

  const opening = toDatedValue(role.exact_opening_date)
  if (!opening.iso) return { open: false, reason: 'no published opening date' }
  if (opening.precision !== 'day') {
    return { open: false, due: true, reason: `opening date is only ${opening.precision}-precise (${role.exact_opening_date})` }
  }

  const daysSinceOpening = -(daysUntil(opening.iso, today) ?? 0)
  if (daysSinceOpening < 0) return { open: false, reason: `opens in ${-daysSinceOpening} days` }
  if (daysSinceOpening > graceDays) {
    return { open: false, reason: `opening date ${opening.iso} passed ${daysSinceOpening} days ago — too stale to trust` }
  }

  const deadlineIn = daysUntil(role.exact_deadline, today)
  if (deadlineIn !== null && deadlineIn < 0) {
    return { open: false, reason: `deadline ${role.exact_deadline} has already passed` }
  }

  // Verification that ran today and found the role closed is newer evidence than
  // a date published weeks ago.
  if (role.application_status === 'Unknown' && role.source_date_checked === today
      && /closed|no longer|withdrawn/i.test(role.source_verified ?? '')) {
    return { open: false, reason: "today's verification found no live application route" }
  }

  return { open: true, iso: opening.iso, daysSinceOpening, reason: `the employer published ${opening.iso} as the day applications open` }
}

async function main() {
  const supabase = connect()
  const { data, error } = await supabase
    .from('placements')
    .select('id, company, specific_role, application_status, exact_opening_date, exact_deadline, source_date_checked, source_verified')
    .eq('archived', false)
    .eq('not_interested', false)
    .not('exact_opening_date', 'is', null)

  if (error) throw error
  const roles = data ?? []

  console.log(`Scheduled openings ${TODAY}: ${roles.length} rows carry an opening date.${DRY_RUN ? ' DRY RUN.' : ''}`)

  let opened = 0
  let due = 0
  let failed = 0

  for (const role of roles) {
    const decision = openingDecision(role)
    const label = `${role.company} — ${role.specific_role}`

    if (decision.due) {
      due++
      console.log(`DUE FOR RE-CHECK: ${label} — ${decision.reason}`)
      continue
    }
    if (!decision.open) continue

    const update = {
      application_status: 'Open Now',
      source_date_checked: TODAY,
      source_verified: [
        `Scheduled opening ${TODAY}: status set to Open Now because ${decision.reason}.`,
        'This is the employer\'s own published opening date, applied automatically on the day it arrived.',
        'The next verification pass will confirm the live application route.',
        role.source_verified ? `\nPrevious evidence:\n${role.source_verified}` : '',
      ].filter(Boolean).join('\n').slice(0, 5000),
    }

    if (DRY_RUN) {
      opened++
      console.log(`WOULD OPEN: ${label} (opening date ${decision.iso})`)
      continue
    }

    const { error: writeError } = await supabase.from('placements').update(update).eq('id', role.id)
    if (writeError) {
      failed++
      console.error(`FAILED TO OPEN: ${label} — ${writeError.message}`)
      continue
    }
    opened++
    console.log(`OPENED: ${label} — published opening date ${decision.iso} has arrived.`)
  }

  console.log(`Scheduled openings complete: ${opened} opened, ${due} due for re-verification (vague opening date), ${failed} failed.`)
  if (failed > 0) process.exitCode = 1
}

// Importable for the invariant tests; only the direct invocation touches the database.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}
