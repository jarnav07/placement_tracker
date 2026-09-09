// Deterministic, provider-independent evidence about one tracked role.
//
// This module answers a narrow, factual question without any model: is the EXACT
// tracked role present, right now, among the employer's live postings?
//
// It matters because it is the only part of the pipeline that cannot hallucinate
// and cannot be vague. An applicant tracking system that lists the role today is
// direct proof applications are open; a fully enumerated board that does not list
// it is proof they are not. Everything a model says is checked against this.
//
// Both AI providers receive this evidence, and the consensus step lets it
// override them. A board that cannot be queried yields no assertion at all —
// silence, never a guess.

import { toIsoDate } from './dates.mjs'

export const TODAY = new Date().toISOString().slice(0, 10)
export const TARGET_INTAKE = '2027'

const PAGE_TIMEOUT_MS = 15000
const BOARD_TIMEOUT_MS = 12000
const MAX_PAGES = 3
const MAX_BOARD_CANDIDATES = 5

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/** Vocabulary that marks a posting as a student opportunity. */
export const STUDENT_TERM_RE =
  /industrial placement|year in industry|placement year|sandwich (?:year|placement)|internship|intern\b|co-?op\b|undergraduate (?:placement|work|student)|student placement|work placement|12-?month placement|summer analyst|spring (?:week|insight)|placement student/i

/** Vocabulary that marks a posting as outside the tracker's remit. */
export const GRADUATE_TERM_RE =
  /graduate (?:scheme|programme|program|role|job|engineer|opportunit)|experienced hire|professional hire|post-?doc|phd\b|apprenticeship|senior|principal|head of|director\b/i

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export function extractText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function normaliseUrl(value) {
  if (!value) return null
  try { return new URL(value).toString() } catch { return null }
}

export async function fetchHtml(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
    })
    // A dead vacancy URL is itself evidence, so the status is reported rather
    // than swallowed.
    if (!response.ok) return { finalUrl: response.url, html: '', status: response.status, ok: false }
    return { finalUrl: response.url, html: await response.text(), status: response.status, ok: true }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchPage(url) {
  const fetched = await fetchHtml(url)
  if (!fetched) return null
  if (!fetched.ok) return { url: fetched.finalUrl || url, text: '', links: [], status: fetched.status, dead: true }
  const text = extractText(fetched.html)
  if (!text || text.length < 40) return null
  return { url: fetched.finalUrl, text, links: extractLinks(fetched.html, fetched.finalUrl), html: fetched.html, status: 200, dead: false }
}

export function extractLinks(html, baseUrl) {
  const links = []
  const seen = new Set()
  const anchorRe = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchorRe.exec(html)) !== null) {
    const label = extractText(match[2]).toLowerCase()
    try {
      const absolute = new URL(match[1], baseUrl).toString()
      if (seen.has(absolute)) continue
      seen.add(absolute)
      links.push({ href: absolute, label })
    } catch { /* skip malformed links */ }
    if (links.length >= 60) break
  }
  return links
}

// ---------------------------------------------------------------------------
// Role-title matching
// ---------------------------------------------------------------------------

export function norm(value = '') {
  return String(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'into', 'from', 'this', 'that', 'your', 'you', 'are',
  'will', 'have', 'has', 'not', 'our', 'all', 'any', 'year', 'role', 'job', 'work',
  'within', 'across', 'about', 'their', 'they', 'its', 'was', 'were', 'been',
])

export function roleTitleWords(specificRole) {
  return norm(specificRole)
    .split(' ')
    // 3-letter technical terms (CFD, GNC, CAD, FEA…) are decisive for exact-role
    // matching and must not be dropped as noise.
    .filter(word => word.length >= 3 && !STOPWORDS.has(word))
}

export function roleTitleFound(text, words) {
  if (!words.length) return false
  const present = words.filter(word => text.includes(word))
  if (words.length <= 2) return present.length === words.length
  return present.length >= Math.max(2, Math.ceil(words.length * 0.6))
}

// ---------------------------------------------------------------------------
// Page text signals
// ---------------------------------------------------------------------------

