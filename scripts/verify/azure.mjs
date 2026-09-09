// Azure OpenAI — the SECONDARY verification provider.
//
// Azure used to be the whole pipeline. It is now the second opinion, and it is
// asked for one deliberately: it runs on the decisions that cost the user
// something — opening a role that is not open, closing one that is, and any
// low-confidence answer that would change a status the user acts on. See
// `needsSecondOpinion` in ./record.mjs for exactly when.
//
// It receives the same deterministic evidence and the same record schema as the
// primary, so the two answers are directly comparable and neither can quietly
// win on formatting differences alone.

import { buildSchema, normaliseRecord } from './record.mjs'
import { describeEvidence, evidencePageText, TARGET_INTAKE } from './evidence.mjs'

const env = name => (process.env[name] || '').trim().replace(/^['"]|['"]$/g, '')

export const azureApiKey = env('AZURE_OPENAI_API_KEY')
export const azureEndpoint = env('AZURE_OPENAI_ENDPOINT').replace(/\/+$/, '')
export const azureDeployment = env('AZURE_OPENAI_DEPLOYMENT_NAME')

const REQUEST_TIMEOUT_MS = 180000
const MAX_ATTEMPTS = 3
const MAX_WEB_SEARCHES = 12
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const INSTRUCTIONS = [
  'You are the independent second opinion on one tracked student opportunity for a UK engineering student\'s placement tracker.',
  `The tracker follows ONLY opportunities whose placement or internship STARTS IN ${TARGET_INTAKE}.`,
  '',
  'Another verifier has already answered. You are not shown its answer, deliberately — reach your own conclusion from the evidence and your own searches so the two can be compared honestly.',
  '',
  'RESEARCH',
  `Use up to ${MAX_WEB_SEARCHES} web searches. Start with the employer plus the exact role title, then the employer's official student/early-careers pages, then its applicant tracking system (Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Taleo, SuccessFactors). Do not stop at a generic careers homepage.`,
  'The deterministic evidence below was collected by the tracker itself and is fact. Prefer official employer and ATS sources over aggregators such as Gradcracker or Trackr.',
  '',
  'STATUS',
  'Open Now: an application can be submitted TODAY for this exact role, by a route you found.',
  'Opening Soon: the intake is confirmed and a published opening date has not yet arrived.',
  'Expected: the intake is confirmed but no opening details are published.',
  'Not Yet Published: the programme exists but this intake is not published.',
  'Closed: reliable evidence that this exact 2027 intake has closed, filled or passed its deadline.',
  'Unknown: the evidence is genuinely inconclusive.',
  '',
  'HARD RULES',
  `A closed or expired ${Number(TARGET_INTAKE) - 1} intake is NEVER evidence that the ${TARGET_INTAKE} intake is closed.`,
  'The application OPENING date is not the placement START date.',
  'A reachable page, a generic careers page, or a generic Apply/Search-jobs button is not evidence that applications are open.',
  'If the exact role is live on the employer\'s own applicant tracking system, applications are open — report that, even when the listing does not print an intake year.',
  'Most postings never print the intake year. Report intake_year 0 with intake_2027_consistent true when the posting states no year and nothing contradicts a 2027 start. Name a different year ONLY when the posting positively states one.',
  'Student opportunities only. Graduate schemes, experienced-hire vacancies and non-degree apprenticeships are out of scope: classify them Other Student Programme with a low cv_fit and say so.',
  '',
  'DATES',
  'If the employer states the day applications open, report it as ISO YYYY-MM-DD and set opening_date_is_announced true — the tracker opens the role automatically on that day, so an invented date is harmful. Month-only knowledge goes in as "Month YYYY". Publish nothing where the employer published nothing: use an empty string, never prose.',
  '',
  'ELIGIBILITY',
  'The user is a UK passport holder studying engineering, so UK right-to-work is not a blocker for UK roles. For non-UK and especially US roles, verify explicitly whether a UK citizen may apply (sponsorship, US-person requirements, ITAR/EAR export controls, security clearance) and summarise it in work_eligibility. Silence is not evidence of eligibility.',
  '',
  'SCORING (0-10, judged for THIS user: a UK undergraduate engineer targeting aerospace, space and rocketry, Formula 1 and motorsport, aerodynamics/CFD, propulsion, and controls/avionics)',
  'cv_fit: how well this exact role matches that profile. The six relevance scores are judged independently — a pure F1 aerodynamics role scores 10 on F1 and aero/CFD and low on rocket/space. prestige: standing of the employer in engineering. career_value: what the placement does for the user\'s career. Give role-specific why_it_fits and potential_weaknesses; never reuse generic text.',
  '',
  'OUTPUT',
  'Return every field. Use an empty string for anything you could not establish — never invent a date, salary, link or requirement.',
].join('\n')

function rolePrompt(role, evidence, verdict) {
  return [
    `Current date: ${new Date().toISOString().slice(0, 10)}`,
    `Target placement start year: ${TARGET_INTAKE}`,
    '',
    `Company: ${role.company}`,
    `Tracked role title: ${role.specific_role}`,
    `Tracked location (not authoritative): ${[role.city, role.country].filter(Boolean).join(', ') || 'unknown'}`,
    `Tracked opportunity type (not authoritative): ${role.opportunity_type || 'unknown'}`,
    `Tracked status (not authoritative): ${role.application_status || 'unknown'}`,
    '',
    'Known URLs:',
    [role.application_link, role.careers_page].filter(Boolean).map(url => `- ${url}`).join('\n') || '- none',
    '',
    describeEvidence(evidence, verdict),
    '',
    'FETCHED PAGE TEXT (already retrieved for you):',
    evidencePageText(evidence) || '(no page text could be retrieved)',
    '',
    `Verify this exact opportunity and return the complete record. Decide whether applications are open RIGHT NOW for the exact ${TARGET_INTAKE} opportunity, not merely whether the employer is recruiting.`,
  ].join('\n')
}

/** One Azure call, with bounded retries for rate limits and transient failures. */
export async function verifyWithAzure(role, evidence, verdict) {
  if (!azureApiKey || !azureEndpoint || !azureDeployment) {
    return { ok: false, provider: 'Azure', error: 'AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_DEPLOYMENT_NAME are not all set' }
  }

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
            { role: 'developer', content: [{ type: 'input_text', text: INSTRUCTIONS }] },
            { role: 'user', content: [{ type: 'input_text', text: rolePrompt(role, evidence, verdict) }] },
          ],
          tools: [{ type: 'web_search' }],
          max_tool_calls: MAX_WEB_SEARCHES,
          max_output_tokens: 3200,
          text: { format: { type: 'json_schema', name: 'placement_record', strict: true, schema: buildSchema() } },
        }),
      })

      const body = await response.json().catch(() => null)
      if (!response.ok) {
        const message = body?.error?.message || `Azure HTTP ${response.status}`
        if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
          const backoff = 2000 * 2 ** (attempt - 1)
          console.warn(`  azure retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff}ms — ${message}`)
          await sleep(backoff)
          lastError = message
          continue
        }
        throw new Error(message)
      }
      if (!body?.output_text) throw new Error('Azure returned no output_text')

      const { record, judgement } = normaliseRecord(JSON.parse(body.output_text), 'Azure')
      return { ok: true, provider: 'Azure', model: azureDeployment, record, judgement }
    } catch (error) {
      lastError = error?.message ?? String(error)
      const transient = error?.name === 'AbortError' || /fetch failed|network|ECONN|socket|terminated/i.test(lastError)
      if (transient && attempt < MAX_ATTEMPTS) {
        const backoff = 2000 * 2 ** (attempt - 1)
        console.warn(`  azure retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff}ms — ${lastError}`)
        await sleep(backoff)
        continue
      }
      return { ok: false, provider: 'Azure', error: lastError }
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, provider: 'Azure', error: lastError ?? 'Azure verification failed' }
}

export const azureConfigured = Boolean(azureApiKey && azureEndpoint && azureDeployment)

/** One cheap probe of the Azure deployment, used by `npm run check:providers`. */
export async function pingAzure() {
  if (!azureConfigured) return { ok: false, error: 'AZURE_OPENAI_* are not all set' }
  try {
    const response = await fetch(`${azureEndpoint}/openai/v1/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', 'api-key': azureApiKey },
      body: JSON.stringify({
        model: azureDeployment,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with the single word: ready' }] }],
        max_output_tokens: 32,
      }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(body?.error?.message || `Azure HTTP ${response.status}`)
    return { ok: true, deployment: azureDeployment, reply: String(body?.output_text ?? '').trim().slice(0, 40) }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}
