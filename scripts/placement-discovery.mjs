// Discover NEW 2027-start student placements from official career sources already
// present in the tracker. Discovery is deliberately deterministic: it crawls
// existing source pages, extracts explicit student-role links, and lets the shared
// verifier use deterministic evidence first and Azure only when that evidence is
// ambiguous. It never deletes rows or recreates Not Interested roles.

import { createClient } from '@supabase/supabase-js'
import { verifyPlacement, TODAY, TARGET_INTAKE } from './placement-verifier.mjs'
import { classifyOpportunity, looksLikeStudentRole } from './role-quality.mjs'

const rawSupabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '')
  .trim().replace(/^['"]|['"]$/g, '')
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^['"]|['"]$/g, '')

if (!rawSupabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const supabaseUrl = new URL(rawSupabaseUrl)
supabaseUrl.pathname = ''
supabaseUrl.search = ''
supabaseUrl.hash = ''

const supabase = createClient(supabaseUrl.toString().replace(/\/$/, ''), supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { enabled: false }
})

const FETCH_TIMEOUT_MS = 15000
const MAX_SOURCE_PAGES = 120
const MAX_CANDIDATES = 120
const MAX_CONCURRENT = 1
const DELAY_MS = 700

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function extractText(html) {
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

function normaliseUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

async function fetchHtml(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PlacementTracker/1.0)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
      }
    })
    if (!response.ok) return null
    return { url: response.url, html: await response.text() }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function extractLinks(html, baseUrl) {
  const links = []
  const seen = new Set()
  const anchorRe = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchorRe.exec(html)) !== null) {
    let href = null
    try { href = normaliseUrl(new URL(match[1], baseUrl).toString()) } catch { /* skip malformed links */ }
    const label = extractText(match[2])
    if (!href || seen.has(href)) continue
    seen.add(href)
    links.push({ href, label })
    if (links.length >= 100) break
  }
  return links
}

