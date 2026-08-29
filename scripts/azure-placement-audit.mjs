// Azure-only placement verification and full-record enrichment.
// No deterministic verification is used here. Every tracked placement is independently
// researched by Azure OpenAI and every non-user-managed field is refreshed when evidence exists.

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim().replace(/^['\"]|['\"]$/g, '').replace(/\/$/, '')
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^['\"]|['\"]$/g, '')
const azureApiKey = process.env.AZURE_OPENAI_API_KEY?.trim().replace(/^['\"]|['\"]$/g, '')
const azureEndpoint = (process.env.AZURE_OPENAI_ENDPOINT || '').trim().replace(/^['\"]|['\"]$/g, '').replace(/\/+$/, '')
const azureDeployment = (process.env.AZURE_OPENAI_DEPLOYMENT_NAME || '').trim().replace(/^['\"]|['\"]$/g, '')

if (!supabaseUrl || !supabaseKey) throw new Error('Missing Supabase URL/service role key.')
if (!azureApiKey || !azureEndpoint || !azureDeployment) {
  throw new Error('Missing AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_DEPLOYMENT_NAME.')
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { enabled: false }
})

const TODAY = new Date().toISOString().slice(0, 10)
const TARGET_YEAR = 2027
const MAX_WEB_SEARCHES = 10
const MAX_CONCURRENT = 2
const REQUEST_TIMEOUT_MS = 180000

const STATES = ['Open Now', 'Opening Soon', 'Expected', 'Not Yet Published', 'Closed', 'Unknown']
const PRIORITY_FIELDS = [
  'cv_fit', 'aerospace_relevance', 'rocket_space_relevance', 'f1_motorsport_relevance',
  'aero_cfd_relevance', 'propulsion_relevance', 'controls_avionics_relevance',
  'prestige', 'career_value'
]

const USER_MANAGED = new Set([
  'id', 'created_at', 'updated_at', 'app_status', 'date_applied', 'cv_version',
  'cover_letter_required', 'referral_contact', 'interview_date', 'outcome', 'notes', 'not_interested'
])

const FIELD_TYPES = {
  cv_fit: 'integer', aerospace_relevance: 'integer', rocket_space_relevance: 'integer',
  f1_motorsport_relevance: 'integer', aero_cfd_relevance: 'integer', propulsion_relevance: 'integer',
  controls_avionics_relevance: 'integer', prestige: 'integer', career_value: 'integer', start_year: 'integer'
}

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    company: { type: 'string' }, sector: { type: 'string' }, country: { type: 'string' }, city: { type: 'string' },
    website: { type: 'string' }, careers_page: { type: 'string' }, specific_role: { type: 'string' },
    department: { type: 'string' }, engineering_area: { type: 'string' }, placement_type: { type: 'string' },
    placement_duration: { type: 'string' }, placement_start_date: { type: 'string' }, placement_end_date: { type: 'string' },
    application_status: { type: 'string', enum: STATES }, exact_opening_date: { type: 'string' }, exact_deadline: { type: 'string' },
    deadline_type: { type: 'string' }, date_info_verified: { type: 'string' }, application_link: { type: 'string' },
    degree_requirements: { type: 'string' }, min_grade_requirement: { type: 'string' }, year_of_study_requirement: { type: 'string' },
    required_technical_skills: { type: 'string' }, citizenship_requirement: { type: 'string' },
    right_to_work_requirement: { type: 'string' }, security_clearance_requirement: { type: 'string' }, visa_requirement: { type: 'string' },
    salary: { type: 'string' }, salary_period: { type: 'string' }, other_benefits: { type: 'string' },
    cv_fit: { type: 'integer', minimum: 0, maximum: 10 }, aerospace_relevance: { type: 'integer', minimum: 0, maximum: 10 },
    rocket_space_relevance: { type: 'integer', minimum: 0, maximum: 10 }, f1_motorsport_relevance: { type: 'integer', minimum: 0, maximum: 10 },
    aero_cfd_relevance: { type: 'integer', minimum: 0, maximum: 10 }, propulsion_relevance: { type: 'integer', minimum: 0, maximum: 10 },
    controls_avionics_relevance: { type: 'integer', minimum: 0, maximum: 10 }, prestige: { type: 'integer', minimum: 0, maximum: 10 },
    career_value: { type: 'integer', minimum: 0, maximum: 10 }, overall_priority: { type: 'string' },
    why_it_fits: { type: 'string' }, potential_weaknesses: { type: 'string' }, source_url: { type: 'string' },
    source_type: { type: 'string' }, source_date_checked: { type: 'string' }, source_verified: { type: 'string' },
    start_year: { type: 'integer' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence_summary: { type: 'string' }, sources: {
      type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        url: { type: 'string' }, type: { type: 'string' }, evidence: { type: 'string' }
      }, required: ['url', 'type', 'evidence'] }
    }
  },
  required: [
    'company','sector','country','city','website','careers_page','specific_role','department','engineering_area','placement_type',
    'placement_duration','placement_start_date','placement_end_date','application_status','exact_opening_date','exact_deadline',
    'deadline_type','date_info_verified','application_link','degree_requirements','min_grade_requirement','year_of_study_requirement',
    'required_technical_skills','citizenship_requirement','right_to_work_requirement','security_clearance_requirement','visa_requirement',
    'salary','salary_period','other_benefits','cv_fit','aerospace_relevance','rocket_space_relevance','f1_motorsport_relevance',
    'aero_cfd_relevance','propulsion_relevance','controls_avionics_relevance','prestige','career_value','overall_priority','why_it_fits',
    'potential_weaknesses','source_url','source_type','source_date_checked','source_verified','start_year','confidence','evidence_summary','sources'
  ]
}

const instructions = [
  'You are the primary verification and data-enrichment agent for a student placement tracker.',
  `The tracker targets student placements that START IN ${TARGET_YEAR}.`,
  '',
  'You must independently research the exact tracked opportunity using web search. Do not rely on the database status as truth and do not use deterministic checks as a gate.',
  '',
  'RESEARCH REQUIREMENT:',
  `- Use up to ${MAX_WEB_SEARCHES} web searches intelligently. Search the exact role and employer first.`,
  '- Then check the employer student/early-career programme, the live employer vacancy/ATS, and sensible title variants.',
  '- Search Gradcracker and Trackr as discovery/corroboration sources where relevant.',
  '- Search external ATS/job systems such as SmartRecruiters, Workday, Greenhouse, Lever, Taleo, SuccessFactors, Jobvite and equivalents when relevant.',
  '- Do not conclude a role is closed because it is absent from a generic careers page or first page of an ATS. Search the relevant job board/filter/pagination.',
  '- Distinguish the application opening date from the placement start date.',
  '- A closed 2026 intake does not mean the 2027 intake is closed.',
  '- Verify the exact tracked role, not a different role at the same company.',
  '',
  'STATUS RULES:',
  'Open Now = exact 2027 student role currently accepts applications and there is direct application evidence.',
  'Opening Soon = 2027 student role/programme confirmed and an opening date/month is explicitly published, but it is not open today.',
  'Expected = 2027 student programme/intake confirmed but opening details are not published.',
  'Not Yet Published = relevant student programme exists but the 2027 intake/role is not sufficiently published.',
  'Closed = reliable evidence that the exact 2027 tracked intake is closed, filled, expired, withdrawn, or past deadline.',
  'Unknown = evidence remains insufficient or conflicting after reasonable research.',
  '',
  'OPEN REQUIREMENTS: confirm student programme, 2027 intake, exact role, live availability, and direct application URL. A generic Apply/Search/View Jobs button is not enough.',
  '',
  'FULL RECORD ENRICHMENT — CRITICAL:',
  'For every role, research and return every applicable database attribute, not just status.',
  'Populate role/company/location/programme details, dates, application link, academic requirements, technical skills, eligibility/work authorisation, salary/benefits, source/verification data, and all priority/fit fields.',
  'Priority fields are tracker-derived, not employer fields. Calculate them from the verified role and the user fit represented by this placement tracker. Use 0-10 integers and provide a role-specific overall_priority, why_it_fits, and potential_weaknesses.',
  'Do not leave priority fields blank merely because an employer did not publish a score.',
  'Do not use generic copy across roles; explain why THIS role fits and what its weaknesses are.',
  '',
  'US RULE:',
  'US roles may only be treated as eligible/confirmed when a UK citizen can apply and work there. Explicitly check citizenship, US-person status, right to work, sponsorship, ITAR/EAR/export controls, security clearance, and other restrictions. Do not assume sponsorship from silence. If UK-citizen eligibility cannot be established, use a non-confirmed status and make the restriction explicit in the eligibility fields/evidence.',
  '',
  'DATES AND MISSING DATA:',
  'Prefer exact dates. If only a month/season/rolling deadline is stated, record it honestly and set deadline_type accordingly. Never invent facts. Leave a string empty only after reasonable research fails to establish it.',
  '',
  'SOURCE PRIORITY: official employer exact vacancy > official employer careers/student programme > official ATS > Gradcracker/Trackr/other reputable secondary source.',
  '',
  'Return only the structured JSON result.'
].join('\n')

function asString(value) { return typeof value === 'string' ? value : '' }
function asInt(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : 0 }
function asUrl(value) { const s = asString(value); try { return s ? new URL(s).toString() : '' } catch { return '' } }

function normalise(raw, existing) {
  const result = {}
  for (const key of Object.keys(schema.properties)) {
    const value = raw?.[key]
    if (FIELD_TYPES[key] === 'integer') result[key] = Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0
    else if (schema.properties[key]?.type === 'number') result[key] = Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0
    else result[key] = asString(value)
  }

  result.application_status = STATES.includes(result.application_status) ? result.application_status : 'Unknown'
  result.start_year = TARGET_YEAR
  result.website = asUrl(result.website)
  result.careers_page = asUrl(result.careers_page)
  result.application_link = asUrl(result.application_link)
  result.source_url = asUrl(result.source_url)
  result.date_info_verified = result.date_info_verified || 'false'
  result.source_date_checked = TODAY

  result.sources = Array.isArray(raw?.sources)
    ? raw.sources.map(source => ({ url: asUrl(source?.url), type: asString(source?.type), evidence: asString(source?.evidence) })).filter(x => x.url)
    : []

  result.source_verified = [
    `Azure-only verification ${TODAY}: ${result.application_status} (${Math.round(Number(raw?.confidence || 0) * 100)}% confidence).`,
    result.evidence_summary,
    result.sources.length ? `Sources: ${result.sources.map(s => `${s.type}: ${s.url} — ${s.evidence}`).join(' | ')}` : ''
  ].filter(Boolean).join('\n').slice(0, 5000)

  // If the model claims Open Now without the core evidence, fail safe to Unknown.
  const safeOpen = result.application_status === 'Open Now' &&
    Number(raw?.confidence || 0) >= 0.80 &&
    asString(raw?.intake_year || String(TARGET_YEAR)) === String(TARGET_YEAR) &&
    raw?.exact_role_found !== false &&
    raw?.direct_application_for_exact_role_found !== false &&
    !!result.application_link
  if (result.application_status === 'Open Now' && !safeOpen) result.application_status = 'Unknown'

  return result
}

function rolePrompt(role) {
  const urls = [...new Set([role.application_link, role.careers_page, role.source_url].map(asUrl).filter(Boolean))]
  return [
    `Current date: ${TODAY}`,
    `Target placement start year: ${TARGET_YEAR}`,
    '',
    `Company: ${role.company || ''}`,
    `Tracked role: ${role.specific_role || ''}`,
    `Location: ${[role.city, role.country].filter(Boolean).join(', ')}`,
    `Department: ${role.department || ''}`,
    `Engineering area: ${role.engineering_area || ''}`,
    `Existing status (not authoritative): ${role.application_status || ''}`,
    '',
    'Known URLs:',
    urls.length ? urls.map(url => `- ${url}`).join('\n') : '- none',
    '',
    'Independently research this exact role and return a complete, field-by-field record. Re-check every material fact, including status, dates, eligibility, salary, role details, application link, and all priority/fit attributes. Use the existing values only as clues; do not blindly copy them.'
  ].join('\n')
}

async function verifyRole(role) {
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
        max_output_tokens: 2600,
        text: { format: { type: 'json_schema', name: 'azure_full_placement_record', strict: true, schema } }
      })
    })

    const body = await response.json()
    if (!response.ok) throw new Error(body?.error?.message || `Azure HTTP ${response.status}`)
    if (!body?.output_text) throw new Error('Azure returned no output_text')
    let parsed
    try { parsed = JSON.parse(body.output_text) } catch { throw new Error('Azure returned invalid JSON') }
    return { ok: true, result: normalise(parsed, role) }
  } finally {
    clearTimeout(timer)
  }
}