export function detectSignals(text, roleWords, roleNorm = '') {
  const lower = String(text ?? '').toLowerCase()
  const has2027 = /\b2027\b/.test(lower)
  // "2026/27" and "2026-27" name the same academic cycle as a 2027 start.
  const hasCycle2027 = /\b20\s?26\s?[/-]\s?(?:20)?27\b/.test(lower)
  const student = STUDENT_TERM_RE.test(lower)
  const openSignal = (
    /apply (?:now|online|here|today|directly)/i.test(lower) ||
    /start (?:your )?application|submit (?:your )?application/i.test(lower) ||
    /applications? (?:are |is )?(?:now )?open/i.test(lower) ||
    /currently (?:open|recruiting|accepting applications)/i.test(lower) ||
    /accepting applications/i.test(lower)
  )
  const closedSignal = (
    /applications? (?:are |is |have )?(?:now )?closed/i.test(lower) ||
    /(?:vacancy|role|position|opportunity|job) (?:has |is )?(?:now )?closed/i.test(lower) ||
    /no longer accepting|no longer available|this (?:job|vacancy|role) (?:is|has) (?:expired|closed)/i.test(lower) ||
    /deadline (?:has )?passed/i.test(lower) ||
    /position (?:has been )?filled/i.test(lower)
  )
  const titleMatched = roleTitleFound(lower, roleWords)
  // A scattered word match across a whole careers page is not enough to claim
  // THIS role is open or closed; a page-text-only assertion needs the role title
  // as a contiguous phrase.
  const titleContiguous = roleNorm ? lower.includes(roleNorm) : false
  return { has2027, hasCycle2027, student, openSignal, closedSignal, titleMatched, titleContiguous }
}

// ---------------------------------------------------------------------------
// Applicant tracking systems
// ---------------------------------------------------------------------------
//
// Most tracked links are landing pages whose real availability signal lives on an
// external board. Each board below exposes a public JSON listing, so the exact
// role can be looked up rather than inferred from prose.

const APPLY_LINK_RE = /apply|application|job board|vacanc|opportunit|join us|careers|work with us|view and apply|search jobs|current openings/i

export function detectBoard(url) {
  let parsed
  try { parsed = new URL(url) } catch { return null }
  const host = parsed.hostname.toLowerCase()
  const seg = parsed.pathname.split('/').filter(Boolean)

  // boards.greenhouse.io/embed/job_board?for=KEY
  const embedFor = parsed.searchParams.get('for')
  if (host.endsWith('greenhouse.io')) {
    const key = embedFor || (seg[0] === 'embed' ? null : seg[0]) || host.split('.')[0]
    return key ? { type: 'greenhouse', key } : null
  }
  if (host.endsWith('lever.co')) return { type: 'lever', key: seg[0] || host.split('.')[0] }
  if (host.endsWith('ashbyhq.com')) return { type: 'ashby', key: seg[0] || host.split('.')[0] }
  if (host.endsWith('smartrecruiters.com')) return { type: 'smartrecruiters', key: seg[0] || host.split('.')[0] }
  if (host.endsWith('myworkdayjobs.com') || host.endsWith('myworkday.com')) {
    return { type: 'workday', key: host.split('.')[0] }
  }
  if (host.endsWith('workable.com')) {
    // apply.workable.com/KEY/ and KEY.workable.com
    const key = host.startsWith('apply.') ? seg[0] : host.split('.')[0]
    return key ? { type: 'workable', key } : null
  }
  if (host.endsWith('recruitee.com')) return { type: 'recruitee', key: host.split('.')[0] }
  if (host.endsWith('teamtailor.com')) return { type: 'teamtailor', key: host.split('.')[0] }
  if (host.endsWith('jobs.personio.de') || host.endsWith('jobs.personio.com')) {
    return { type: 'personio', key: host.split('.')[0] }
  }
  return null
}

/**
 * Identify the applicant tracking system behind a CUSTOM careers domain.
 *
 * `detectBoard` only recognises ATS-branded hostnames (jobs.lever.co,
 * *.myworkdayjobs.com...). The employers that matter most here do not use those:
 * Williams serves its vacancies from careers.williamsf1.com and McLaren from
 * racingcareers.mclaren.com. Both are ordinary ATS boards behind a vanity
 * domain, and because nothing detected them, neither discovery nor verification
 * could enumerate a single vacancy — which is why the tracker held one generic
 * row per team instead of the four or five placements each actually advertises.
 *
 * The board always leaves its fingerprints in the served HTML: an embed URL, an
 * API host, or a company id. This reads those.
 */
