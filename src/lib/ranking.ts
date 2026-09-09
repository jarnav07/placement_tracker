import type { ApplicationStatus, OpportunityType, OverallPriority, Placement } from './supabase'
import { daysUntil } from './utils'

/**
 * Client-side mirror of the Postgres ranking installed by
 * `supabase/migrations/20260907120000_opening_automation_and_deadline_priority.sql`
 * (`placement_priority_score` / `placement_priority_band`).
 *
 * WHY THE BROWSER RECOMPUTES RATHER THAN JUST READING THE STORED SCORE
 *
 * The score now includes a deadline term, so it depends on today's date. Postgres
 * recomputes it on every write and the daily verification pass touches every row,
 * but between runs the stored number is up to a day stale — and "a day stale" on
 * a deadline countdown is exactly when it matters. So the board computes the same
 * formula locally with the browser's date, and `priority_score` remains the
 * server-side ordering key and the fallback.
 *
 * IF YOU CHANGE THE WEIGHTS, CHANGE THEM IN BOTH PLACES. `npm run check` fails
 * when the SQL and this file drift apart.
 */

export const STATUS_BONUS: Record<ApplicationStatus, number> = {
  'Open Now': 18,
  'Opening Soon': 10,
  'Expected': 4,
  'Not Yet Published': 0,
  'Unknown': 0,
  'Closed': -40,
}

export const TYPE_BONUS: Record<OpportunityType, number> = {
  'Industrial Placement': 8,
  'Internship / Co-op': 2,
  'Spring Week / Insight': 0,
  'Other Student Programme': -10,
}

/**
 * How much the deadline moves a role, mirroring `placement_deadline_bonus()`.
 *
 * A deadline that has passed is a penalty at any status — a card telling the user
 * to apply to something that closed in June is worse than useless. Urgency is a
 * bonus only for a role that can actually be applied to today: a distant deadline
 * on a role that has not opened is not urgency.
 */
export const DEADLINE_BONUS: { withinDays: number; bonus: number }[] = [
  { withinDays: 7, bonus: 14 },
  { withinDays: 14, bonus: 11 },
  { withinDays: 30, bonus: 8 },
  { withinDays: 60, bonus: 5 },
  { withinDays: 120, bonus: 2 },
]

export const PASSED_DEADLINE_PENALTY = -25

/** Whole days from today to the deadline; null when there is no readable deadline. */
export function deadlineDays(p: Pick<Placement, 'exact_deadline'>, now = Date.now()): number | null {
  return daysUntil(p.exact_deadline, now)
}

export function deadlineBonus(days: number | null, status: ApplicationStatus): number {
  if (days === null) return 0
  if (days < 0) return PASSED_DEADLINE_PENALTY
  if (status !== 'Open Now') return 0
  for (const step of DEADLINE_BONUS) {
    if (days <= step.withinDays) return step.bonus
  }
  return 0
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value))
const score = (value: number | null | undefined) => clamp(Number(value ?? 0), 0, 10)

/**
 * The best-matching domain, not the average. A pure F1 aerodynamics role must
 * not be pushed down the board because its rocket/space score is zero.
 */
export function domainRelevance(p: Pick<Placement,
  | 'aerospace_relevance' | 'rocket_space_relevance' | 'f1_motorsport_relevance'
  | 'aero_cfd_relevance' | 'propulsion_relevance' | 'controls_avionics_relevance'>): number {
  return Math.max(
    score(p.aerospace_relevance), score(p.rocket_space_relevance), score(p.f1_motorsport_relevance),
    score(p.aero_cfd_relevance), score(p.propulsion_relevance), score(p.controls_avionics_relevance),
  )
}

/** Weighted fit out of 10, before availability, opportunity type and deadline. */
export function fitScore(p: Placement): number {
  return 0.45 * score(p.cv_fit)
    + 0.30 * domainRelevance(p)
    + 0.15 * score(p.career_value)
    + 0.10 * score(p.prestige)
}

