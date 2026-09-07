// Gemini — the PRIMARY verification provider.
//
// Two things make this more accurate than the Azure-only pipeline it replaces:
//
//  1. It is given the tracker's own deterministic evidence (the employer's live
//     applicant-tracking listing, the fetched vacancy text, dead links) *before*
//     it reasons, instead of being asked to rediscover all of it through search.
//     A model that can read the actual posting stops guessing.
//
//  2. Research and extraction are separated. The grounded pass may use Google
//     Search and URL context and answers in prose, so it is never forced to
//     compress a judgement into a schema mid-reasoning; a second, tool-free pass
//     converts that prose into the strict record. Both passes run at temperature
//     0, and the extraction pass is told it may not add anything the research
//     pass did not establish.
//
// The model is resolved at runtime from the API's own model list, so a
// deprecation (Gemini model IDs turn over every few months) degrades to the next
// best available model instead of failing the nightly run. GEMINI_MODEL pins it.

import { buildSchema, normaliseRecord } from './record.mjs'
import { describeEvidence, evidencePageText, TARGET_INTAKE } from './evidence.mjs'

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta'

const env = name => (process.env[name] || '').trim().replace(/^['"]|['"]$/g, '')

export const geminiApiKey = env('GEMINI_API_KEY') || env('GOOGLE_API_KEY')
export const geminiModelOverride = env('GEMINI_MODEL')

const RESEARCH_TIMEOUT_MS = 180000
const EXTRACT_TIMEOUT_MS = 90000
const MAX_ATTEMPTS = 3
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/** Ranks a model id: capability tier first (accuracy is the point), then version. */
function rankModel(id) {
  const name = id.replace(/^models\//, '')
  if (!/^gemini-/.test(name)) return null
  // Anything that is not a general text model, or is explicitly experimental.
  if (/embedding|aqa|tts|image|video|audio|live|native-audio|imagen|veo|learnlm|gemma/.test(name)) return null
  if (/-exp\b|-experimental/.test(name)) return null

  const version = Number((name.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0)
  if (!version) return null

  const tier = /flash-lite/.test(name) ? 1 : /flash/.test(name) ? 2 : /pro/.test(name) ? 3 : 0
  if (!tier) return null

  // A preview build of the same tier ranks below its stable sibling.
  const stable = /preview|-rc|-latest/.test(name) ? 0 : 1
  return { name, tier, version, stable }
}

let resolvedModel = null

/**
 * Picks the strongest available model. Preference is capability tier (pro over
 * flash) then version, because a wrong availability call costs the user a role
 * and the run is only a few hundred requests a day.
 */
export async function resolveModel(apiKey = geminiApiKey) {
  if (geminiModelOverride) return geminiModelOverride
  if (resolvedModel) return resolvedModel

  try {
    const response = await fetch(`${API_ROOT}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(30000),
    })
    if (response.ok) {
      const body = await response.json()
      const usable = (body?.models ?? [])
        .filter(model => (model?.supportedGenerationMethods ?? []).includes('generateContent'))
        .map(model => rankModel(String(model?.name ?? '')))
        .filter(Boolean)
        .sort((a, b) => b.tier - a.tier || b.version - a.version || b.stable - a.stable)
      if (usable.length) {
        resolvedModel = usable[0].name
        console.log(`Gemini model resolved from the API model list: ${resolvedModel}`)
        return resolvedModel
      }
    }
    console.warn(`Gemini model list unavailable (HTTP ${response.status}); falling back to gemini-2.5-pro.`)
  } catch (error) {
    console.warn(`Gemini model list could not be read (${error?.message ?? error}); falling back to gemini-2.5-pro.`)
  }
  resolvedModel = 'gemini-2.5-pro'
  return resolvedModel
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const RESEARCH_SYSTEM = [
  'You are the availability analyst for a UK engineering student\'s placement tracker.',
  `The tracker follows ONLY opportunities whose placement, internship or industrial placement STARTS IN ${TARGET_INTAKE}.`,
  '',
  'YOUR JOB',
  'Establish, for the ONE exact role you are given, whether a student can submit an application for it TODAY.',
  'You are given deterministic evidence the tracker collected itself: the employer\'s live applicant-tracking-system listing, the text of the fetched pages, and any tracked link that is dead. That evidence is fact. Search only to fill the gaps in it, and to check the employer\'s own student/early-careers pages and applicant tracking system.',
  '',
  'THE TWO MISTAKES THAT MATTER',
  'A wrong "open" wastes an afternoon. A wrong "not open" loses the placement entirely, and this tracker has been making the second mistake far too often. So:',
  '- If the exact role is listed live on the employer\'s own applicant tracking system, applications ARE open. Say so. Do not withhold that because the listing does not print an intake year.',
  '- Most genuine postings never print a year. A live student placement posting with no year is the current cycle, because employers remove listings once a cycle closes. Report intake_year 0 and intake_2027_consistent true rather than pretending the intake is unknown or wrong.',
  '- Only report a different intake year when the posting positively names one (e.g. "2026 intake, starting September 2026").',
  '',
  'HARD RULES',
  `A closed or expired ${Number(TARGET_INTAKE) - 1} intake is NEVER evidence that the ${TARGET_INTAKE} intake is closed.`,
  'The application OPENING date is not the placement START date. A September 2027 start does not mean applications open in September 2026.',
  'A reachable page, a generic careers page, or a generic Apply/Search-jobs button is not evidence that this role is open.',
  'Verify THIS role at THIS employer, never a sibling role.',
  'Student opportunities only: industrial placement, year in industry, sandwich placement, internship, co-op, undergraduate placement, spring week. Graduate schemes, experienced-hire vacancies and non-degree apprenticeships are out of scope.',
  '',
  'DATES — THIS DRIVES AN AUTOMATION',
  'If the employer states the day applications open ("applications open on 6 October 2026", "the 2027 campaign goes live 1 November"), report that exact date. The tracker flips the role to open automatically on that day, so a wrong or invented date is actively harmful, and a real one that you omit means a missed placement.',
  'Report dates in ISO format, YYYY-MM-DD, when you know the day. If you only know the month, write the month and year. If the employer has published nothing, say so — never guess.',
  '',
  'ANSWER FORMAT',
  'Write a short, factual brief covering: the exact role and where you found it; whether an application can be submitted today and by what route (give the URL); the intake year, and whether anything contradicts a 2027 start; the published opening date and deadline, if any; eligibility for a UK citizen; location, duration, salary; and how confident you are, with the reason. Cite the URL behind each claim. State plainly where the evidence is thin.',
].join('\n')

const EXTRACT_SYSTEM = [
  'You convert a research brief into one strict JSON record. You have no tools and no knowledge of your own to add here.',
  'Use ONLY what the brief and the deterministic evidence establish. Every field the brief does not establish must be an empty string, and no date, link, salary or requirement may be invented.',
  '',
  'FIELD MEANINGS THAT ARE EASY TO GET WRONG',
  'application_status — "Open Now" only if an application can be submitted today for this exact role; "Opening Soon" if the intake is confirmed and a published opening date has not yet arrived; "Expected" if the intake is confirmed with no opening details; "Not Yet Published" if the programme exists but this intake is not published; "Closed" only if this exact 2027 intake has itself closed; "Unknown" if the brief is genuinely inconclusive.',
  'intake_year — the placement START year the posting names, as an integer. Use 0 when the posting does not state one. Do NOT guess 2027.',
  'intake_2027_consistent — true when nothing in the evidence contradicts a 2027 start (a live student posting with no stated year is consistent). False only when the evidence points at a different intake.',
  'exact_role_found — true when the exact tracked role was located on an employer or ATS source.',
  'direct_application_for_exact_role_found — true when the actual application route for THIS role was found, not a generic Apply button.',
  'official_source_found — true when an employer or ATS source (not only an aggregator) was used.',
  'opening_date_is_announced — true ONLY when the employer has published the specific day applications open for this intake.',
  'exact_opening_date / exact_deadline — ISO YYYY-MM-DD when the day is known; otherwise "Month YYYY"; otherwise an empty string. Never prose like "not published" — an empty string says that already.',
  'confidence — your confidence in application_status, 0 to 1.',
  '',
  'SCORING (0-10, for THIS user: a UK undergraduate engineer targeting aerospace, space and rocketry, Formula 1 and motorsport, aerodynamics/CFD, propulsion, and controls/avionics)',
  'cv_fit: how well this exact role matches that profile. The six relevance scores: how strongly the role sits in each domain, scored independently — a pure F1 aerodynamics role scores 10 on F1 and on aero/CFD and low on rocket/space. prestige: standing of the employer in engineering. career_value: what this does for the user\'s career.',
  'why_it_fits and potential_weaknesses must be specific to this role. Never reuse generic text.',
  '',
  'ELIGIBILITY',
  'The user is a UK passport holder, so UK right-to-work is not a blocker for UK roles. For non-UK roles, and especially US roles, state in work_eligibility whether a UK citizen may actually apply (sponsorship, US-person requirements, ITAR/EAR export control, security clearance). Silence is not evidence of eligibility.',
].join('\n')

function rolePrompt(role, evidence, verdict) {
  return [
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    `Target placement start year: ${TARGET_INTAKE}`,
    '',
    `Employer: ${role.company}`,
    `Tracked role title: ${role.specific_role}`,
    `Tracked location (not authoritative): ${[role.city, role.country].filter(Boolean).join(', ') || 'unknown'}`,
    `Tracked opportunity type (not authoritative): ${role.opportunity_type || 'unknown'}`,
    `Currently stored status (a claim to check, NOT a fact): ${role.application_status || 'unknown'}`,
    `Currently stored opening date: ${role.exact_opening_date || 'none'}`,
    `Currently stored deadline: ${role.exact_deadline || 'none'}`,
    '',
    'Tracked URLs:',
    [role.application_link, role.careers_page].filter(Boolean).map(url => `- ${url}`).join('\n') || '- none',
    '',
    describeEvidence(evidence, verdict),
    '',
    'FETCHED PAGE TEXT (already retrieved for you):',
    evidencePageText(evidence) || '(no page text could be retrieved)',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function callGemini(model, body, timeoutMs, apiKey) {
  let lastError = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      })
      const parsed = await response.json().catch(() => null)

      if (!response.ok) {
        const message = parsed?.error?.message || `Gemini HTTP ${response.status}`
        if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
          // Free and shared tiers rate-limit hard; back off rather than losing the row.
          const backoff = 4000 * 2 ** (attempt - 1)
          console.warn(`  gemini retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff}ms — ${message}`)
          await sleep(backoff)
          lastError = message
          continue
        }
        const error = new Error(message)
        error.status = response.status
        throw error
      }

      const candidate = parsed?.candidates?.[0]
      const text = (candidate?.content?.parts ?? [])
        .map(part => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim()

      if (!text) {
        const blocked = parsed?.promptFeedback?.blockReason || candidate?.finishReason
        throw new Error(`Gemini returned no text${blocked ? ` (${blocked})` : ''}`)
      }
      return { text, grounding: candidate?.groundingMetadata ?? null }
    } catch (error) {
      lastError = error?.message ?? String(error)
      const transient = error?.name === 'AbortError' || /fetch failed|network|ECONN|socket|terminated/i.test(lastError)
      if (transient && attempt < MAX_ATTEMPTS) {
        const backoff = 4000 * 2 ** (attempt - 1)
        console.warn(`  gemini retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff}ms — ${lastError}`)
        await sleep(backoff)
        continue
      }
      throw error instanceof Error ? error : new Error(lastError)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(lastError || 'Gemini call failed')
}

/**
 * Pass 1: grounded research. `url_context` lets the model read the tracked links
 * directly; not every model exposes it, so a rejection retries with search alone
 * rather than failing the row.
 */
async function research(model, prompt, apiKey) {
  const base = {
    systemInstruction: { parts: [{ text: RESEARCH_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 4096 },
  }

  try {
    return await callGemini(model, { ...base, tools: [{ google_search: {} }, { url_context: {} }] }, RESEARCH_TIMEOUT_MS, apiKey)
  } catch (error) {
    const message = error?.message ?? ''
    if (error?.status === 400 && /url_context|tool|unsupported|unknown name/i.test(message)) {
      console.warn('  gemini: url_context not supported by this model — retrying with Google Search only.')
      return callGemini(model, { ...base, tools: [{ google_search: {} }] }, RESEARCH_TIMEOUT_MS, apiKey)
    }
    throw error
  }
}

/** Pass 2: tool-free extraction into the shared strict record schema. */
async function extract(model, brief, prompt, apiKey) {
  const body = {
    systemInstruction: { parts: [{ text: EXTRACT_SYSTEM }] },
    contents: [{
      role: 'user',
      parts: [{
        text: [
          prompt,
          '',
          '=== RESEARCH BRIEF TO CONVERT ===',
          brief,
          '',
          'Return the JSON record for this role.',
        ].join('\n'),
      }],
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: buildSchema(),
    },
  }
  const { text } = await callGemini(model, body, EXTRACT_TIMEOUT_MS, apiKey)
  try {
    return JSON.parse(text)
  } catch {
    // A model occasionally wraps JSON in a fence despite the mime type.
    const fenced = text.match(/\{[\s\S]*\}/)
    if (!fenced) throw new Error('Gemini returned invalid JSON')
    return JSON.parse(fenced[0])
  }
}

/** Citations from the grounded pass, appended to the stored evidence trail. */
function groundingSources(grounding) {
  const chunks = grounding?.groundingChunks ?? []
  return chunks
    .map(chunk => chunk?.web?.uri || '')
    .filter(Boolean)
    .slice(0, 8)
}

/**
 * Verifies one role. Returns `{ ok, record, judgement, brief, error }`.
 * A failure never mutates anything — the caller keeps the stored values.
 */
export async function verifyWithGemini(role, evidence, verdict, apiKey = geminiApiKey) {
  if (!apiKey) return { ok: false, provider: 'Gemini', error: 'GEMINI_API_KEY is not set' }

  try {
    const model = await resolveModel(apiKey)
    const prompt = rolePrompt(role, evidence, verdict)
    const { text: brief, grounding } = await research(model, prompt, apiKey)
    const raw = await extract(model, brief, prompt, apiKey)
    const { record, judgement } = normaliseRecord(raw, 'Gemini')

    const cited = groundingSources(grounding)
    if (cited.length) {
      judgement.sources = [
        ...judgement.sources,
        ...cited
          .filter(url => !judgement.sources.some(source => source.url === url))
          .map(url => ({ url, type: 'search', evidence: 'Cited by Gemini grounded search' })),
      ].slice(0, 10)
    }

    return { ok: true, provider: 'Gemini', model, record, judgement, brief }
  } catch (error) {
    return { ok: false, provider: 'Gemini', error: error?.message ?? String(error) }
  }
}