export function detectBoardFromHtml(html, pageUrl = '') {
  const text = String(html ?? '')
  if (!text) return null

  // Greenhouse's embed script names the board in a query parameter and is
  // checked first: its URL also matches the generic pattern below, which would
  // otherwise read the path segment "embed" as the board key.
  const ghEmbed = text.match(/greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([A-Za-z0-9_-]+)/i)
    || text.match(/Grnhse\.Settings[\s\S]{0,200}?["']([A-Za-z0-9_-]+)["']/i)
  if (ghEmbed) return { type: 'greenhouse', key: ghEmbed[1], via: 'greenhouse embed script' }

  // SmartRecruiters identifies a company by UUID rather than slug. Only claim
  // the board when the page carries something queryBoardJobs can actually use:
  // a company slug, or the UUID it already knows how to read out of the HTML.
  if (/smartrecruiters/i.test(text)) {
    const slug = text.match(/jobs\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i)
    const uuid = text.match(/companies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
      || text.match(/"companyId"\s*:\s*"([0-9a-f-]{36})"/i)
    if (slug || uuid) {
      return {
        type: 'smartrecruiters',
        key: slug?.[1] ?? uuid[1],
        via: slug ? 'smartrecruiters board link' : 'smartrecruiters company id in page HTML',
      }
    }
  }

  // Any other ATS URL embedded in the page: hand it to detectBoard so both
  // paths describe a board the same way.
  const embedded = text.match(
    /https?:\/\/(?:jobs\.lever\.co\/[A-Za-z0-9_-]+|job-boards\.greenhouse\.io\/[A-Za-z0-9_-]+|jobs\.ashbyhq\.com\/[A-Za-z0-9_-]+|[A-Za-z0-9_-]+\.recruitee\.com|[A-Za-z0-9_-]+\.teamtailor\.com|apply\.workable\.com\/[A-Za-z0-9_-]+|[A-Za-z0-9_.-]+\.myworkdayjobs\.com\/[^"'\s<>]*)/i)
  if (embedded) {
    const board = detectBoard(embedded[0])
    if (board) return { ...board, via: embedded[0] }
  }

  return null
}

async function getJson(url, init = {}) {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'User-Agent': UA, ...(init.headers || {}) },
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Workday hides most vacancies behind pagination, so the previous single page of
 * 20 postings routinely "failed to find" a role that was live all along — one of
 * the biggest sources of false negatives in this tracker. The board is now
 * searched by the role's own keywords AND paged through, and only a listing that
 * genuinely reached the end is marked complete.
 */
async function queryWorkday(board, boardUrl, roleWords) {
  let parsed
  try { parsed = new URL(boardUrl) } catch { return null }
  const segs = parsed.pathname.split('/').filter(Boolean)
  const first = segs[0] || ''
  const site = /^[a-z]{2}(-[a-z]{2})?$/i.test(first) ? (segs[1] || '') : first
  if (!site) return null

  const origin = parsed.origin
  const jobsUrl = `${origin}/wday/cxs/${board.key}/${site}/jobs`

  // Workday requires a session cookie for the search endpoint.
  let cookieHeader = ''
  try {
    const seed = await fetch(parsed.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    })
    const cookies = typeof seed.headers.getSetCookie === 'function'
      ? seed.headers.getSetCookie()
      : (seed.headers.get('set-cookie') ? [seed.headers.get('set-cookie')] : [])
    cookieHeader = cookies.map(value => String(value).split(';')[0]).filter(Boolean).join('; ')
  } catch { /* cookies are optional */ }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  }

  const MAX_ROWS = 400
  const PAGE = 20
  const jobs = []
  const seen = new Set()
  let complete = false

  /** Pages through one Workday search. Returns true when it reached the end. */
  async function sweep(searchText) {
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
      const data = await getJson(jobsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset, searchText }),
      })
      const postings = data?.jobPostings
      if (!Array.isArray(postings)) return false
      for (const job of postings) {
        const url = origin + (job.externalPath || '')
        if (seen.has(url)) continue
        seen.add(url)
        jobs.push({ title: job.title || '', url, location: job.locationsText || job.locationText || '' })
      }
      const total = Number(data?.total)
      if (postings.length < PAGE) return true
      if (Number.isFinite(total) && offset + PAGE >= total) return true
    }
    // Stopped at the row cap, so the listing is truncated, not enumerated.
    return false
  }

  // The role's own keywords first — precise and cheap. If that finds the role
  // there is nothing left to prove, and the broad sweep is skipped.
  const keywords = roleWords.slice(0, 4).join(' ')
  if (keywords) await sweep(keywords)
  const foundByKeyword = jobs.some(job => roleTitleFound(norm(job.title), roleWords))

  if (!foundByKeyword) {
    // Student terms, then everything: absence may only be asserted after a sweep
    // that genuinely reached the end of the board.
    await sweep('placement')
    await sweep('intern')
    complete = await sweep('')
  }

  return jobs.length ? { jobs, complete } : null
}

