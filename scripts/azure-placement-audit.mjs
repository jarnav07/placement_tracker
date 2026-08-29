// Azure-only placement verification.
// This intentionally bypasses all deterministic verification and asks Azure OpenAI
// to independently research the current state of each tracked 2027 student role.
// The script is non-destructive: user application-tracking fields are preserved.

import { createClient } from '@supabase/supabase-js'

const rawSupabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim().replace(/^['\"]|['\"]$/g, '')
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^['\"]|['\"]$/g, '')
const azureApiKey = process.env.AZURE_OPENAI_API_KEY?.trim().replace(/^['\"]|['\"]$/g, '')
const azureEndpoint = (process.env.AZURE_OPENAI_ENDPOINT || '').trim().replace(/^['\"]|['\"]$/g, '').replace(/\/+$/, '')
const azureDeployment = (process.env.AZURE_OPENAI_DEPLOYMENT_NAME || '').trim().replace(/^['\"]|['\"]$/g, '')

if (!rawSupabaseUrl || !supabaseKey) throw new Error('Missing Supabase URL/service role key.')
if (!azureApiKey || !azureEndpoint || !azureDeployment) {
  throw new Error('Missing AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_DEPLOYMENT_NAME.')
}

const supabase = createClient(rawSupabaseUrl.replace(/\/$/, ''), supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { enabled: false }
})

const TODAY = new Date().toISOString().slice(0, 10)
const TARGET_INTAKE = '2027'
const MAX_WEB_SEARCHES = 10
const MAX_CONCURRENT = 2
const REQUEST_TIMEOUT_MS = 180000
const MIN_OPEN_CONFIDENCE = 0.80
const MIN_CLOSED_CONFIDENCE = 0.85

const states = ['OPEN_NOW', 'OPENING_SOON', 'EXPECTED', 'NOT_YET_PUBLISHED', 'CLOSED', 'UNKNOWN']

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: states },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    intake_year: { type: 'string' },
    intake_year_confirmed: { type: 'boolean' },
    exact_student_program_found: { type: 'boolean' },
    exact_role_found: { type: 'boolean' },
    direct_application_for_exact_role_found: { type: 'boolean' },
    official_program_source_found: { type: 'boolean' },
    opening_date: { type: 'string' },
    opening_timing: { type: 'string' },
    deadline: { type: 'string' },
    deadline_type: { type: 'string' },
    verified_application_url: { type: 'string' },
    location_city: { type: 'string' },
    location_country: { type: 'string' },
    salary: { type: 'string' },
    degree_requirements: { type: 'string' },
    placement_duration: { type: 'string' },
    placement_type: { type: 'string' },
    website: { type: 'string' },
    evidence_summary: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          type: { type: 'string' },
          evidence: { type: 'string' }
        },
        required: ['url', 'type', 'evidence']
      }
    }
  },
  required: [
    'status', 'confidence', 'intake_year', 'intake_year_confirmed',
    'exact_student_program_found', 'exact_role_found',
    'direct_application_for_exact_role_found', 'official_program_source_found',
    'opening_date', 'opening_timing', 'deadline', 'deadline_type',
    'verified_application_url', 'location_city', 'location_country', 'salary',
    'degree_requirements', 'placement_duration', 'placement_type', 'website',
    'evidence_summary', 'sources'
  ]
}

const instructions = [
  'You are the primary verification agent for a 2027 student placement tracker.',
  'Ignore any deterministic verification logic. You must independently research the role using web search and make your own evidence-based decision.',
  '',
  'The tracker cares about student placements that START IN 2027: industrial placements, year-in-industry roles, undergraduate placements, long internships that are the industrial placement year, co-ops, and equivalent student work placements.',
  'Do NOT treat graduate schemes, apprenticeships, summer-only internships that do not represent the 2027 placement year, or experienced-hire roles as qualifying placements.',
  '',
  'SEARCH THOROUGHLY. Use up to ' + MAX_WEB_SEARCHES + ' web searches. Search the exact role and employer first, then the employer student/early-career programme, then the employer live vacancies/ATS. Search sensible role-title variants and location variants. When useful, search Gradcracker and Trackr as discovery/corroboration sources, but prefer official employer evidence for final verification.',
  '',
  'CRITICAL ANTI-MISS RULES:',
  '- Never assume a generic careers or early-careers page represents the current live vacancy state.',
  '- Never mark a role CLOSED simply because a generic job board page or first page of results does not show it. Search the board, use filters, and inspect pagination or alternate search results where applicable.',
  '- A generic Apply, Search Jobs, View Jobs, or Careers button is NOT proof that the exact role is open.',
  '- An individual live vacancy is stronger evidence than a generic programme page when they conflict.',
  '- Search external ATS pages such as SmartRecruiters, Workday, Greenhouse, Lever, Taleo, SuccessFactors, Jobvite and similar platforms where relevant.',
  '- Check for current intake dates and distinguish application opening date from placement start date.',
  '- A closed 2026 intake is NOT evidence that the 2027 intake is closed. If 2027 is not yet published, use NOT_YET_PUBLISHED or EXPECTED as appropriate.',
  '- If evidence conflicts, keep researching and prefer the most recent authoritative source. Use UNKNOWN rather than guessing.',
  '',
  'STATUS DEFINITIONS:',
  'OPEN_NOW = the exact 2027 student role is currently accepting applications and there is direct application evidence for that exact role.',
  'OPENING_SOON = the employer clearly states when the relevant 2027 application window will open during 2026, but it is not open today.',
  'EXPECTED = the employer clearly confirms a 2027/recurring student placement programme but has not published its 2027 opening details.',
  'NOT_YET_PUBLISHED = a student programme exists, but the 2027 role/intake is not sufficiently published to establish a current or upcoming application window.',
  'CLOSED = reliable current evidence establishes the exact 2027 role/intake is closed, filled, withdrawn, expired, or past deadline.',
  'UNKNOWN = evidence remains insufficient or contradictory after reasonable research.',
  '',
  'OPEN_NOW REQUIREMENTS: confirm the student programme, 2027 intake, exact role, current live availability, and direct application page for the exact role. Do not set verified_application_url to a generic careers page.',
  'CLOSED REQUIREMENTS: there must be evidence about the exact 2027 tracked role/intake. Do not infer closure from a stale 2026 page.',
  '',
  'DETAILS: Extract opening date/timing, deadline and deadline type, location, salary, placement duration/type, degree requirements, and the strongest source URLs when explicitly evidenced. Do not invent missing values.',
  '',
  'SOURCE PRIORITY: official employer vacancy > official employer student programme > official ATS vacancy > reputable secondary listing such as Gradcracker/Trackr. Secondary sources are useful for discovering roles that official pages make difficult to find, but must not be treated as stronger than an official current employer vacancy.',
  '',
  'Return only the structured result.'
].join('\n')

function normaliseUrl(value) {
  if (!value) return ''
  try { return new URL(value).toString() } catch { return '' }
}

function rolePrompt(role) {
  const urls = [role.application_link, role.careers_page, role.source_url]
    .map(normaliseUrl).filter(Boolean)
  const known = [...new Set(urls)]
  return [
    'Current date: ' + TODAY,
    'Target placement start year: ' + TARGET_INTAKE,
    '',
    'Company: ' + (role.company ?? ''),
    'Tracked role: ' + (role.specific_role ?? ''),
    'Location: ' + [role.city, role.country].filter(Boolean).join(', '),
    'Department: ' + (role.department ?? ''),
    'Engineering area: ' + (role.engineering_area ?? ''),
    'Current database status (not authoritative): ' + (role.application_status ?? ''),
    known.length ? 'Known URLs:\n' + known.map(url => '- ' + url).join('\n') : 'Known URLs: none',
    '',
    'Independently research this exact tracked role. Search the exact title and employer, employer student programme, employer live vacancy/ATS, and sensible title variants. Use Gradcracker and Trackr as discovery/corroboration resources when relevant. Check for pagination/search filters on job boards. Verify the current 2027 intake and application state as of today.',
    '',
    'Do not rely on the current database status. It may be wrong. Do not treat a generic careers page or generic Apply button as proof of an open exact role.'
  ].join('\n')
}

function safeString(value) { return typeof value === 'string' ? value : '' }
function safeBool(value) { return value === true }
function safeNum(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
}

function normaliseResult(raw) {
  const result = {
    status: states.includes(raw?.status) ? raw.status : 'UNKNOWN',
    confidence: safeNum(raw?.confidence),
    intake_year: safeString(raw?.intake_year),
    intake_year_confirmed: safeBool(raw?.intake_year_confirmed),
    exact_student_program_found: safeBool(raw?.exact_student_program_found),
    exact_role_found: safeBool(raw?.exact_role_found),
    direct_application_for_exact_role_found: safeBool(raw?.direct_application_for_exact_role_found),
    official_program_source_found: safeBool(raw?.official_program_source_found),
    opening_date: safeString(raw?.opening_date),
    opening_timing: safeString(raw?.opening_timing),
    deadline: safeString(raw?.deadline),
    deadline_type: safeString(raw?.deadline_type),
    verified_application_url: normaliseUrl(raw?.verified_application_url),
    location_city: safeString(raw?.location_city),
    location_country: safeString(raw?.location_country),
    salary: safeString(raw?.salary),
    degree_requirements: safeString(raw?.degree_requirements),
    placement_duration: safeString(raw?.placement_duration),
    placement_type: safeString(raw?.placement_type),
    website: normaliseUrl(raw?.website),
    evidence_summary: safeString(raw?.evidence_summary),
    sources: Array.isArray(raw?.sources) ? raw.sources.filter(Boolean).slice(0, 8).map(source => ({
      url: normaliseUrl(source.url),
      type: safeString(source.type),
      evidence: safeString(source.evidence)
    })).filter(source => source.url) : []
  }

  // Hard safety checks on the model's classification.
  if (result.status === 'OPEN_NOW') {
    const safeOpen = result.confidence >= MIN_OPEN_CONFIDENCE &&
      result.intake_year_confirmed &&
      result.intake_year === TARGET_INTAKE &&
      result.exact_student_program_found &&
      result.exact_role_found &&
      result.direct_application_for_exact_role_found &&
      result.official_program_source_found &&
      !!result.verified_application_url
    if (!safeOpen) result.status = 'UNKNOWN'
  }
  if (result.status === 'CLOSED' && result.confidence < MIN_CLOSED_CONFIDENCE) {
    result.status = 'UNKNOWN'
  }
  return result
}

async function verifyRole(role) {
  const url = azureEndpoint + '/openai/v1/responses'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'api-key': azureApiKey
      },
      body: JSON.stringify({
        model: azureDeployment,
        input: [
          { role: 'developer', content: [{ type: 'input_text', text: instructions }] },
          { role: 'user', content: [{ type: 'input_text', text: rolePrompt(role) }] }
        ],
        tools: [{ type: 'web_search' }],
        max_output_tokens: 1800,
        text: {
          format: {
            type: 'json_schema',
            name: 'azure_placement_verification',
            strict: true,
            schema
          }
        }
      })
    })

    const body = await response.json()
    if (!response.ok) throw new Error(body?.error?.message || ('Azure HTTP ' + response.status))
    if (!body?.output_text) throw new Error('Azure returned no output_text')
    let parsed
    try { parsed = JSON.parse(body.output_text) } catch { throw new Error('Azure returned invalid JSON') }
    return { ok: true, result: normaliseResult(parsed) }
  } finally {
    clearTimeout(timer)
  }
}

