// Daily verification pass. For every tracked role, Azure OpenAI researches the
// exact opportunity on the web and returns a structured record, which is written
// back to Supabase.
//
// Ownership rules this script enforces (they are the difference between an audit
// and a data-loss event):
//
//   IDENTITY      company, specific_role      never overwritten — they are what
//                                             "this row" means. A hallucinated
//                                             rename silently destroys the row.
//   DERIVED       priority_score,             never written — a Postgres trigger
//                 overall_priority            owns them.
//   USER-OWNED    app_status, date_applied,   never written.
//                 cv_version, cover_letter_required,
//                 referral_contact, interview_date,
//                 notes, not_interested, archived
//   RESEARCHED    everything else             written only when the model
//                                             actually established a value.
//
// A verification failure leaves the row's status ALONE and records the failure in
// source_verified. Overwriting a known-good status with "Unknown" because an API
// call timed out loses real information.

import { createClient } from '@supabase/supabase-js'

const env = name => (process.env[name] || '').trim().replace(/^['"]|['"]$/g, '')

const supabaseUrl = (env('SUPABASE_URL') || env('VITE_SUPABASE_URL')).replace(/\/$/, '')
const supabaseKey = env('SUPABASE_SERVICE_ROLE_KEY')
const azureApiKey = env('AZURE_OPENAI_API_KEY')
const azureEndpoint = env('AZURE_OPENAI_ENDPOINT').replace(/\/+$/, '')
const azureDeployment = env('AZURE_OPENAI_DEPLOYMENT_NAME')

if (!supabaseUrl || !supabaseKey) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.')
if (!azureApiKey || !azureEndpoint || !azureDeployment) {
  throw new Error('Missing AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_DEPLOYMENT_NAME.')
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { enabled: false }
})

const TODAY = new Date().toISOString().slice(0, 10)
const TARGET_YEAR = 2027
const MAX_WEB_SEARCHES = 15
const MAX_CONCURRENT = Number(env('AUDIT_CONCURRENCY') || 2)
const REQUEST_TIMEOUT_MS = 180000
const MAX_ATTEMPTS = 3

/** Optional scoping, used by manual workflow runs. */
const LIMIT = Number(env('AUDIT_LIMIT') || 0)
const ONLY_STALE_DAYS = Number(env('AUDIT_ONLY_STALE_DAYS') || 0)
const INCLUDE_NOT_INTERESTED = env('AUDIT_INCLUDE_NOT_INTERESTED') === 'true'
const DRY_RUN = env('AUDIT_DRY_RUN') === 'true'

const STATES = ['Open Now', 'Opening Soon', 'Expected', 'Not Yet Published', 'Closed', 'Unknown']
const OPPORTUNITY_TYPES = ['Industrial Placement', 'Spring Week / Insight', 'Internship / Co-op', 'Other Student Programme']
const DEADLINE_TYPES = ['Rolling', 'Fixed', 'Vacancy dependent', 'TBC']

/** Written back when the model establishes a value. Identity, derived and user columns are absent by design. */
const RESEARCHED_FIELDS = [
  'sector', 'country', 'city', 'engineering_area', 'opportunity_type',
  'placement_duration', 'placement_start_date', 'placement_end_date',
  'application_status', 'exact_opening_date', 'exact_deadline', 'deadline_type',
  'website', 'careers_page', 'application_link',
  'degree_requirements', 'min_grade_requirement', 'year_of_study_requirement',
  'required_technical_skills', 'work_eligibility', 'security_clearance_requirement',
  'salary', 'other_benefits',
  'cv_fit', 'aerospace_relevance', 'rocket_space_relevance', 'f1_motorsport_relevance',
  'aero_cfd_relevance', 'propulsion_relevance', 'controls_avionics_relevance',
  'prestige', 'career_value', 'why_it_fits', 'potential_weaknesses'
]

const SCORE_FIELDS = [
  'cv_fit', 'aerospace_relevance', 'rocket_space_relevance', 'f1_motorsport_relevance',
  'aero_cfd_relevance', 'propulsion_relevance', 'controls_avionics_relevance',
  'prestige', 'career_value'
]

const URL_FIELDS = ['website', 'careers_page', 'application_link']

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const stringField = { type: 'string' }
const scoreField = { type: 'integer', minimum: 0, maximum: 10 }

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sector: stringField, country: stringField, city: stringField, engineering_area: stringField,
    opportunity_type: { type: 'string', enum: OPPORTUNITY_TYPES },
    placement_duration: stringField, placement_start_date: stringField, placement_end_date: stringField,
    application_status: { type: 'string', enum: STATES },
    exact_opening_date: stringField, exact_deadline: stringField,
    deadline_type: { type: 'string', enum: [...DEADLINE_TYPES, ''] },
    website: stringField, careers_page: stringField, application_link: stringField,
    degree_requirements: stringField, min_grade_requirement: stringField, year_of_study_requirement: stringField,
    required_technical_skills: stringField, work_eligibility: stringField, security_clearance_requirement: stringField,
    salary: stringField, other_benefits: stringField,
    cv_fit: scoreField, aerospace_relevance: scoreField, rocket_space_relevance: scoreField,
    f1_motorsport_relevance: scoreField, aero_cfd_relevance: scoreField, propulsion_relevance: scoreField,
    controls_avionics_relevance: scoreField, prestige: scoreField, career_value: scoreField,
    why_it_fits: stringField, potential_weaknesses: stringField,
    intake_year: { type: 'integer' },
    exact_role_found: { type: 'boolean' },
    direct_application_for_exact_role_found: { type: 'boolean' },
    official_source_found: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence_summary: stringField,
    sources: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { url: stringField, type: stringField, evidence: stringField },
        required: ['url', 'type', 'evidence']
      }
    }
  },
  required: [
    ...RESEARCHED_FIELDS,
    'intake_year', 'exact_role_found', 'direct_application_for_exact_role_found',
    'official_source_found', 'confidence', 'evidence_summary', 'sources'
  ]
}