export async function queryBoardJobs(board, pageHtml, boardUrl, roleWords = []) {
  switch (board.type) {
    case 'greenhouse': {
      const data =
        await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.key)}/jobs?content=false`)
        ?? await getJson(`https://api.greenhouse.io/v1/boards/${encodeURIComponent(board.key)}/embed/jobs`)
      const list = data?.jobs
      if (!Array.isArray(list)) return null
      return {
        complete: true,
        jobs: list.map(job => ({
          title: job.title || '',
          url: job.absolute_url || '',
          location: job.location?.name || '',
        })),
      }
    }

    case 'lever': {
      const data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(board.key)}?mode=json`)
      if (!Array.isArray(data)) return null
      return {
        complete: true,
        jobs: data.map(job => ({
          title: job.text || '',
          url: job.hostedUrl || '',
          location: job.categories?.location || '',
        })),
      }
    }

    case 'ashby': {
      const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.key)}`)
      if (!Array.isArray(data?.jobs)) return null
      return {
        complete: true,
        jobs: data.jobs
          .filter(job => job.isListed !== false)
          .map(job => ({ title: job.title || '', url: job.jobUrl || '', location: job.location || '' })),
      }
    }

    case 'smartrecruiters': {
      const idMatch =
        String(pageHtml || '').match(/companies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ||
        String(pageHtml || '').match(/"companyId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i)
      const jobs = []
      let complete = true

      // The public posting API works by company identifier; fall back to the
      // company slug, which many employers also expose.
      const bases = [
        idMatch ? `https://api.smartrecruiters.com/v1/companies/${idMatch[1]}/postings` : null,
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.key)}/postings`,
      ].filter(Boolean)

      for (const base of bases) {
        for (let offset = 0; offset < 400; offset += 100) {
          const data = await getJson(`${base}?limit=100&offset=${offset}`)
          if (!Array.isArray(data?.content) || !data.content.length) break
          jobs.push(...data.content.map(job => ({
            title: job.name || '',
            url: job.applyUrl || `https://jobs.smartrecruiters.com/${encodeURIComponent(board.key)}/${job.id}`,
            location: [job.location?.city, job.location?.country].filter(Boolean).join(', '),
          })))
          if (data.content.length < 100) break
          if (offset + 100 >= 400) complete = false
        }
        if (jobs.length) break
      }
      return jobs.length ? { jobs, complete } : null
    }

    case 'workday':
      return queryWorkday(board, boardUrl, roleWords)

    case 'workable': {
      const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board.key)}`)
      if (!Array.isArray(data?.jobs)) return null
      return {
        complete: true,
        jobs: data.jobs.map(job => ({
          title: job.title || '',
          url: job.url || job.application_url || '',
          location: [job.city, job.country].filter(Boolean).join(', '),
        })),
      }
    }

    case 'recruitee': {
      const data = await getJson(`https://${encodeURIComponent(board.key)}.recruitee.com/api/offers/`)
      if (!Array.isArray(data?.offers)) return null
      return {
        complete: true,
        jobs: data.offers.map(job => ({
          title: job.title || '',
          url: job.careers_url || job.careers_apply_url || '',
          location: [job.city, job.country].filter(Boolean).join(', '),
        })),
      }
    }

    case 'teamtailor': {
      const data = await getJson(`https://${encodeURIComponent(board.key)}.teamtailor.com/jobs.json`)
      const list = Array.isArray(data) ? data : data?.jobs
      if (!Array.isArray(list)) return null
      return {
        complete: true,
        jobs: list.map(job => ({
          title: job.title || job.name || '',
          url: job.careersite_job_url || job.url || '',
          location: job.location || '',
        })),
      }
    }

    case 'personio': {
      const data = await getJson(`https://${encodeURIComponent(board.key)}.jobs.personio.de/search.json`)
      if (!Array.isArray(data)) return null
      return {
        complete: true,
        jobs: data.map(job => ({
          title: job.name || '',
          url: job.url || '',
          location: job.office || '',
        })),
      }
    }

    default:
      return null
  }
}