function protectedApplicationStatus(value) {
  const status = String(value ?? '').trim().toLowerCase()
  return ['applied', 'application submitted', 'interview', 'interviewing', 'rejected', 'offer', 'offered', 'accepted', 'withdrawn', 'not interested']
    .some(item => status === item || status.includes(item))
}

function evidenceText(result, role) {
  const sources = result.sources.map(source => `- ${source.type}: ${source.url} — ${source.evidence}`).join('\n')
  return [
    `Azure-only verification ${TODAY}: ${result.status} (${Math.round(result.confidence * 100)}% confidence).`,
    `Student programme: ${result.exact_student_program_found ? 'verified' : 'not verified'}; exact role: ${result.exact_role_found ? 'verified' : 'not verified'}; 2027 intake: ${result.intake_year_confirmed ? 'confirmed' : 'not confirmed'}.`,
    `Direct exact-role application: ${result.direct_application_for_exact_role_found ? 'verified' : 'not verified'}; official programme source: ${result.official_program_source_found ? 'verified' : 'not verified'}.`,
    result.opening_date ? `Opening date: ${result.opening_date}.` : '',
    result.opening_timing ? `Opening timing: ${result.opening_timing}.` : '',
    result.deadline ? `Deadline: ${result.deadline}${result.deadline_type ? ` (${result.deadline_type})` : ''}.` : '',
    result.evidence_summary,
    sources ? `Evidence sources:\n${sources}` : ''
  ].filter(Boolean).join('\n').slice(0, 5000)
}