/** 0-100. Identical to `placement_priority_score()` in Postgres. */
export function computePriorityScore(p: Placement, now = Date.now()): number {
  const raw = 8 * fitScore(p)
    + (STATUS_BONUS[p.application_status] ?? 0)
    + (TYPE_BONUS[p.opportunity_type] ?? -10)
    + deadlineBonus(deadlineDays(p, now), p.application_status)
  return clamp(Math.round(raw), 0, 100)
}

/** Identical to `placement_priority_band()` in Postgres. */
export function computePriorityBand(
  scoreValue: number,
  status: ApplicationStatus,
  days: number | null = null,
): OverallPriority {
  if (status === 'Closed') return 'LOW_PRIORITY'
  // A good role that closes this week outranks a better one that does not.
  if (status === 'Open Now' && days !== null && days >= 0 && days <= 7 && scoreValue >= 55) return 'APPLY_IMMEDIATELY'
  if (scoreValue >= 75 && status === 'Open Now') return 'APPLY_IMMEDIATELY'
  if (scoreValue >= 58 && (status === 'Opening Soon' || status === 'Expected')) return 'APPLY_WHEN_OPENING'
  if (scoreValue >= 58) return 'HIGH_PRIORITY_WATCH'
  if (scoreValue >= 42) return 'GOOD_BACKUP'
  return 'LOW_PRIORITY'
}

/** Computed live so the deadline countdown is never a day out of date. */
export function priorityScoreOf(p: Placement, now = Date.now()): number {
  return computePriorityScore(p, now)
}

export function priorityOf(p: Placement, now = Date.now()): OverallPriority {
  return computePriorityBand(priorityScoreOf(p, now), p.application_status, deadlineDays(p, now))
}

// --- Newly opened ----------------------------------------------------------

/**
 * True only on the calendar day on which this placement's applications opened.
 *
 * `opened_at` is stamped by the `placements_opening` Postgres trigger the moment
 * `application_status` becomes "Open Now". The New badge is intentionally a
 * same-calendar-day marker, not a rolling 10-day window: a role opened yesterday
 * or earlier must never continue to appear as New.
 */
export function isNewlyOpened(p: Pick<Placement, 'opened_at' | 'application_status'>, now = Date.now()): boolean {
  if (p.application_status !== 'Open Now' || !p.opened_at) return false
  const at = Date.parse(p.opened_at)
  if (Number.isNaN(at)) return false

  const opened = new Date(at)
  const current = new Date(now)
  return opened.getFullYear() === current.getFullYear()
    && opened.getMonth() === current.getMonth()
    && opened.getDate() === current.getDate()
}

/** "Opened today" / "Opened 3 days ago", for the marker's tooltip. */
export function openedAgo(p: Pick<Placement, 'opened_at'>, now = Date.now()): string | null {
  if (!p.opened_at) return null
  const at = Date.parse(p.opened_at)
  if (Number.isNaN(at)) return null
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) return 'Opened today'
  if (days === 1) return 'Opened yesterday'
  return `Opened ${days} days ago`
}

/** Human-readable breakdown shown on the card, so a rank is never a black box. */
export function explainScore(p: Placement, now = Date.now()): { label: string; value: string }[] {
  const statusBonus = STATUS_BONUS[p.application_status] ?? 0
  const typeBonus = TYPE_BONUS[p.opportunity_type] ?? -10
  const days = deadlineDays(p, now)
  const deadline = deadlineBonus(days, p.application_status)
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

  const deadlineLabel = days === null
    ? 'No deadline recorded'
    : days < 0
      ? `Deadline passed ${Math.abs(days)} days ago`
      : p.application_status === 'Open Now'
        ? `Deadline in ${days} days`
        : `Deadline in ${days} days (not open yet)`

  return [
    { label: 'CV fit (45%)', value: `${score(p.cv_fit)}/10` },
    { label: 'Best domain match (30%)', value: `${domainRelevance(p)}/10` },
    { label: 'Career value (15%)', value: `${score(p.career_value)}/10` },
    { label: 'Prestige (10%)', value: `${score(p.prestige)}/10` },
    { label: 'Weighted fit', value: `${(8 * fitScore(p)).toFixed(0)}/80` },
    { label: p.application_status, value: signed(statusBonus) },
    { label: p.opportunity_type, value: signed(typeBonus) },
    { label: deadlineLabel, value: signed(deadline) },
  ]
}