/**
 * Matches the tracked title against live postings.
 * `match` needs most significant tokens (>= 80 %); `loose` only some (>= 60 %).
 * Presence is decisive only on a `match`; absence is decisive only when there is
 * not even a `loose` hit, so a renamed-but-live posting never produces a false
 * "Closed".
 */
export function findRoleOnBoard(jobs, roleWords, roleNorm = '') {
  if (!Array.isArray(jobs) || !jobs.length || !roleWords.length) return { match: null, loose: null }
  // A single significant token ("Engineer" left over from a short title) is too
  // weak for token overlap, so the whole normalised title must appear.
  const requireContiguous = roleWords.length < 2 && roleNorm
  const minCount = roleWords.length <= 2 ? roleWords.length : Math.max(2, Math.ceil(roleWords.length * 0.8))

  let best = null
  let loose = null
  for (const job of jobs) {
    const titleNorm = norm(job.title || '')
    if (!titleNorm) continue
    const present = roleWords.filter(word => titleNorm.includes(word))
    const ratio = present.length / roleWords.length
    const picked = { title: job.title, url: job.url, location: job.location }

    if (requireContiguous) {
      if (titleNorm.includes(roleNorm)) {
        if (!best || present.length > best.present) best = { ...picked, present: present.length }
      } else if (ratio >= 0.6 && (!loose || present.length > loose.present)) {
        loose = { ...picked, present: present.length }
      }
      continue
    }
    if (ratio >= 0.8 && present.length >= minCount) {
      if (!best || present.length > best.present) best = { ...picked, present: present.length }
    } else if (ratio >= 0.6 && (!loose || present.length > loose.present)) {
      loose = { ...picked, present: present.length }
    }
  }
  return {
    match: best ? { title: best.title, url: best.url, location: best.location } : null,
    loose,
  }
}

/**
 * Follows apply links from the fetched pages into an applicant tracking system
 * and queries it. `ok: false` means nothing could be queried, and the caller must
 * then assert nothing from the board.
 */
export async function resolveJobBoard(role, pages, roleWords, roleNorm) {
  if (!roleWords.length) return { ok: false, reason: 'no role tokens' }

  const candidates = []
  const seen = new Set()
  const push = url => {
    const normalised = normaliseUrl(url)
    if (normalised && !seen.has(normalised)) { seen.add(normalised); candidates.push(normalised) }
  }

  // The tracked links first: they usually point straight at the board.
  for (const url of [role.application_link, role.careers_page]) push(url)
  for (const page of pages) {
    for (const link of (page.links ?? [])) {
      if (detectBoard(link.href) || APPLY_LINK_RE.test(link.label)) push(link.href)
    }
  }

  for (const candidate of candidates.slice(0, MAX_BOARD_CANDIDATES)) {
    const board = detectBoard(candidate)
    if (!board) continue

    let pageHtml = ''
    if (board.type === 'smartrecruiters') {
      const fetched = await fetchHtml(candidate)
      pageHtml = fetched?.html ?? ''
    }
    const listing = await queryBoardJobs(board, pageHtml, candidate, roleWords)
    // An empty or unusable board is evidence of nothing — never read "0 postings"
    // as "the role is closed".
    if (!listing || !Array.isArray(listing.jobs) || !listing.jobs.length) continue

    const found = findRoleOnBoard(listing.jobs, roleWords, roleNorm)
    return {
      ok: true,
      found: Boolean(found.match),
      job: found.match,
      loose: found.loose,
      boardType: board.type,
      boardUrl: candidate,
      liveCount: listing.jobs.length,
      complete: listing.complete === true,
    }
  }
  return { ok: false, reason: 'no queryable board found' }
}

// ---------------------------------------------------------------------------
// One call, all the deterministic evidence
// ---------------------------------------------------------------------------