function norm(value = '') {
  return String(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function roleKey(company, role) {
  return `${norm(company)}|${norm(role)}`
}

/**
 * A candidate must look like a student vacancy on the strength of its own link
 * label and URL.
 *
 * The previous version tested the whole SOURCE PAGE text for terms like
 * "internship" or "2027". Every careers page contains those words somewhere, so
 * the gate always passed and the crawler inserted product pages, navigation
 * links and blog posts as if they were vacancies. `looksLikeStudentRole` looks
 * only at the link itself.
 */
function looksLikeRoleLink(link, sourceUrl) {
  if (!link.href || link.href === sourceUrl) return false
  return looksLikeStudentRole(link.label, link.href)
}

async function loadExistingIndex() {
  const { data, error } = await supabase
    .from('placements')
    .select('id, company, specific_role, city, country, application_link, careers_page, not_interested, archived')

  if (error) throw error

  const byKey = new Map()
  const byUrl = new Map()
  const notInterested = new Map()
  const sourcePages = []

  for (const row of (data ?? [])) {
    const key = roleKey(row.company, row.specific_role)
    byKey.set(key, row)
    if (row.not_interested === true) notInterested.set(key, row)

    for (const value of [row.careers_page, row.application_link]) {
      const url = normaliseUrl(value)
      if (!url) continue
      byUrl.set(url, row)
      sourcePages.push({ url, company: row.company, city: row.city, country: row.country })
    }
  }

  return { byKey, byUrl, notInterested, sourcePages }
}

function buildInsert(candidate, result) {
  // Only columns that still exist after the 2026-09-05 schema cleanup, and only
  // researched ones: `overall_priority` / `priority_score` are derived by a
  // Postgres trigger and the user-owned tracking columns are left at their
  // defaults.
  return {
    company: candidate.company,
    specific_role: candidate.specific_role,
    start_year: Number(TARGET_INTAKE),
    opportunity_type: classifyOpportunity(`${candidate.specific_role} ${result.programme_type ?? ''}`),
    sector: null,
    engineering_area: null,
    country: result.location_country || candidate.country || null,
    city: result.location_city || candidate.city || null,
    website: result.website || null,
    careers_page: candidate.careers_page || null,
    application_link: result.verified_application_url || candidate.application_link || candidate.careers_page || null,
    placement_duration: result.placement_duration || null,
    application_status: result.mappedApplicationStatus,
    exact_opening_date: result.opening_date || null,
    exact_deadline: result.deadline || null,
    deadline_type: normaliseDeadlineType(result.deadline_type),
    degree_requirements: result.degree_requirements || null,
    salary: result.salary || null,
    source_date_checked: TODAY,
    source_verified: result.evidence
  }
}

/** The database CHECKs this column; anything unrecognised becomes null. */
function normaliseDeadlineType(value) {
  const text = String(value ?? '').toLowerCase()
  if (!text) return null
  if (text.includes('rolling')) return 'Rolling'
  if (/fixed|window|campaign|wave/.test(text)) return 'Fixed'
  if (/vacancy|role|programme|program|country/.test(text)) return 'Vacancy dependent'
  return 'TBC'
}

async function collectCandidates(sourcePages, byKey, byUrl, notInterested) {
  const candidates = []
  const seen = new Set()
  const uniqueSources = []

  for (const source of sourcePages) {
    const key = `${source.company}|${source.url}`
    if (!seen.has(key)) {
      seen.add(key)
      uniqueSources.push(source)
    }
  }

  for (const source of uniqueSources.slice(0, MAX_SOURCE_PAGES)) {
    const fetched = await fetchHtml(source.url)
    if (!fetched) continue

    for (const link of extractLinks(fetched.html, fetched.url)) {
      if (!looksLikeRoleLink(link, fetched.url)) continue
      const candidateKey = roleKey(source.company, link.label)
      if (seen.has(candidateKey) || byKey.has(candidateKey) || byUrl.has(link.href) || notInterested.has(candidateKey)) continue

      seen.add(candidateKey)
      candidates.push({
        company: source.company,
        specific_role: link.label.replace(/\s+/g, ' ').trim(),
        country: source.country || '',
        city: source.city || '',
        application_link: link.href,
        careers_page: fetched.url
      })
      if (candidates.length >= MAX_CANDIDATES) return candidates
    }
  }

  return candidates
}

async function main() {
  console.log('Deterministic discovery started. Candidates come only from existing tracked career sources.')

  const { byKey, byUrl, notInterested, sourcePages } = await loadExistingIndex()
  const candidates = await collectCandidates(sourcePages, byKey, byUrl, notInterested)
  console.log(`Existing index: ${byKey.size} roles. Candidate links found: ${candidates.length}.`)

  let inserted = 0
  let rejected = 0
  let skippedExisting = 0
  let skippedNotInterested = 0
  let errors = 0
  let cursor = 0

  async function worker() {
    while (true) {
      const index = cursor++
      if (index >= candidates.length) return
      const candidate = candidates[index]
      const key = roleKey(candidate.company, candidate.specific_role)

      if (notInterested.has(key)) {
        skippedNotInterested++
        continue
      }
      if (byKey.has(key)) {
        skippedExisting++
        continue
      }

      const verification = await verifyPlacement(candidate)
      if (!verification.ok) {
        errors++
        console.error(`VERIFICATION ERROR: ${candidate.company} — ${candidate.specific_role}: ${verification.error}`)
        continue
      }

      const result = verification.result
      const mapped = result.mappedApplicationStatus
      const intake2027 = result.intake_year_confirmed === true && /\b2027\b/.test(String(result.intake_year ?? ''))
      const link = result.verified_application_url || candidate.application_link || ''
      const valid = (
        result.exact_student_program_found === true &&
        result.exact_role_found === true &&
        intake2027 &&
        Boolean(link) &&
        ['Open Now', 'Opening Soon', 'Expected', 'Not Yet Published'].includes(mapped)
      )

      if (!valid) {
        rejected++
        console.log(`REJECTED: ${candidate.company} — ${candidate.specific_role} [${result.status}]`)
        continue
      }
      if (byUrl.has(link)) {
        skippedExisting++
        continue
      }

      const { error } = await supabase.from('placements').insert(buildInsert(candidate, result))
      if (error) {
        errors++
        console.error(`INSERT FAILED: ${candidate.company} — ${candidate.specific_role}: ${error.message}`)
        continue
      }

      inserted++
      byKey.set(key, candidate)
      byUrl.set(link, candidate)
      console.log(`NEW ROLE: ${candidate.company} — ${candidate.specific_role} [${mapped}]`)
      await sleep(DELAY_MS)
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, candidates.length) }, worker))

  const { count: after, error: afterError } = await supabase
    .from('placements')
    .select('id', { count: 'exact', head: true })
  if (afterError) throw afterError

  console.log(`DISCOVERY COMPLETE: ${inserted} new, ${rejected} rejected, ${skippedExisting} already tracked, ${skippedNotInterested} Not Interested skipped, ${errors} errors.`)
  console.log(`Row count after discovery=${after}. Discovery never deletes rows.`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
