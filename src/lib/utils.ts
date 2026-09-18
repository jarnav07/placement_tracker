import type { AppStatus, ApplicationStatus, OverallPriority, Placement, PlacementPatch } from './supabase'

export const PRIORITY_LABELS: Record<OverallPriority, string> = {
  APPLY_IMMEDIATELY: 'Apply now',
  APPLY_WHEN_OPENING: 'Prepare',
  HIGH_PRIORITY_WATCH: 'High priority',
  GOOD_BACKUP: 'Backup',
  LOW_PRIORITY: 'Low',
}

/** Long form, used in the Excel export and the detail sheet. */
export const PRIORITY_LONG_LABELS: Record<OverallPriority, string> = {
  APPLY_IMMEDIATELY: 'Apply immediately',
  APPLY_WHEN_OPENING: 'Apply when opening',
  HIGH_PRIORITY_WATCH: 'High priority watch',
  GOOD_BACKUP: 'Good backup',
  LOW_PRIORITY: 'Low priority',
}

export const PRIORITY_COLORS: Record<OverallPriority, string> = {
  APPLY_IMMEDIATELY: '#f43f5e',
  APPLY_WHEN_OPENING: '#f97316',
  HIGH_PRIORITY_WATCH: '#eab308',
  GOOD_BACKUP: '#22c55e',
  LOW_PRIORITY: '#64748b',
}

export const STATUS_COLORS: Record<ApplicationStatus, string> = {
  'Open Now': '#22c55e',
  'Opening Soon': '#f97316',
  'Expected': '#eab308',
  'Not Yet Published': '#64748b',
  'Closed': '#ef4444',
  'Unknown': '#64748b',
}

// --- The user's own pipeline -------------------------------------------------
//
// `app_status` is the only column on the board the user owns end to end, so the
// applications view is built around it rather than around the ranking. These
// three tables are the whole vocabulary: a colour, a sort order, and the ladder
// an application actually climbs.

export const STAGE_COLORS: Record<AppStatus, string> = {
  'Not Applied': '#64748b',
  'Saved': '#a78bfa',
  'Applied': '#38bdf8',
  'Assessment': '#22d3ee',
  'Interview': '#818cf8',
  'Final Interview': '#c084fc',
  'Offer': '#fbbf24',
  'Accepted': '#22c55e',
  'Rejected': '#ef4444',
  'Withdrawn': '#64748b',
}

/**
 * Sort order for the applications view: furthest through the process first, and
 * the two ways an application ends — rejected, withdrawn — last whatever stage
 * they were reached from.
 */
export const STAGE_RANK: Record<AppStatus, number> = {
  'Accepted': 0,
  'Offer': 1,
  'Final Interview': 2,
  'Interview': 3,
  'Assessment': 4,
  'Applied': 5,
  'Saved': 6,
  'Not Applied': 7,
  'Withdrawn': 8,
  'Rejected': 9,
}

/** The ladder an application climbs, in order. Rejected and Withdrawn end it instead. */
export const STAGE_LADDER: AppStatus[] = [
  'Applied', 'Assessment', 'Interview', 'Final Interview', 'Offer', 'Accepted',
]

export const STAGE_ENDED: AppStatus[] = ['Rejected', 'Withdrawn']

/**
 * How far along the ladder a stage sits, as a step count. A rejected or
 * withdrawn application keeps no step — it did not reach the end, it stopped.
 */
export function stageStep(stage: AppStatus): number | null {
  const index = STAGE_LADDER.indexOf(stage)
  return index === -1 ? null : index + 1
}

/** What `cv_version` records when an application is made without naming one. */
export const DEFAULT_CV_VERSION = 'Standard'

/**
 * The patch that moves a role to `next`.
 *
 * There are now four places a stage can be set — the board's Save button, the
 * mobile swipe, the applications card and the detail panel — and each was free
 * to invent its own rule for `date_applied`. This is the only rule: the date is
 * stamped the first time the role reaches a stage that means an application
 * exists, and is never cleared afterwards. Un-applying used to wipe it, which
 * threw away a date the user had typed in; a stage is reversible, the record of
 * when you applied should not be collateral.
 *
 * `cv_version` follows the same shape, for the same reason. Most applications go
 * out on the untailored CV and nobody stops to type that, so a stage change that
 * finds the field empty records "Standard" rather than leaving a blank that reads
 * as "unknown". A version the user has typed is never overwritten — like the date,
 * this only ever fills a gap.
 */
export function stagePatch(next: AppStatus, current: Pick<Placement, 'date_applied' | 'cv_version'>): PlacementPatch {
  const entersPipeline = next !== 'Not Applied' && next !== 'Saved'
  return {
    app_status: next,
    date_applied: entersPipeline && !current.date_applied
      ? new Date().toISOString().slice(0, 10)
      : current.date_applied,
    cv_version: entersPipeline && !current.cv_version?.trim()
      ? DEFAULT_CV_VERSION
      : current.cv_version,
  }
}

/** Maps a 0-10 score to the shared score ramp used by every bar and dial. */
export function scoreColor(score: number): string {
  if (score >= 9) return '#22c55e'
  if (score >= 7) return '#84cc16'
  if (score >= 5) return '#eab308'
  if (score >= 3) return '#f97316'
  return '#ef4444'
}

/** Same ramp, for the 0-100 priority score. */
export function priorityScoreColor(score: number): string {
  return scoreColor(score / 10)
}

const PLACEHOLDERS = new Set(['', 'tbc', 'n/a', 'na', 'none', 'unknown', 'not stated', 'not published', 'true', 'false'])