const instructions = [
  'You verify and enrich one tracked student opportunity for a UK engineering student\'s placement tracker.',
  `The tracker follows opportunities whose placement/internship STARTS IN ${TARGET_YEAR}.`,
  '',
  'RESEARCH',
  `Use up to ${MAX_WEB_SEARCHES} web searches. Search the exact employer plus the exact role title first, then the employer's official student/early-careers pages, then its ATS (Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Taleo, SuccessFactors). Do not stop at a generic careers homepage.`,
  'Treat the existing database values as claims to be checked, not as facts.',
  'Prefer official employer and ATS evidence over aggregators such as Gradcracker or Trackr.',
  '',
  'STATUS — choose exactly one',
  'Open Now: the exact 2027 opportunity is accepting applications today, evidenced by a live application route.',
  'Opening Soon: the 2027 intake is confirmed and a published opening date or month has not yet arrived.',
  'Expected: the 2027 intake is confirmed but no opening details are published.',
  'Not Yet Published: the programme exists but its 2027 intake is not published.',
  'Closed: reliable evidence that the exact 2027 intake has closed, filled or passed its deadline.',
  'Unknown: evidence is insufficient or contradictory. Prefer Unknown over a guess.',
  '',
  'HARD RULES',
  'A closed or expired 2026 intake is NEVER evidence that the 2027 intake is closed.',
  'The application OPENING date is not the placement START date. A September 2027 start does not mean applications open in September 2026.',
  'A reachable page, a generic careers page, or a generic Apply/Search-jobs button is not evidence that applications are open.',
  'Set application_link only to a URL you confirmed is the application route for THIS role. Otherwise repeat the tracked link.',
  '',
  'CLASSIFICATION',
  'Industrial Placement: a year-in-industry or substantial industrial placement.',
  'Spring Week / Insight: a short spring or insight programme (including Optiver-style Career Kickstarter).',
  'Internship / Co-op: a summer or off-cycle internship or co-op.',
  'Other Student Programme: any other student programme. Use this if the item is not really a role.',
  'Graduate schemes, experienced-hire vacancies and non-degree apprenticeships are out of scope: classify them Other Student Programme with a low cv_fit and say so in the evidence.',
  '',
  'ELIGIBILITY',
  'The user is a UK passport holder studying engineering, so UK right-to-work is not a blocker for UK roles.',
  'For roles outside the UK, and especially US roles, verify explicitly whether a UK citizen may apply: sponsorship, US-person requirements, ITAR/EAR export controls and security clearance. Do not infer eligibility from silence. Summarise the finding in work_eligibility.',
  '',
  'SCORING (0-10, tracker-specific, judged for THIS user)',
  'The user targets aerospace, space and rocketry, Formula 1 and motorsport, aerodynamics/CFD, propulsion, and controls/avionics.',
  'cv_fit: how well this exact role matches that profile and an undergraduate engineering CV.',
  'The six relevance scores: how strongly the role sits in each of those domains. Score each independently; a pure F1 aerodynamics role should score 10 on F1 and on aero/CFD and low on rocket/space.',
  'prestige: standing of the employer in engineering. career_value: what the placement does for the user\'s career.',
  'Give role-specific why_it_fits and potential_weaknesses. Never reuse generic text across roles.',
  '',
  'OUTPUT',
  'Return every field. Use an empty string for text you could not establish — never invent a date, salary, link or requirement. Leave a score at 0 only if you genuinely cannot judge it.'
].join('\n')

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const asString = value => (typeof value === 'string' ? value.trim() : '')

