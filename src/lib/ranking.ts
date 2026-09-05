import type { ApplicationStatus, OpportunityType, OverallPriority, Placement } from './supabase'

/**
 * Client-side mirror of the Postgres ranking installed by
 * `supabase/migrations/20260905120000_schema_cleanup_and_ranking.sql`
 * (`placement_priority_score` / `placement_priority_band`).
 *
 * Postgres is authoritative: a trigger recomputes `priority_score` and
 * `overall_priority` on every insert and update, so the browser normally just
 * reads them. This module exists so the two numbers stay explainable in the UI
 * ("why is this ranked here?") and so a row that predates the migration still
 * ranks sensibly. IF YOU CHANGE THE WEIGHTS, CHANGE THEM IN BOTH PLACES.
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

/** Weighted fit out of 10, before availability and opportunity type are applied. */
export function fitScore(p: Placement): number {
  return 0.45 * score(p.cv_fit)
    + 0.30 * domainRelevance(p)
    + 0.15 * score(p.career_value)
    + 0.10 * score(p.prestige)
}

/** 0-100. Identical to `placement_priority_score()` in Postgres. */
export function computePriorityScore(p: Placement): number {
  const raw = 8 * fitScore(p)
    + (STATUS_BONUS[p.application_status] ?? 0)
    + (TYPE_BONUS[p.opportunity_type] ?? -10)
  return clamp(Math.round(raw), 0, 100)
}

/** Identical to `placement_priority_band()` in Postgres. */
export function computePriorityBand(scoreValue: number, status: ApplicationStatus): OverallPriority {
  if (status === 'Closed') return 'LOW_PRIORITY'
  if (scoreValue >= 75 && status === 'Open Now') return 'APPLY_IMMEDIATELY'
  if (scoreValue >= 58 && (status === 'Opening Soon' || status === 'Expected')) return 'APPLY_WHEN_OPENING'
  if (scoreValue >= 58) return 'HIGH_PRIORITY_WATCH'
  if (scoreValue >= 42) return 'GOOD_BACKUP'
  return 'LOW_PRIORITY'
}

/** The stored score, falling back to a local computation for pre-migration rows. */
export function priorityScoreOf(p: Placement): number {
  return Number.isFinite(p.priority_score) && p.priority_score > 0
    ? p.priority_score
    : computePriorityScore(p)
}

export function priorityOf(p: Placement): OverallPriority {
  return p.overall_priority ?? computePriorityBand(priorityScoreOf(p), p.application_status)
}

/** Human-readable breakdown shown on the card, so a rank is never a black box. */
export function explainScore(p: Placement): { label: string; value: string }[] {
  const statusBonus = STATUS_BONUS[p.application_status] ?? 0
  const typeBonus = TYPE_BONUS[p.opportunity_type] ?? -10
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n))
  return [
    { label: 'CV fit (45%)', value: `${score(p.cv_fit)}/10` },
    { label: 'Best domain match (30%)', value: `${domainRelevance(p)}/10` },
    { label: 'Career value (15%)', value: `${score(p.career_value)}/10` },
    { label: 'Prestige (10%)', value: `${score(p.prestige)}/10` },
    { label: 'Weighted fit', value: `${(8 * fitScore(p)).toFixed(0)}/80` },
    { label: p.application_status, value: signed(statusBonus) },
    { label: p.opportunity_type, value: signed(typeBonus) },
  ]
}
