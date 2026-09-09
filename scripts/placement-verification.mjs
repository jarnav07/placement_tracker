// The scheduled verification pass.
//
// For every tracked role:
//   1. deterministic evidence is gathered — the tracked pages are fetched and the
//      employer's applicant tracking system is queried for the exact role;
//   2. Gemini (PRIMARY) reasons over that evidence with Google Search grounding;
//   3. Azure OpenAI (SECONDARY) is asked independently whenever the decision is
//      consequential, contested or low-confidence;
//   4. `decideStatus` combines the three, with the deterministic check able to
//      carry a decision on its own because it cannot hallucinate.
//
// OWNERSHIP RULES — the difference between an audit and a data-loss event:
//
//   IDENTITY      company, specific_role      never overwritten. They are what
//                                             "this row" means.
//   DERIVED       priority_score,             never written — Postgres triggers
//                 overall_priority, opened_at own them.
//   USER-OWNED    app_status, date_applied,   never written.
//                 cv_version, cover_letter_required,
//                 referral_contact, interview_date,
//                 notes, not_interested, archived
//   RESEARCHED    everything else             written only when a provider
//                                             actually established a value.
//
// A verification failure leaves the row's researched values ALONE and records the
// failure in source_verified. Overwriting a known-good status because an API call
// timed out loses real information.

import { createClient } from '@supabase/supabase-js'

import { gatherEvidence, deterministicVerdict } from './verify/evidence.mjs'
import {
  RESEARCHED_FIELDS, decideStatus, needsSecondOpinion, mergeRecords, TARGET_YEAR,
} from './verify/record.mjs'
import { verifyWithGemini, geminiConfigured, resolveModel, describeBackend, explainGeminiError } from './verify/gemini.mjs'
import { verifyWithAzure, azureConfigured } from './verify/azure.mjs'
import { openingIsDue, daysUntil, todayIso } from './verify/dates.mjs'