async function updateRole(role, result) {
  const update = {
    source_date_checked: TODAY,
    source_verified: evidenceText(result, role),
    updated_at: new Date().toISOString()
  }

  if (!protectedApplicationStatus(role.app_status)) {
    const mapping = {
      OPEN_NOW: 'Open Now',
      OPENING_SOON: 'Opening Soon',
      EXPECTED: 'Expected',
      NOT_YET_PUBLISHED: 'Not Yet Published',
      CLOSED: 'Closed',
      UNKNOWN: 'Unknown'
    }
    if (!protectedApplicationStatus(role.application_status)) {
      update.application_status = mapping[result.status]
    }
  }

  if (result.opening_date) update.exact_opening_date = result.opening_date
  if (result.deadline) update.exact_deadline = result.deadline
  if (result.deadline_type) update.deadline_type = result.deadline_type

  // Only trust an application URL when Azure verified it is the exact live role.
  if (result.status === 'OPEN_NOW' && result.direct_application_for_exact_role_found && result.verified_application_url) {
    update.application_link = result.verified_application_url
  }

  // Fill objectively verified non-application metadata when present, without touching user tracking.
  if (result.location_city) update.city = result.location_city
  if (result.location_country) update.country = result.location_country
  if (result.salary) update.salary = result.salary
  if (result.degree_requirements) update.degree_requirements = result.degree_requirements
  if (result.placement_duration) update.placement_duration = result.placement_duration
  if (result.placement_type) update.placement_type = result.placement_type
  if (result.website) update.website = result.website

  const { error } = await supabase.from('placements').update(update).eq('id', role.id)
  if (error) throw error
}

