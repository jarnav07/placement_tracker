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
// The model is resolved at runtime rather than hardcoded, so a deprecation
// (Gemini model IDs turn over every few months) degrades to the next best
// available model instead of failing the nightly run. GEMINI_MODEL pins it.

import { buildSchema, normaliseRecord } from './record.mjs'
import { describeEvidence, evidencePageText, TARGET_INTAKE } from './evidence.mjs'

const env = name => (process.env[name] || '').trim().replace(/^['"]|['"]$/g, '')

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------
//
// The same Gemini models are reachable two ways, and the request body is
// identical for both. Only the URL and how the key travels differ.
//
//   vertex    Vertex AI in express mode. A Vertex API key against the global
//             endpoint, which takes no project or location in the path.
//             POST https://aiplatform.googleapis.com/v1beta1/publishers/google/models/MODEL:generateContent
//
//   aistudio  The Gemini Developer API (AI Studio key).
//             POST https://generativelanguage.googleapis.com/v1beta/models/MODEL:generateContent
//
// Both carry the key in an `x-goog-api-key` header. That is not a guess: it is
// exactly what Google's own @google/genai SDK builds for each case (its "Vertex
// Express or global endpoint" branch, at API version v1beta1). Keeping the key
// in a header rather than a `?key=` query parameter also keeps it out of any URL
// that might reach a log.
//
// Vertex is not the same product as a plain Google Cloud project: EXPRESS MODE is
// what makes an API key sufficient. `aiplatform.googleapis.com` rejects API keys
// outright for projects without it, with "API keys are not supported by this
// API". A standard project endpoint (LOCATION-aiplatform.googleapis.com/v1/
// projects/…) needs an OAuth token from service-account credentials, which an API
// key cannot provide — so if project details are configured, `describeBackend`
// says plainly that they are not used, and `npm run check:providers` reports
// which backend actually works before a nightly run depends on it.

const VERTEX_ROOT = 'https://aiplatform.googleapis.com/v1beta1'
const AISTUDIO_ROOT = 'https://generativelanguage.googleapis.com/v1beta'

const vertexKey = env('VERTEX_API_KEY') || env('GOOGLE_VERTEX_API_KEY') || env('GOOGLE_CLOUD_API_KEY')
const studioKey = env('GEMINI_API_KEY') || env('GOOGLE_API_KEY')

/** Explicit wins; otherwise whichever key is present, preferring Vertex. */
function chooseBackend() {
  const explicit = env('GEMINI_BACKEND').toLowerCase()
  if (explicit === 'vertex' || explicit === 'aistudio') return explicit
  // Google's own SDK convention, honoured so a familiar setting does what it says.
  if (env('GOOGLE_GENAI_USE_VERTEXAI').toLowerCase() === 'true') return 'vertex'
  if (vertexKey) return 'vertex'
  if (studioKey) return 'aistudio'
  return 'none'
}

const BACKEND = chooseBackend()

const BACKENDS = {
  vertex: {
    label: 'Vertex AI (express mode)',
    key: vertexKey,
    generateUrl: model => `${VERTEX_ROOT}/publishers/google/models/${encodeURIComponent(model)}:generateContent`,
    listUrl: () => `${VERTEX_ROOT}/publishers/google/models`,
    headers: () => ({ 'x-goog-api-key': vertexKey }),
  },
  aistudio: {
    label: 'Gemini API (AI Studio)',
    key: studioKey,
    generateUrl: model => `${AISTUDIO_ROOT}/models/${encodeURIComponent(model)}:generateContent`,
    listUrl: () => `${AISTUDIO_ROOT}/models?pageSize=200`,
    headers: () => ({ 'x-goog-api-key': studioKey }),
  },
}

const backend = BACKENDS[BACKEND] ?? null

export const geminiConfigured = Boolean(backend?.key)
export const geminiBackend = BACKEND
export const geminiModelOverride = env('GEMINI_MODEL')

/** One line for logs and for `npm run check:providers`. Never prints the key. */
export function describeBackend() {
  if (!geminiConfigured) {
    return 'Gemini: not configured (set VERTEX_API_KEY for Vertex AI, or GEMINI_API_KEY for AI Studio)'
  }
  const notes = []
  if (BACKEND === 'vertex' && (env('VERTEX_PROJECT_ID') || env('GOOGLE_CLOUD_PROJECT'))) {
    notes.push('a project id is set but unused — express mode takes no project or location,'
      + ' and a project-scoped Vertex endpoint would need OAuth credentials rather than an API key')
  }
  if (vertexKey && studioKey) {
    notes.push(`both keys are set; using ${BACKENDS[BACKEND].label}. Set GEMINI_BACKEND to choose explicitly`)
  }
  return `Gemini: ${backend.label}${geminiModelOverride ? `, model pinned to ${geminiModelOverride}` : ''}`
    + (notes.length ? ` (${notes.join('; ')})` : '')
}

/**
 * Turns the API's own error into something actionable.
 *
 * The message that matters most is Vertex's "API keys are not supported by this
 * API": it does NOT mean the key is malformed, it means the key's project has no
 * express mode, so aiplatform.googleapis.com will not accept an API key from it
 * at all. Without this note that error reads like a bad key and sends you off to
 * regenerate a perfectly good one.
 */
export function explainGeminiError(message = '') {
  if (/API keys are not supported by this API/i.test(message)) {
    return BACKEND === 'vertex'
      ? 'This key is not enabled for Vertex AI in express mode. Express mode is what lets Vertex accept'
        + ' an API key at all — a plain Google Cloud API key is refused here even with the Vertex AI API'
        + ' enabled. Either enable express mode for the project and use the key it issues, or switch to an'
        + ' AI Studio key in GEMINI_API_KEY (the same models, keyed differently).'
      : 'This endpoint refused API-key authentication, which usually means the wrong backend is selected.'
  }
  if (/API key not valid/i.test(message)) {
    return BACKEND === 'vertex'
      ? 'The key was rejected. An AI Studio key placed in VERTEX_API_KEY produces this — put it in GEMINI_API_KEY instead.'
      : 'The key was rejected. Check it at https://aistudio.google.com/apikey, or set VERTEX_API_KEY if it is a Vertex key.'
  }
  if (/quota|rate limit|RESOURCE_EXHAUSTED/i.test(message)) {
    return 'Quota exhausted for this key. Raise the quota, or pin a cheaper model with GEMINI_MODEL (e.g. gemini-2.5-flash).'
  }
  if (/permission|PERMISSION_DENIED|has not been used|is disabled/i.test(message)) {
    return 'The API is not enabled for this key\'s project, or the key is restricted. Check the key\'s API restrictions.'
  }
  if (MODEL_MISSING_RE.test(message)) {
    return 'That model is not available on this backend. Pin a current one with the GEMINI_MODEL variable.'
  }
  return ''
}

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
  // AI Studio returns "models/gemini-2.5-pro"; Vertex returns
  // "publishers/google/models/gemini-2.5-pro".
  const name = id.replace(/^.*models\//, '')
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

/**
 * Tried in order when the backend exposes no model list — which is the normal
 * case for Vertex AI express mode. Documented as supporting Google Search
 * grounding, strongest first. A model that has been retired answers 404 and the
 * next one is tried, so a deprecation costs one wasted request, not the run.
 *
 * This list is a floor, not a ceiling: pin a newer model with GEMINI_MODEL and
 * nothing here is consulted at all.
 */
const MODEL_CANDIDATES = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite']

let resolvedModel = null
let candidateCursor = 0

/**
 * Picks the strongest available model. Preference is capability tier (pro over
 * flash) then version, because a wrong availability call costs the user a role
 * and the run is only a few hundred requests a day.
 *
 * AI Studio publishes a model list, so it is used. Vertex express mode does not
 * reliably expose one — the call is still attempted, and the candidate list is
 * the fallback.
 */
export async function resolveModel() {
  if (geminiModelOverride) return geminiModelOverride
  if (resolvedModel) return resolvedModel
  if (!backend) throw new Error('No Gemini backend configured')

  try {
    const response = await fetch(backend.listUrl(), {
      headers: backend.headers(),
      signal: AbortSignal.timeout(30000),
    })
    if (response.ok) {
      const body = await response.json()
      const listed = body?.models ?? body?.publisherModels ?? []
      const usable = listed
        // AI Studio reports which methods a model supports; Vertex does not, so
        // absence of the field is not a reason to discard a model.
        .filter(model => {
          const methods = model?.supportedGenerationMethods
          return !Array.isArray(methods) || methods.includes('generateContent')
        })
        .map(model => rankModel(String(model?.name ?? model?.versionId ?? '')))
        .filter(Boolean)
        .sort((a, b) => b.tier - a.tier || b.version - a.version || b.stable - a.stable)
      if (usable.length) {
        resolvedModel = usable[0].name
        console.log(`Gemini model resolved from the ${backend.label} model list: ${resolvedModel}`)
        return resolvedModel
      }
    }
    console.log(`${backend.label} publishes no usable model list (HTTP ${response.status});`
      + ` trying known models in order, starting with ${MODEL_CANDIDATES[0]}.`)
  } catch (error) {
    console.warn(`Could not read the ${backend.label} model list (${error?.message ?? error});`
      + ` trying known models in order, starting with ${MODEL_CANDIDATES[0]}.`)
  }
  resolvedModel = MODEL_CANDIDATES[candidateCursor]
  return resolvedModel
}

/**
 * Called when a model answers "not found". Advances to the next candidate and
 * reports whether one was left, so a retired model degrades the run instead of
 * ending it.
 */
function demoteModel(model) {
  if (geminiModelOverride) return null
  const index = MODEL_CANDIDATES.indexOf(model)
  if (index === -1 || index + 1 >= MODEL_CANDIDATES.length) return null
  candidateCursor = index + 1
  resolvedModel = MODEL_CANDIDATES[candidateCursor]
  console.warn(`${model} is not available on this backend — falling back to ${resolvedModel} for the rest of the run.`)
  return resolvedModel
}

const MODEL_MISSING_RE = /not found|was not found|is not supported|does not exist|unsupported model|invalid model|no such model|not allowed to use/i

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

/**
 * Smallest thinking budget every Gemini 2.5 model accepts. Pro's floor is 128 and
 * it errors on 0; Flash allows 0 but is happy at 128.
 */
export const MIN_THINKING_BUDGET = 128

/** A model that rejects any thinking configuration at all. */
const THINKING_UNSUPPORTED_RE = /thinking[_ ]?budget|thinking[_ ]?config|does not support (setting )?thinking/i

async function callGemini(model, body, timeoutMs) {
  let lastError = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(backend.generateUrl(model), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...backend.headers() },
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
        // A retired or unavailable model: move to the next candidate and retry
        // once, so a deprecation costs one request rather than the whole run.
        if ((response.status === 404 || response.status === 400) && MODEL_MISSING_RE.test(message)) {
          const next = demoteModel(model)
          if (next) return callGemini(next, body, timeoutMs)
        }
        // Some models reject thinking configuration outright. The budget is an
        // optimisation, never a requirement, so drop it and try once more rather
        // than failing the row over it.
        if (response.status === 400 && THINKING_UNSUPPORTED_RE.test(message)
            && body?.generationConfig?.thinkingConfig) {
          const { thinkingConfig, ...generationConfig } = body.generationConfig
          console.warn(`  gemini: ${model} rejects thinkingConfig — retrying without it.`)
          return callGemini(model, { ...body, generationConfig }, timeoutMs)
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
      return {
        text,
        grounding: candidate?.groundingMetadata ?? null,
        finishReason: candidate?.finishReason ?? null,
      }
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
let urlContextSupported = true

async function research(model, prompt) {
  const base = {
    systemInstruction: { parts: [{ text: RESEARCH_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 4096 },
  }
  // `google_search` is the current tool name on both backends. (Older models
  // used `google_search_retrieval`; none of the models here need it.)
  const searchOnly = { ...base, tools: [{ google_search: {} }] }

  if (!urlContextSupported) return callGemini(model, searchOnly, RESEARCH_TIMEOUT_MS)

  try {
    return await callGemini(model, { ...base, tools: [{ google_search: {} }, { url_context: {} }] }, RESEARCH_TIMEOUT_MS)
  } catch (error) {
    const message = error?.message ?? ''
    if (error?.status === 400 && /url_context|tool|unsupported|unknown|not supported|invalid/i.test(message)) {
      // Remembered for the rest of the run: one probe per run, not per role.
      urlContextSupported = false
      console.warn(`  gemini: url_context is not available on ${backend.label} for this model`
        + ' — continuing with Google Search grounding alone for the rest of the run.')
      return callGemini(model, searchOnly, RESEARCH_TIMEOUT_MS)
    }
    throw error
  }
}

/** Pass 2: tool-free extraction into the shared strict record schema. */
async function extract(model, brief, prompt) {
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
      // The reasoning happened in the grounded research pass; this call only has
      // to format that brief as JSON. Left unbounded, a 2.5 model spends the
      // whole budget thinking and is truncated before the object starts.
      // 128 is the floor Pro accepts and is within Flash's range; 0 is Flash-only
      // and Pro rejects the request. `callGemini` drops this entirely if a model
      // refuses it.
      thinkingConfig: { thinkingBudget: MIN_THINKING_BUDGET },
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: buildSchema(),
    },
  }
  const { text, finishReason } = await callGemini(model, body, EXTRACT_TIMEOUT_MS)
  return parseJsonLoose(text, finishReason)
}

/**
 * Parse a model's JSON answer, tolerating the wrappers models add even when
 * `responseMimeType: 'application/json'` and a `responseSchema` are set.
 *
 * Vertex AI express mode in particular treats the mime type as a hint: it will
 * happily answer `Here is the JSON: {...}` or fence the object in backticks.
 * Every call site must use this — a bare `JSON.parse` on a response that is
 * correct apart from a preamble reads as a broken provider.
 */
export function parseJsonLoose(text, finishReason = null) {
  const raw = String(text ?? '').trim()
  // MAX_TOKENS means the object was never finished, not that the model misbehaved.
  const truncated = finishReason === 'MAX_TOKENS' ? ' (response hit MAX_TOKENS — raise maxOutputTokens)' : ''
  if (!raw) throw new Error(`Gemini returned an empty response${truncated}`)
  try {
    return JSON.parse(raw)
  } catch {
    // Prefer a fenced block, then the outermost brace-delimited object.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const candidate = fenced ? fenced[1].trim() : null
    if (candidate) {
      try { return JSON.parse(candidate) } catch { /* fall through to brace scan */ }
    }
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end <= start) {
      throw new Error(`Gemini returned invalid JSON${truncated}: ${raw.slice(0, 80)}`)
    }
    return JSON.parse(raw.slice(start, end + 1))
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
export async function verifyWithGemini(role, evidence, verdict) {
  if (!geminiConfigured) {
    return {
      ok: false,
      provider: 'Gemini',
      error: 'no Gemini key configured — set VERTEX_API_KEY (Vertex AI) or GEMINI_API_KEY (AI Studio)',
    }
  }

  try {
    const model = await resolveModel()
    const prompt = rolePrompt(role, evidence, verdict)
    const { text: brief, grounding } = await research(model, prompt)
    const raw = await extract(model, brief, prompt)
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

/**
 * One cheap end-to-end probe of the configured backend, used by
 * `npm run check:providers`. It exercises the three things that actually break
 * when a key or a backend is wrong — authentication, the Google Search grounding
 * tool, and structured output — rather than only checking that a key is present.
 */
export async function pingGemini() {
  if (!geminiConfigured) {
    return { ok: false, backend: BACKEND, error: 'no Gemini key configured' }
  }

  const steps = []
  try {
    const model = await resolveModel()
    steps.push({ step: 'model', ok: true, detail: model })

    const grounded = await research(model, 'In one short sentence, what is an industrial placement in UK engineering?')
    steps.push({
      step: 'google_search grounding',
      ok: true,
      detail: urlContextSupported ? 'accepted, with url_context' : 'accepted, without url_context',
    })

    const structured = await callGemini(model, {
      contents: [{ role: 'user', parts: [{ text: `Summarise in one sentence: ${grounded.text.slice(0, 400)}` }] }],
      generationConfig: {
        temperature: 0,
        // Mirrors the extraction call: thinking held to the floor, and enough
        // room that reasoning cannot crowd out the object.
        thinkingConfig: { thinkingBudget: MIN_THINKING_BUDGET },
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      },
    }, EXTRACT_TIMEOUT_MS)
    // Parsed the same way the real extraction parses, so the probe cannot fail
    // over something verification would have handled.
    const parsed = parseJsonLoose(structured.text, structured.finishReason)
    steps.push({
      step: 'structured output',
      ok: true,
      detail: typeof parsed?.summary === 'string'
        ? 'responseSchema honoured'
        : 'JSON returned, but not matching the schema exactly',
    })

    return { ok: true, backend: BACKEND, model, steps }
  } catch (error) {
    return { ok: false, backend: BACKEND, error: error?.message ?? String(error), steps }
  }
}
