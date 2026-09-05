import type { ApplicationStatus, OverallPriority } from './supabase'

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