function asUrl(value) {
  const text = asString(value)
  if (!text) return ''
  try { return new URL(text).toString() } catch { return '' }
}

function asScore(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(10, Math.round(number))) : null
}

/**
 * Turns a raw model response into the values we are willing to store, and
 * decides whether "Open Now" survives. Open Now is the only status that makes
 * the user act, so it carries the strictest gate.
 */
function normalise(raw) {
  const result = {}
  for (const field of RESEARCHED_FIELDS) {
    if (SCORE_FIELDS.includes(field)) result[field] = asScore(raw?.[field])
    else if (URL_FIELDS.includes(field)) result[field] = asUrl(raw?.[field])
    else result[field] = asString(raw?.[field])
  }

  result.application_status = STATES.includes(result.application_status) ? result.application_status : 'Unknown'
  result.opportunity_type = OPPORTUNITY_TYPES.includes(result.opportunity_type) ? result.opportunity_type : ''
  result.deadline_type = DEADLINE_TYPES.includes(result.deadline_type) ? result.deadline_type : ''

  const confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || 0))
  const intakeMatches = Number(raw?.intake_year) === TARGET_YEAR

  // "Open Now" requires the exact role, the right intake, a real application
  // route and high confidence. Anything less is downgraded rather than shown to
  // the user as something to apply to today.
  if (result.application_status === 'Open Now') {
    const safe = confidence >= 0.8
      && intakeMatches
      && raw?.exact_role_found === true
      && raw?.direct_application_for_exact_role_found === true
      && raw?.official_source_found === true
      && Boolean(result.application_link)
    if (!safe) result.application_status = 'Unknown'
  }

  // "Closed" is equally consequential in the other direction.
  if (result.application_status === 'Closed' && !(confidence >= 0.8 && intakeMatches)) {
    result.application_status = 'Unknown'
  }

  const sources = Array.isArray(raw?.sources)
    ? raw.sources.map(source => ({ url: asUrl(source?.url), type: asString(source?.type), evidence: asString(source?.evidence) }))
        .filter(source => source.url)
    : []

  result.source_date_checked = TODAY
  result.source_verified = [
    `Azure verification ${TODAY}: ${result.application_status}`
      + ` · ${result.opportunity_type || 'type unchanged'}`
      + ` · intake ${raw?.intake_year || 'unconfirmed'}`
      + ` · ${Math.round(confidence * 100)}% confidence.`,
    asString(raw?.evidence_summary),
    sources.length ? 'Sources:\n' + sources.map(s => `- ${s.type || 'source'}: ${s.url} — ${s.evidence}`).join('\n') : ''
  ].filter(Boolean).join('\n').slice(0, 5000)

  result.__confidence = confidence
  result.__intakeMatches = intakeMatches
  return result
}

// ---------------------------------------------------------------------------
// Azure call
// ---------------------------------------------------------------------------

function rolePrompt(role) {
  const urls = [...new Set([role.application_link, role.careers_page].map(asUrl).filter(Boolean))]
  return [
    `Current date: ${TODAY}`,
    `Target placement start year: ${TARGET_YEAR}`,
    '',
    `Company: ${role.company}`,
    `Tracked role title: ${role.specific_role}`,
    `Tracked location (not authoritative): ${[role.city, role.country].filter(Boolean).join(', ') || 'unknown'}`,
    `Tracked opportunity type (not authoritative): ${role.opportunity_type || 'unknown'}`,
    `Tracked status (not authoritative): ${role.application_status || 'unknown'}`,
    '',
    'Known URLs:',
    urls.length ? urls.map(url => `- ${url}`).join('\n') : '- none',
    '',
    'Verify this exact opportunity and return the complete record. Decide whether applications are open',
    `RIGHT NOW for the exact ${TARGET_YEAR} opportunity, not merely whether the employer is recruiting.`
  ].join('\n')
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])