async function updateRole(role, result) {
  const update = { updated_at: new Date().toISOString() }

  // Refresh all non-user-managed fields. Empty AI values do not erase existing data;
  // this prevents a transient search failure from destroying previously verified facts.
  const fields = Object.keys(schema.properties)
  for (const field of fields) {
    if (USER_MANAGED.has(field)) continue
    if (field === 'confidence' || field === 'evidence_summary' || field === 'sources') continue
    const value = result[field]
    if (typeof value === 'string') {
      if (value.trim() !== '' || field === 'application_status' || field === 'start_year') update[field] = value
    } else if (typeof value === 'number') {
      update[field] = value
    }
  }

  // Never clobber the user's application-management status by replacing it with availability state.
  // application_status is the vacancy's availability state; app_status is user's tracking state.
  // Keep app_status untouched.

  update.source_date_checked = TODAY
  update.source_verified = result.source_verified
  update.start_year = TARGET_YEAR

  // Store evidence in source_verified, not notes, so user notes remain untouched.
  const { error } = await supabase.from('placements').update(update).eq('id', role.id)
  if (error) throw error
}

function completeness(result) {
  const keys = Object.keys(schema.properties).filter(key => !['confidence', 'evidence_summary', 'sources'].includes(key))
  return keys.filter(key => {
    const value = result[key]
    return value !== '' && value !== null && value !== undefined
  }).length
}