/**
 * Gathers everything checkable about a role without an AI provider:
 * the tracked pages, their text signals, the board listing, and — when the exact
 * role IS live on a board — the posting's own page.
 */
export async function gatherEvidence(role) {
  const roleWords = roleTitleWords(role.specific_role)
  const roleNorm = norm(role.specific_role)

  const urls = []
  const seen = new Set()
  for (const value of [role.application_link, role.careers_page]) {
    const url = normaliseUrl(value)
    if (url && !seen.has(url)) { seen.add(url); urls.push(url) }
  }

  const fetched = []
  for (const url of urls.slice(0, MAX_PAGES)) {
    const page = await fetchPage(url)
    if (page) fetched.push(page)
    else fetched.push({ url, text: '', links: [], status: 0, dead: true })
  }

  const pages = fetched.filter(page => page.text)
  const deadLinks = fetched.filter(page => page.dead).map(page => ({ url: page.url, status: page.status }))

  // Open/closed wording is read from the page that best identifies THIS role,
  // not from whichever page happened to be fetched last. The previous verifier
  // kept only the last page's signals, so a generic careers page fetched after
  // the vacancy page erased the real evidence — a direct source of false
  // negatives. The weaker corroborating facts are unioned across all pages.
  const perPage = pages.map(page => detectSignals(page.text, roleWords, roleNorm))
  const primary =
    perPage.find(page => page.titleContiguous)
    ?? perPage.find(page => page.titleMatched)
    ?? perPage[0]
    ?? { has2027: false, hasCycle2027: false, student: false, openSignal: false, closedSignal: false, titleMatched: false, titleContiguous: false }

  const signals = { ...primary }
  for (const page of perPage) {
    signals.has2027 ||= page.has2027
    signals.hasCycle2027 ||= page.hasCycle2027
    signals.student ||= page.student
  }

  const board = await resolveJobBoard(role, pages, roleWords, roleNorm)

  // When the board lists the exact role, read the posting itself: a board hit
  // alone does not say which intake the posting is for.
  let posting = null
  let postingSignals = null
  if (board.ok && board.found && board.job?.url) {
    posting = await fetchPage(board.job.url)
    if (posting?.text) postingSignals = detectSignals(posting.text, roleWords, roleNorm)
  }

  return { roleWords, roleNorm, pages, deadLinks, signals, board, posting, postingSignals }
}

/**
 * The deterministic verdict, expressed only where it is genuinely decisive.
 * Returns `{ status, confidence, reason, applicationUrl }` with status one of
 * 'OPEN_NOW' | 'CLOSED' | null (null = no assertion).
 */