/** One Azure call, with bounded retries for rate limits and transient failures. */
async function verifyRole(role) {
  let lastError = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${azureEndpoint}/openai/v1/responses`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'api-key': azureApiKey },
        body: JSON.stringify({
          model: azureDeployment,
          input: [
            { role: 'developer', content: [{ type: 'input_text', text: instructions }] },
            { role: 'user', content: [{ type: 'input_text', text: rolePrompt(role) }] }
          ],
          tools: [{ type: 'web_search' }],
          max_output_tokens: 3200,
          text: { format: { type: 'json_schema', name: 'placement_record', strict: true, schema } }
        })
      })

      const body = await response.json().catch(() => null)
      if (!response.ok) {
        const message = body?.error?.message || `Azure HTTP ${response.status}`
        if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
          const backoff = 2000 * 2 ** (attempt - 1)
          console.warn(`  retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff}ms — ${message}`)
          await sleep(backoff)
          lastError = message
          continue
        }
        throw new Error(message)
      }
      if (!body?.output_text) throw new Error('Azure returned no output_text')
      return normalise(JSON.parse(body.output_text))
    } catch (error) {
      lastError = error?.message ?? String(error)
      const transient = error?.name === 'AbortError' || /fetch failed|network|ECONN|socket/i.test(lastError)
      if (transient && attempt < MAX_ATTEMPTS) {
        const backoff = 2000 * 2 ** (attempt - 1)
        console.warn(`  retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff}ms — ${lastError}`)
        await sleep(backoff)
        continue
      }
      throw new Error(lastError)
    } finally {
      clearTimeout(timer)
    }
  }

  throw new Error(lastError || 'Azure verification failed')
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

/**
 * Builds the update. A researched field is only written when the model actually
 * established it, so a thin answer can never blank a good existing value.
 */
function buildUpdate(role, result) {
  const update = { source_date_checked: result.source_date_checked, source_verified: result.source_verified }

  for (const field of RESEARCHED_FIELDS) {
    const value = result[field]
    if (value === null || value === undefined || value === '') continue
    // An unresolved run must not erase a stable status ("Expected", "Not Yet
    // Published", "Opening Soon") established on an earlier run. It MUST however
    // clear "Open Now" and "Closed": those are time-sensitive claims that make
    // the user act, and leaving one standing when today's evidence no longer
    // supports it is worse than admitting the status is unknown.
    if (field === 'application_status' && value === 'Unknown'
        && !['Open Now', 'Closed'].includes(role.application_status)) continue
    update[field] = value
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
    source_verified: `Azure verification FAILED ${TODAY}: ${message}\nPrevious values retained.`
  })
}

// ---------------------------------------------------------------------------

async function loadRoles() {
  let query = supabase.from('placements').select('*').eq('archived', false)
  if (!INCLUDE_NOT_INTERESTED) query = query.eq('not_interested', false)
  if (ONLY_STALE_DAYS > 0) {
    const cutoff = new Date(Date.now() - ONLY_STALE_DAYS * 86400000).toISOString().slice(0, 10)
    query = query.or(`source_date_checked.is.null,source_date_checked.lt.${cutoff}`)
  }
  // Least-recently-verified first, so a truncated run still improves the stalest rows.
  query = query.order('source_date_checked', { ascending: true, nullsFirst: true })
  if (LIMIT > 0) query = query.limit(LIMIT)

  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

async function main() {
  const roles = await loadRoles()
  const total = roles.length
  console.log([
    `Azure audit ${TODAY}: ${total} rows selected`,
    `(archived excluded${INCLUDE_NOT_INTERESTED ? '' : ', not-interested excluded'}`,
    ONLY_STALE_DAYS > 0 ? `, stale > ${ONLY_STALE_DAYS}d` : '',
    LIMIT > 0 ? `, limit ${LIMIT}` : '',
    DRY_RUN ? ', DRY RUN' : '',
    `). Concurrency ${MAX_CONCURRENT}.`
  ].join(''))

  const tally = { verified: 0, failed: 0, statusChanged: 0, reclassified: 0, open: 0, unresolved: 0 }
  let cursor = 0

  async function worker() {
    while (true) {
      const index = cursor++
      if (index >= total) return
      const role = roles[index]
      const label = `${role.company} — ${role.specific_role}`

      try {
        const result = await verifyRole(role)
        const update = buildUpdate(role, result)
        await writeRow(role.id, update)

        tally.verified++
        if (update.application_status && update.application_status !== role.application_status) tally.statusChanged++
        if (update.opportunity_type && update.opportunity_type !== role.opportunity_type) tally.reclassified++
        if (result.application_status === 'Open Now') tally.open++
        if (result.application_status === 'Unknown') tally.unresolved++

        console.log(`${label}: ${result.application_status}`
          + ` (${Math.round(result.__confidence * 100)}%)`
          + `${update.opportunity_type ? ` · ${update.opportunity_type}` : ''}`
          + `${update.cv_fit != null ? ` · CV fit ${update.cv_fit}` : ''}`)
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
    `Audit complete: ${tally.verified}/${total} verified, ${tally.failed} failed.`,
    `${tally.statusChanged} status changes, ${tally.reclassified} reclassified,`,
    `${tally.open} open now, ${tally.unresolved} left unresolved.`
  ].join(' '))

  // A handful of failures is normal (sites time out). A majority means the
  // credentials, the deployment or the endpoint is wrong, and that should fail
  // the workflow loudly rather than look like a quiet success.
  if (total > 0 && tally.failed > Math.max(5, total * 0.25)) {
    throw new Error(`AUDIT UNHEALTHY: ${tally.failed}/${total} verifications failed.`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