async function main() {
  const { data: roles, error } = await supabase.from('placements').select('*').order('company', { ascending: true })
  if (error) throw error

  console.log(`Azure-only full enrichment audit: ${roles?.length ?? 0} rows loaded.`)

  let cursor = 0
  let changed = 0
  let open = 0
  let enriched = 0
  let errors = 0
  let skipped = 0
  let incomplete = 0

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

        const beforeStatus = String(role.application_status ?? '')
        const result = verification.result
        await updateRole(role, result)

        const afterStatus = result.application_status
        if (afterStatus === 'Open Now') open++
        if (afterStatus !== beforeStatus) changed++
        if (completeness(result) >= 30) enriched++
        else incomplete++

        console.log(`${role.company} — ${role.specific_role ?? 'role'}: ${afterStatus}; enriched fields=${completeness(result)}`)
      } catch (error) {
        errors++
        console.error(`${role.company} — ${role.specific_role ?? 'role'}: ${error?.message ?? error}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, roles?.length ?? 0) }, worker))

  const { data: checkedRows, error: checkError } = await supabase
    .from('placements')
    .select('id,company,specific_role,application_status,start_year,source_date_checked,source_verified,cv_fit,aerospace_relevance,rocket_space_relevance,f1_motorsport_relevance,aero_cfd_relevance,propulsion_relevance,controls_avionics_relevance,prestige,career_value,overall_priority,why_it_fits,potential_weaknesses')
    .eq('source_date_checked', TODAY)
  if (checkError) throw checkError

  const missingPriority = (checkedRows ?? []).filter(row =>
    PRIORITY_FIELDS.some(field => row[field] === null || row[field] === undefined) ||
    !row.overall_priority || !row.why_it_fits || !row.potential_weaknesses
  ).length

  console.log(`Azure-only audit complete: ${open} open, ${changed} status changes, ${enriched} well-enriched, ${incomplete} with material missing fields, ${skipped} skipped, ${errors} errors.`)
  console.log(`QC: ${checkedRows?.length ?? 0} rows checked today; ${missingPriority} rows still missing one or more priority/fit fields.`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