export function deterministicVerdict(role, evidence) {
  const { signals, board, postingSignals, posting } = evidence
  // Independent of any model: did a fetched page actually say applications are
  // open, and did it say so without also saying they have closed?
  const pageSaysOpen = (signals.openSignal === true && signals.closedSignal !== true)
    || (postingSignals?.openSignal === true && postingSignals?.closedSignal !== true)
  const intake2027 = signals.has2027 || signals.hasCycle2027
    || postingSignals?.has2027 || postingSignals?.hasCycle2027
    || /\b2027\b/.test(board?.job?.title || '')

  if (board.ok && board.found) {
    const studentOk =
      STUDENT_TERM_RE.test(board.job.title || '') ||
      STUDENT_TERM_RE.test(role.specific_role || '') ||
      signals.student ||
      postingSignals?.student === true
    const graduateOnly = GRADUATE_TERM_RE.test(board.job.title || '') && !STUDENT_TERM_RE.test(board.job.title || '')
    const postingClosed = postingSignals?.closedSignal === true && postingSignals?.openSignal !== true

    if (studentOk && !graduateOnly && !postingClosed) {
      return {
        status: 'OPEN_NOW',
        // The intake year is the only soft part: a live student posting whose
        // page never prints "2027" is still almost certainly this cycle, because
        // employers take listings down once a cycle closes.
        confidence: intake2027 ? 0.95 : 0.82,
        intakeConfirmed: Boolean(intake2027),
        pageSaysOpen,
        applicationUrl: board.job.url,
        reason: `The exact tracked role is live on the employer's ${board.boardType} board as "${board.job.title}"`
          + ` (${board.liveCount} live postings queried at ${board.boardUrl})`
          + `${intake2027 ? ' and the posting names the 2027 intake' : '; the posting does not print an intake year'}.`,
      }
    }
    return {
      status: null,
      confidence: 0,
      intakeConfirmed: Boolean(intake2027),
      pageSaysOpen,
      applicationUrl: '',
      reason: `The exact role appears on the ${board.boardType} board as "${board.job.title}" but`
        + `${graduateOnly ? ' it reads as a graduate/experienced vacancy' : ''}`
        + `${postingClosed ? ' its own page says applications are closed' : ''}`
        + `${!studentOk ? ' it could not be confirmed as a student opportunity' : ''}.`,
    }
  }

  if (board.ok && board.complete && !board.found && !board.loose && board.liveCount > 0) {
    return {
      status: 'CLOSED',
      confidence: 0.8,
      intakeConfirmed: Boolean(intake2027),
      pageSaysOpen,
      applicationUrl: '',
      reason: `The employer's ${board.boardType} board was enumerated in full (${board.liveCount} live postings)`
        + ' and the exact tracked role is absent, with no similarly named posting.',
    }
  }

  // Page text only. A contiguous role-title match plus an unambiguous signal.
  const exactRole = signals.titleContiguous && signals.titleMatched
  if (exactRole && signals.student && intake2027 && signals.openSignal && !signals.closedSignal) {
    return { status: 'OPEN_NOW', confidence: 0.85, intakeConfirmed: true, pageSaysOpen, applicationUrl: '', reason: 'The tracked vacancy page names the exact role, the 2027 student intake and an open application route.' }
  }
  if (exactRole && signals.student && intake2027 && signals.closedSignal && !signals.openSignal) {
    return { status: 'CLOSED', confidence: 0.85, intakeConfirmed: true, pageSaysOpen, applicationUrl: '', reason: 'The tracked vacancy page names the exact 2027 role and states that applications are closed.' }
  }

  return {
    status: null,
    confidence: 0,
    intakeConfirmed: Boolean(intake2027),
    pageSaysOpen,
    applicationUrl: '',
    reason: board.ok
      ? `The ${board.boardType} board was queried (${board.liveCount} live postings) without a decisive match.`
      : `No queryable applicant tracking system was reachable (${board.reason || 'unknown'}).`,
  }
}

/** A compact, quotable summary of the deterministic evidence for a model prompt. */
export function describeEvidence(evidence, verdict) {
  const { pages, deadLinks, signals, board, posting, postingSignals } = evidence
  const lines = []

  lines.push('DETERMINISTIC EVIDENCE (gathered by this tracker, not by you — treat it as fact):')
  lines.push(`- Pages fetched: ${pages.length ? pages.map(page => page.url).join(', ') : 'none'}.`)
  if (deadLinks.length) {
    lines.push(`- Tracked links that did NOT load: ${deadLinks.map(link => `${link.url} (HTTP ${link.status || 'no response'})`).join(', ')}.`)
  }
  lines.push(`- Page text: 2027 mentioned ${signals.has2027 ? 'yes' : 'no'}; 2026/27 cycle ${signals.hasCycle2027 ? 'yes' : 'no'};`
    + ` student wording ${signals.student ? 'yes' : 'no'}; exact role title present ${signals.titleContiguous ? 'yes (verbatim)' : signals.titleMatched ? 'partly' : 'no'};`
    + ` "applications open" wording ${signals.openSignal ? 'yes' : 'no'}; "applications closed" wording ${signals.closedSignal ? 'yes' : 'no'}.`)

  if (board.ok && board.found) {
    lines.push(`- APPLICANT TRACKING SYSTEM: the EXACT tracked role IS live on the employer's official ${board.boardType} board`
      + ` as "${board.job.title}" (${board.job.url}), among ${board.liveCount} live postings.`
      + ' A live posting on the employer\'s own ATS is direct proof that applications are being accepted right now.')
    if (postingSignals) {
      lines.push(`- That posting's own page: 2027 ${postingSignals.has2027 ? 'named' : 'not named'};`
        + ` student wording ${postingSignals.student ? 'yes' : 'no'};`
        + ` closed wording ${postingSignals.closedSignal ? 'yes' : 'no'}.`)
    } else if (posting) {
      lines.push('- That posting\'s own page could not be read.')
    }
  } else if (board.ok && !board.found) {
    lines.push(`- APPLICANT TRACKING SYSTEM: the employer's official ${board.boardType} board at ${board.boardUrl} was queried`
      + ` (${board.liveCount} live postings, enumeration ${board.complete ? 'complete' : 'INCOMPLETE'})`
      + ` and the exact tracked role was NOT found${board.loose ? `, though a similarly named posting exists ("${board.loose.title}")` : ''}.`
      + (board.complete
        ? ' A complete enumeration without the role is evidence that it is not currently accepting applications.'
        : ' An incomplete enumeration is NOT evidence of closure.'))
  } else {
    lines.push(`- APPLICANT TRACKING SYSTEM: none could be queried (${board.reason || 'unknown'}). Assert nothing from this.`)
  }

  lines.push(`- Deterministic verdict: ${verdict.status ?? 'NO ASSERTION'}${verdict.status ? ` (${Math.round(verdict.confidence * 100)}% confidence)` : ''}. ${verdict.reason}`)
  return lines.join('\n')
}

