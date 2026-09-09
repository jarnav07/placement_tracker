// Read-only link monitor. Reports tracked URLs that no longer resolve.
//
// It writes NOTHING. An earlier version stamped its findings into `notes` and
// `source_verified`, which silently overwrote the user's own notes on 179 rows
// and made an unreachable URL look like a verification result. Availability is
// decided only by the audit; a 404 here is a prompt to look, not a status.
//
//   npm run monitor

import { connect } from './verify/supabase.mjs'

const supabase = connect()

const TIMEOUT_MS = 15000
const CONCURRENCY = 6

function normaliseUrl(value) {
  if (!value) return null
  try { return new URL(value).toString() } catch { return null }
}

async function reach(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const headers = { 'User-Agent': 'placement-tracker-link-monitor/3.0' }
  try {
    let response
    try {
      response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers })
      // Some hosts reject HEAD but serve GET.
      if (response.status === 405 || response.status === 501) {
        response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers })
      }
    } catch {
      response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers })
    }
    return { ok: response.ok, status: response.status }
  } catch (error) {
    return { ok: false, status: null, error: error?.message ?? 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const { data, error } = await supabase
    .from('placements')
    .select('id, company, specific_role, application_link, careers_page')
    .eq('archived', false)
    .eq('not_interested', false)
    .order('company')
  if (error) throw error

  const rows = data ?? []
  console.log(`Link monitor: checking ${rows.length} roles. Read-only — no rows are modified.`)

  const broken = []
  let noUrl = 0
  let cursor = 0

  async function worker() {
    while (true) {
      const index = cursor++
      if (index >= rows.length) return
      const row = rows[index]
      const urls = [...new Set([row.application_link, row.careers_page].map(normaliseUrl).filter(Boolean))]
      if (!urls.length) { noUrl++; continue }

      let result = null
      for (const url of urls) {
        result = await reach(url)
        if (result.ok) break
      }
      if (!result?.ok) {
        broken.push({ ...row, detail: result?.status ? `HTTP ${result.status}` : (result?.error ?? 'unreachable'), url: urls[0] })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker))

  if (broken.length) {
    console.log(`\n${broken.length} roles have no reachable link:`)
    for (const row of broken) console.log(`  ${row.company} — ${row.specific_role}: ${row.detail} — ${row.url}`)
  }
  console.log(`\nDone: ${rows.length - broken.length - noUrl} reachable, ${broken.length} unreachable, ${noUrl} without a URL.`)
}

main().catch(error => { console.error(error); process.exit(1) })