async function main() {
  const { data: roles, error } = await supabase
    .from('placements')
    .select('*')
    .order('company', { ascending: true })

  if (error) throw error
  console.log(`Azure-only audit: ${roles?.length ?? 0} rows loaded.`)

  let cursor = 0
  let open = 0
  let changed = 0
  let unchanged = 0
  let skipped = 0
  let errors = 0

  async function worker() {
    while (true) {
      const index = cursor++
      if (index >= (roles ?? []).length) return
      const role = roles[index]
      if (role.not_interested === true || String(role.app_status ?? '').trim().toLowerCase() === 'not interested') {
        skipped++
        continue
      }

      try {
        const verification = await verifyRole(role)
        if (!verification.ok) throw new Error(verification.error || 'Azure verification failed')
        const before = String(role.application_status ?? '')
        await updateRole(role, verification.result)
        const after = ({
          OPEN_NOW: 'Open Now', OPENING_SOON: 'Opening Soon', EXPECTED: 'Expected',
          NOT_YET_PUBLISHED: 'Not Yet Published', CLOSED: 'Closed', UNKNOWN: 'Unknown'
        })[verification.result.status]
        if (after === 'Open Now') open++
        if (before === after) unchanged++
        else changed++
        console.log(`${role.company} — ${role.specific_role ?? 'role'}: ${verification.result.status} (${Math.round(verification.result.confidence * 100)}%)`)
      } catch (error) {
        errors++
        console.error(`${role.company} — ${role.specific_role ?? 'role'}: ${error?.message ?? error}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, roles?.length ?? 0) }, worker))

  const { count, error: countError } = await supabase
    .from('placements')
    .select('id', { count: 'exact', head: true })
  if (countError) throw countError

  console.log(`Azure-only audit complete: ${open} open, ${changed} status changes, ${unchanged} unchanged, ${skipped} skipped, ${errors} errors.`)
  console.log(`Row count after=${count}. No rows are inserted or deleted by this verifier.`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