/** Page text to hand a model, bounded so a long careers page cannot crowd out the vacancy. */
export function evidencePageText(evidence, perPage = 6000, total = 18000) {
  const parts = []
  if (evidence.posting?.text) {
    parts.push(`### EXACT VACANCY PAGE (from the employer's job board)\n${evidence.posting.url}\n${evidence.posting.text.slice(0, perPage)}`)
  }
  for (const page of evidence.pages) {
    parts.push(`### TRACKED PAGE\n${page.url}\n${page.text.slice(0, perPage)}`)
  }
  return parts.join('\n\n').slice(0, total)
}

export { toIsoDate }

/**
 * Does this URL point at ONE vacancy, or at a landing page listing many?
 *
 * This is the difference between "you can apply to this today" and "this
 * employer has an early-careers section". AGENTS.md has always said a generic
 * careers page is not evidence a role is open; this makes that machine-checkable
 * so a model cannot assert it away.
 *
 * Deliberately conservative: it answers "is this unambiguously one posting?",
 * and a false "no" only costs corroboration from another signal.
 */
export function isSpecificPosting(url) {
  let parsed
  try { parsed = new URL(String(url ?? '')) } catch { return false }

  const path = parsed.pathname.replace(/\/+$/, '')
  if (!path || path === '/') return false

  // A search or results page lists vacancies; it is not one of them.
  if (/\/(search|results|browse|jobs?-search)$/i.test(path)) return false
  if (parsed.search && /(^|&)(q|query|search|keyword|team|category)=/i.test(parsed.search.slice(1))) return false

  const segments = path.split('/').filter(Boolean)
  const last = segments[segments.length - 1] ?? ''

  // A landing page for a programme or a cohort, however deep the path.
  if (/^(careers?|jobs?|vacancies|opportunities|early-careers?|students?|graduates?|undergraduates?|internships?|placements?|emerging-talent|apply|openings|roles)$/i.test(last)) {
    return false
  }

  // An identifier is what makes a URL point at one posting: a numeric id, a
  // UUID, or a long opaque token, anywhere in the path.
  const hasId = segments.some(segment =>
    /^\d{4,}$/.test(segment)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
    || /^[0-9a-f]{16,}$/i.test(segment)
    || /[-_]\d{5,}$/.test(segment)
    || /^\d{6,}/.test(segment))
  if (hasId) return true

  // A posting-shaped path with a descriptive slug: /job/<slug>, /postings/<slug>,
  // /job-detail/<slug>, /vacancy/<slug>.
  const postingSegment = segments.findIndex(segment =>
    /^(job|jobs|posting|postings|vacancy|vacancies|job-detail|jobdetail|opening|position)$/i.test(segment))
  if (postingSegment !== -1 && segments.length > postingSegment + 1) {
    const slug = segments[postingSegment + 1]
    return slug.length >= 8 && /[-_]/.test(slug)
  }

  // A long, highly specific slug names one vacancy even without a /job/ segment
  // or a numeric id — Red Bull's own board does exactly this:
  //   /int-en/vcarb-f1-team-undergraduate-internship-programme-20272028-prv-ref33640t
  // Programme landing pages are short by comparison ("early-careers",
  // "industrial-student-placements"), so three or more hyphens separates them.
  if (last.length >= 24 && (last.match(/-/g) ?? []).length >= 3) return true

  return false
}