const env = name => (process.env[name] || '').trim().replace(/^['"]|['"]$/g, '')

const supabaseUrl = (env('SUPABASE_URL') || env('VITE_SUPABASE_URL')).replace(/\/$/, '')
const supabaseKey = env('SUPABASE_SERVICE_ROLE_KEY')
if (!supabaseUrl || !supabaseKey) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.')
if (!geminiConfigured && !azureConfigured) {
  throw new Error('No verification provider configured. Set VERTEX_API_KEY (Vertex AI) or GEMINI_API_KEY (AI Studio)'
    + ' for the primary verifier, and/or the AZURE_OPENAI_* secrets for the secondary.')
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { enabled: false },
})

const TODAY = todayIso()
const MAX_CONCURRENT = Number(env('AUDIT_CONCURRENCY') || 2)

/** Optional scoping, used by manual workflow runs. */
const LIMIT = Number(env('AUDIT_LIMIT') || 0)
const ONLY_STALE_DAYS = Number(env('AUDIT_ONLY_STALE_DAYS') || 0)
const INCLUDE_NOT_INTERESTED = env('AUDIT_INCLUDE_NOT_INTERESTED') === 'true'
const DRY_RUN = env('AUDIT_DRY_RUN') === 'true'
const USE_SECONDARY = env('USE_AZURE_SECONDARY') !== 'false'

// ---------------------------------------------------------------------------
// Row selection
// ---------------------------------------------------------------------------

/**
 * Verification order. Least-recently-checked first keeps a truncated run useful,
 * but two groups jump the queue because they are where openings are missed:
 * roles whose published opening date has arrived, and roles the user would act on
 * today (Open Now, or a deadline inside a month).
 */
function verificationPriority(role) {
  if (openingIsDue(role.exact_opening_date, TODAY)) return 0
  if (role.application_status === 'Opening Soon') return 1
  const deadlineIn = daysUntil(role.exact_deadline, TODAY)
  if (role.application_status === 'Open Now' && deadlineIn !== null && deadlineIn >= 0 && deadlineIn <= 30) return 2
  if (role.application_status === 'Open Now') return 3
  return 4
}

async function loadRoles() {
  let query = supabase.from('placements').select('*').eq('archived', false)
  if (!INCLUDE_NOT_INTERESTED) query = query.eq('not_interested', false)
  if (ONLY_STALE_DAYS > 0) {
    const cutoff = new Date(Date.now() - ONLY_STALE_DAYS * 86400000).toISOString().slice(0, 10)
    query = query.or(`source_date_checked.is.null,source_date_checked.lt.${cutoff}`)
  }
  query = query.order('source_date_checked', { ascending: true, nullsFirst: true })

  const { data, error } = await query
  if (error) throw error

  const roles = (data ?? []).sort((a, b) => verificationPriority(a) - verificationPriority(b))
  return LIMIT > 0 ? roles.slice(0, LIMIT) : roles
}

// ---------------------------------------------------------------------------
// One role
// ---------------------------------------------------------------------------

let explainedPrimaryFailure = false

async function verifyRole(role) {
  const evidence = await gatherEvidence(role)
  const verdict = deterministicVerdict(role, evidence)

  const primary = geminiConfigured
    ? await verifyWithGemini(role, evidence, verdict)
    : { ok: false, provider: 'Gemini', error: 'no Gemini key configured' }

  if (!primary.ok) {
    console.warn(`  primary (Gemini) unavailable: ${primary.error}`)
    // Said once per run, not once per role: a misconfigured key would otherwise
    // repeat the same paragraph a few hundred times in the workflow log.
    if (!explainedPrimaryFailure) {
      const explanation = explainGeminiError(primary.error)
      if (explanation) {
        console.warn(`  ${explanation}`)
        console.warn('  Run `npm run check:providers` to test the key on its own.')
      }
      explainedPrimaryFailure = true
    }
  }

  const second = needsSecondOpinion({
    role,
    verdict,
    primary: primary.ok ? primary.judgement : null,
    primaryFailed: !primary.ok,
  })

  let secondary = null
  if (USE_SECONDARY && azureConfigured && second.needed) {
    console.log(`  second opinion (Azure): ${second.why}`)
    const result = await verifyWithAzure(role, evidence, verdict)
    if (result.ok) secondary = result
    else console.warn(`  secondary (Azure) failed: ${result.error}`)
  }

  if (!primary.ok && !secondary) {
    // Both providers are unavailable. The deterministic check may still be
    // decisive on its own — an ATS listing the exact role live is proof enough.
    if (!verdict.status) {
      throw new Error(`no provider produced a result (${primary.error})`)
    }
  }

  const record = mergeRecords(primary.ok ? primary.record : null, secondary?.record ?? null)
  const decision = decideStatus({
    role,
    record,
    verdict,
    primary: primary.ok ? primary.judgement : null,
    secondary: secondary?.judgement ?? null,
    today: TODAY,
  })

  return { evidence, verdict, primary, secondary, record, decision, secondOpinion: second }
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

function evidenceTrail(role, outcome) {
  const { verdict, primary, secondary, decision, secondOpinion } = outcome
  const providers = [
    primary.ok ? `Gemini ${primary.model}` : `Gemini unavailable (${primary.error})`,
    secondary
      ? `Azure ${secondary.model}`
      : (secondOpinion.needed ? 'Azure second opinion requested but unavailable' : 'Azure second opinion not required'),
  ]

  const sources = [
    ...(primary.ok ? primary.judgement.sources : []),
    ...(secondary ? secondary.judgement.sources : []),
  ]
  const seen = new Set()
  const uniqueSources = sources.filter(source => {
    if (seen.has(source.url)) return false
    seen.add(source.url)
    return true
  }).slice(0, 8)

  return [
    `Verification ${TODAY}: ${decision.status ?? `no change (kept ${role.application_status})`}`
      + `${decision.status ? ` · ${Math.round(decision.confidence * 100)}% confidence` : ''}.`,
    `Providers: ${providers.join(' · ')}.`,
    `Deterministic check: ${verdict.status ?? 'no assertion'}. ${verdict.reason}`,
    // The decision often just restates the deterministic reason; do not print it twice.
    decision.reason.startsWith(verdict.reason) ? '' : decision.reason,
    primary.ok && primary.judgement.evidenceSummary ? `Gemini: ${primary.judgement.evidenceSummary}` : '',
    secondary?.judgement.evidenceSummary ? `Azure: ${secondary.judgement.evidenceSummary}` : '',
    uniqueSources.length
      ? 'Sources:\n' + uniqueSources.map(source => `- ${source.type || 'source'}: ${source.url}${source.evidence ? ` — ${source.evidence}` : ''}`).join('\n')
      : '',
  ].filter(Boolean).join('\n').slice(0, 5000)
}

/**
 * Builds the update. A researched field is written only when a provider actually
 * established it, so a thin answer can never blank a good existing value.
 */
function buildUpdate(role, outcome) {
  const { record, decision, verdict } = outcome
  const update = {
    source_date_checked: TODAY,
    source_verified: evidenceTrail(role, outcome),
  }

  for (const field of RESEARCHED_FIELDS) {
    if (field === 'application_status') continue
    const value = record?.[field]
    if (value === null || value === undefined || value === '') continue
    update[field] = value
  }

  // The status is the decision's alone — never a raw provider answer.
  if (decision.status) {
    update.application_status = decision.status
  } else if (['Open Now', 'Closed'].includes(role.application_status)) {
    // Nothing was established today, and a time-sensitive claim is standing.
    // "Open Now" is what makes the user drop everything and apply, so it may not
    // stand on evidence we can no longer reproduce. A live board listing is
    // exactly that evidence, so it keeps the status.
    if (!(role.application_status === 'Open Now' && verdict.status === 'OPEN_NOW')) {
      update.application_status = 'Unknown'
    }
  }

  // The confirmed application route for a role that is open today.
  if (decision.status === 'Open Now' && decision.applicationUrl) {
    update.application_link = decision.applicationUrl
  }

  if (!role.start_year) update.start_year = TARGET_YEAR
  return update
}

async function writeRow(id, update) {
  if (DRY_RUN) return
  const { error } = await supabase.from('placements').update(update).eq('id', id)
  if (error) throw error
}

/** A failed verification records the failure and leaves every researched value alone. */
async function recordFailure(role, message) {
  await writeRow(role.id, {
    source_date_checked: TODAY,
    source_verified: `Verification FAILED ${TODAY}: ${message}\nPrevious values retained.`,
  })
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(describeBackend())
  if (geminiConfigured) await resolveModel()
  else console.warn('No Gemini key configured — running on the Azure secondary alone. Accuracy will be lower.')

  const roles = await loadRoles()
  const total = roles.length

  console.log([
    `Verification ${TODAY}: ${total} rows selected`,
    ` (archived excluded${INCLUDE_NOT_INTERESTED ? '' : ', not-interested excluded'}`,
    ONLY_STALE_DAYS > 0 ? `, stale > ${ONLY_STALE_DAYS}d` : '',
    LIMIT > 0 ? `, limit ${LIMIT}` : '',
    DRY_RUN ? ', DRY RUN' : '',
    `). Primary: ${geminiConfigured ? 'Gemini' : 'none'}.`,
    ` Secondary: ${USE_SECONDARY && azureConfigured ? 'Azure (on demand)' : 'disabled'}.`,
    ` Concurrency ${MAX_CONCURRENT}.`,
  ].join(''))

  const tally = {
    verified: 0, failed: 0, statusChanged: 0, secondOpinions: 0,
    open: 0, closed: 0, noAssertion: 0, cleared: 0,
  }
  let cursor = 0

  async function worker() {
    while (true) {
      const index = cursor++
      if (index >= total) return
      const role = roles[index]
      const label = `${role.company} — ${role.specific_role}`

      try {
        const outcome = await verifyRole(role)
        const update = buildUpdate(role, outcome)
        await writeRow(role.id, update)

        tally.verified++
        if (outcome.secondary) tally.secondOpinions++
        if (!outcome.decision.status) tally.noAssertion++
        if (update.application_status && update.application_status !== role.application_status) {
          tally.statusChanged++
          if (update.application_status === 'Unknown') tally.cleared++
        }
        if (outcome.decision.status === 'Open Now') tally.open++
        if (outcome.decision.status === 'Closed') tally.closed++

        const shown = update.application_status ?? role.application_status
        console.log(`${label}: ${shown}`
          + `${outcome.decision.status ? ` (${Math.round(outcome.decision.confidence * 100)}%)` : ' (unchanged)'}`
          + `${outcome.verdict.status ? ` · board ${outcome.verdict.status}` : ''}`
          + `${outcome.secondary ? ' · second opinion' : ''}`)
      } catch (error) {
        tally.failed++
        const message = error?.message ?? String(error)
        console.error(`${label}: VERIFICATION FAILED — ${message}`)
        try {
          await recordFailure(role, message)
        } catch (writeError) {
          console.error(`${label}: could not record the failure either — ${writeError?.message ?? writeError}`)
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(MAX_CONCURRENT, total)) }, worker))

  console.log([
    `Verification complete: ${tally.verified}/${total} verified, ${tally.failed} failed.`,
    `${tally.statusChanged} status changes (${tally.open} open now, ${tally.closed} closed, ${tally.cleared} cleared to Unknown),`,
    `${tally.noAssertion} left unchanged for lack of evidence,`,
    `${tally.secondOpinions} second opinions from Azure.`,
  ].join(' '))

  // A handful of failures is normal (sites time out). A majority means the
  // credentials, the deployment or the endpoint is wrong, and that should fail
  // the workflow loudly rather than look like a quiet success.
  if (total > 0 && tally.failed > Math.max(5, total * 0.25)) {
    throw new Error(`VERIFICATION UNHEALTHY: ${tally.failed}/${total} verifications failed.`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