/** True when a text field holds nothing worth showing. */
export function isBlank(value: string | null | undefined): boolean {
  if (!value) return true
  const trimmed = value.trim().toLowerCase()
  return PLACEHOLDERS.has(trimmed) || trimmed.startsWith('not publicly') || trimmed.startsWith('not yet')
}

export function orDash(value: string | null | undefined, fallback = 'TBC'): string {
  return isBlank(value) ? fallback : (value as string).trim()
}

/** "3 days ago" / "in 12 days", for verification freshness and deadlines. */
export function relativeDays(days: number | null): string | null {
  if (days === null) return null
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`
}

export function formatDate(value: string | null | undefined): string | null {
  if (isBlank(value)) return null
  const parsed = new Date(value as string)
  if (Number.isNaN(parsed.getTime())) return (value as string).trim()
  return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// --- Dates ------------------------------------------------------------------
// These live here, not in filtering.ts, because ranking.ts needs them and
// filtering.ts imports ranking.ts. `src/lib/filtering.ts` re-exports them so the
// components' existing imports keep working.

const MONTH_NAMES = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec'
const MONTH_NUMBER: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
/** Seasons anchor to their first month, the same anchors the SQL uses. */
const SEASON_MONTH: Record<string, number> = { spring: 3, summer: 6, autumn: 9, fall: 9, winter: 12 }

/** Text that asserts there is no date, even when a year sits next to it. */
const NO_DATE =
  /\b(not\s+(yet\s+)?(published|stated|announced|available|applicable|specified|confirmed|disclosed|listed)|no\s+(specific|published|annual|confirmed)|vacancy[- ]dependent|role[- ]dependent|year[- ]round|rolling|ongoing|continuous|tbc|tba|to be confirmed|to be announced|unknown|unspecified|n\/a|none)\b/i

/**
 * Parses the free-text date columns. Returns null rather than NaN.
 *
 * The 2026-09-07 migration normalises day-precision values to ISO and strips
 * prose that holds no date, but month- and season-precision text ("November
 * 2026", "Autumn 2026") is kept deliberately, so this still has to handle it.
 *
 * Every pattern is explicit, and there is no `Date.parse` fallback, because
 * `Date.parse` answers confidently and wrongly on exactly the values this
 * column holds: "Autumn 2026" and "Summer 2026" both came back as 1 January
 * 2026 (V8 ignores the word it does not know and keeps the year), so a season
 * read as a deadline already in the past and took the -25 passed-deadline
 * penalty. "Not published for 2027" came back as 1 January 2027 — a deadline
 * invented out of prose that says there is no deadline. `placement_parse_date()`
 * refuses both; this now refuses both too.
 */
export function parseDate(value: string | null | undefined): number | null {
  if (!value) return null
  const text = String(value).trim()
  if (!text) return null

  const at = (year: number, month: number, day: number): number | null => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    const stamp = Date.UTC(year, month - 1, day)
    const back = new Date(stamp)
    // Rejects 31 February and friends rather than letting them roll over.
    return back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? stamp : null
  }

  // --- Day precision ---------------------------------------------------------
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/)
  if (iso) {
    const parsed = at(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    if (parsed !== null) return parsed
  }
  const dmy = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})[a-z]*\\.?,?\\s+(20\\d{2})\\b`, 'i'))
  if (dmy) {
    const parsed = at(Number(dmy[3]), MONTH_NUMBER[dmy[2].slice(0, 3).toLowerCase()], Number(dmy[1]))
    if (parsed !== null) return parsed
  }
  const mdy = text.match(new RegExp(`\\b(${MONTH_NAMES})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'i'))
  if (mdy) {
    const parsed = at(Number(mdy[3]), MONTH_NUMBER[mdy[1].slice(0, 3).toLowerCase()], Number(mdy[2]))
    if (parsed !== null) return parsed
  }
  // 04/09/2026, read day-first: the tracker is UK-based.
  const slashed = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/)
  if (slashed) {
    const parsed = at(Number(slashed[3]), Number(slashed[2]), Number(slashed[1]))
    if (parsed !== null) return parsed
  }

  // Prose that asserts there is no date beats any month or season below it.
  if (NO_DATE.test(text)) return null

  // --- Month precision, anchored to the 1st ----------------------------------
  const monthYear = text.match(new RegExp(`\\b(${MONTH_NAMES})[a-z]*\\.?\\s+(20\\d{2})\\b`, 'i'))
  if (monthYear) return at(Number(monthYear[2]), MONTH_NUMBER[monthYear[1].slice(0, 3).toLowerCase()], 1)
  const isoMonth = text.match(/\b(20\d{2})-(\d{1,2})\b/)
  if (isoMonth) return at(Number(isoMonth[1]), Number(isoMonth[2]), 1)

  // --- Season precision, anchored to its first month -------------------------
  const season = text.match(/\b(spring|summer|autumn|fall|winter)\s+(20\d{2})\b/i)
  if (season) return at(Number(season[2]), SEASON_MONTH[season[1].toLowerCase()], 1)

  return null
}

/**
 * Whole days until the date; null when it cannot be parsed. Anchored to today's
 * midnight so a deadline does not read as "in 0 days" all afternoon and then
 * silently flip to "yesterday".
 */
export function daysUntil(value: string | null | undefined, now = Date.now()): number | null {
  const at = parseDate(value)
  if (at === null) return null
  const today = new Date(now)
  const midnight = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((at - midnight) / 86_400_000)
}
