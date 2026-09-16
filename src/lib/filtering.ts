import type { AppStatus, ApplicationStatus, OpportunityType, OverallPriority, Placement } from './supabase'
import { priorityOf, priorityScoreOf, isNewlyOpened } from './ranking'
import { parseDate, daysUntil, STAGE_RANK } from './utils'

export const COUNTRY_GROUPS = ['UK', 'Europe', 'America', 'Asia', 'Oceania'] as const
export type CountryGroup = (typeof COUNTRY_GROUPS)[number]

export const SECTOR_GROUPS = [
  'Aerospace & Space', 'Defence', 'Motorsport', 'Engineering & Technology', 'Research & Advanced Tech',
] as const
export type SectorGroup = (typeof SECTOR_GROUPS)[number]

export const SORT_OPTIONS = {
  priority: 'Best match',
  newest: 'Just opened',
  deadline: 'Deadline first',
  opening: 'Opening date',
  cv_fit: 'CV fit',
  company: 'Company A–Z',
  recent: 'Recently verified',
  stage: 'Pipeline stage',
  applied: 'Recently applied',
} as const
export type SortOption = keyof typeof SORT_OPTIONS

export type View = 'opportunities' | 'saved' | 'applications' | 'not-interested'

/**
 * Where each view starts. The applications view is a record of what the user
 * has done, so it opens on the pipeline rather than on a match score that a
 * closed vacancy drags to the bottom; the saved list is a to-do list, so it
 * opens on what runs out first.
 */
export const DEFAULT_SORT: Record<View, SortOption> = {
  opportunities: 'priority',
  saved: 'deadline',
  applications: 'stage',
  'not-interested': 'priority',
}

export interface Filters {
  priority: OverallPriority | 'all'
  sector: SectorGroup | 'all'
  country: CountryGroup | 'all'
  status: ApplicationStatus | 'all'
  opportunityType: OpportunityType | 'all'
  stage: AppStatus | 'all'
  search: string
}

export const EMPTY_FILTERS: Filters = {
  priority: 'all', sector: 'all', country: 'all', status: 'all', opportunityType: 'all', stage: 'all', search: '',
}

export function hasActiveFilters(f: Filters): boolean {
  return (Object.keys(EMPTY_FILTERS) as (keyof Filters)[]).some(key => f[key] !== EMPTY_FILTERS[key])
}

/**
 * Filters that describe the VACANCY rather than the user's own record, and so
 * have no business narrowing the applications tab.
 *
 * This is the bug that lost applications: clicking the "Open now" stat sets
 * `status: 'Open Now'`, and the filter survived the move to the applications
 * tab, where every role the user had applied to and that had since closed was
 * silently filtered out. `changeView` clears these on the way in and
 * `Filters` does not render their controls there, so an application can never
 * be hidden by the vacancy's availability or by the priority band that a
 * closed role always falls into.
 */
export const VACANCY_FILTERS: Pick<Filters, 'priority' | 'status'> = { priority: 'all', status: 'all' }

// --- Normalisation -------------------------------------------------------
// The migration normalises these columns in the database, but the browser
// re-normalises defensively so a row written by an older agent still lands in
// the right filter bucket instead of silently disappearing from every view.

const UK = /\b(uk|united kingdom|great britain|britain|england|scotland|wales|northern ireland)\b/
const OCEANIA = /\b(australia|new zealand|papua new guinea|fiji|samoa|tonga|vanuatu|solomon islands|micronesia|palau|marshall islands|kiribati|nauru|tuvalu)\b/
const AMERICAS = /\b(usa|us|united states|america|canada|mexico|brazil|argentina|chile|colombia|peru|uruguay|paraguay|bolivia|ecuador|venezuela|guyana|suriname|panama|costa rica|nicaragua|honduras|el salvador|guatemala|belize|cuba|jamaica|haiti|bahamas|barbados|trinidad and tobago|puerto rico)\b/
const EUROPE = /\b(albania|andorra|austria|belarus|belgium|bosnia|bulgaria|croatia|czech(ia)?|denmark|estonia|finland|france|germany|greece|hungary|iceland|ireland|italy|kosovo|latvia|liechtenstein|lithuania|luxembourg|malta|moldova|monaco|montenegro|netherlands|norway|poland|portugal|romania|san marino|serbia|slovakia|slovenia|spain|sweden|switzerland|ukraine|europe)\b/
const ASIA = /\b(afghanistan|armenia|azerbaijan|bahrain|bangladesh|bhutan|brunei|cambodia|china|georgia|india|indonesia|iran|iraq|israel|japan|jordan|kazakhstan|kuwait|kyrgyzstan|laos|lebanon|malaysia|maldives|mongolia|myanmar|nepal|north korea|oman|pakistan|palestine|philippines|qatar|saudi arabia|singapore|south korea|sri lanka|taiwan|tajikistan|thailand|timor-leste|turkey|turkmenistan|uae|united arab emirates|uzbekistan|vietnam|yemen|hong kong|macau|shanghai|shenzhen|beijing|bangalore|tokyo)\b/

const lower = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

/** Returns null when the location genuinely cannot be placed, rather than guessing "Europe". */
export function countryGroup(p: Pick<Placement, 'country' | 'city' | 'company'>): CountryGroup | null {
  const text = `${lower(p.country)} ${lower(p.city)} ${lower(p.company)}`
  if (UK.test(text)) return 'UK'
  if (OCEANIA.test(text)) return 'Oceania'
  if (AMERICAS.test(text)) return 'America'
  if (ASIA.test(text)) return 'Asia'
  if (EUROPE.test(text)) return 'Europe'
  return null
}

export function sectorGroup(p: Pick<Placement, 'sector' | 'company' | 'engineering_area'>): SectorGroup {
  const text = `${lower(p.sector)} ${lower(p.company)} ${lower(p.engineering_area)}`
  if (/motorsport|formula|f1|racing|race car/.test(text)) return 'Motorsport'
  if (/defence|defense|military/.test(text)) return 'Defence'
  if (/research|laborator|university|r&d/.test(text)) return 'Research & Advanced Tech'
  if (/space|rocket|launch|aerospace|aviation|aircraft|satellite|propulsion/.test(text)) return 'Aerospace & Space'
  return 'Engineering & Technology'
}

// Date parsing lives in `./utils` (ranking.ts needs it, and this module imports
// ranking.ts). Re-exported here so the components' existing imports keep working.
export { parseDate, daysUntil }

// --- Views ---------------------------------------------------------------

/** True once the user has actually applied. `Saved` is a shortlist marker, not an application. */
export function hasApplication(p: Pick<Placement, 'app_status'>): boolean {
  return p.app_status !== 'Not Applied' && p.app_status !== 'Saved'
}

/** Marked "I want to apply to this" and not yet applied to. */
export function isSaved(p: Pick<Placement, 'app_status'>): boolean {
  return p.app_status === 'Saved'
}

/**
 * `archived` rows are links the crawler mistook for a vacancy. They are hidden
 * from the browsing views — there is deliberately no archive tab — but the rows
 * are kept, so a mis-archived role can be restored with a single SQL update.
 *
 * `not_interested` is the user's own rejection and keeps its own view.
 *
 * THE ONE THING THAT OVERRIDES BOTH: a role the user has saved or applied to is
 * the user's own record, and nothing the automation later decides about the
 * vacancy may take it out of its tab. A closed vacancy, a row the crawler
 * re-classified as archived, even a later "not interested" — the application
 * still happened and is the only trace of it in the app. Availability is shown
 * on the card instead, so a closed role reads as closed rather than vanishing.
 */
export function placementsForView(placements: Placement[], view: View): Placement[] {
  switch (view) {
    case 'applications': return placements.filter(hasApplication)
    case 'saved': return placements.filter(isSaved)
    case 'not-interested': return placements.filter(p => !p.archived && p.not_interested)
    // Saved and applied roles stay on the board too — that is where the Save
    // button lives, so removing them would leave no way to undo a save.
    default: return placements.filter(p => !p.archived && !p.not_interested)
  }
}

const SEARCHABLE: (keyof Placement)[] = [
  'company', 'specific_role', 'sector', 'city', 'country', 'engineering_area',
  'opportunity_type', 'placement_duration', 'degree_requirements', 'required_technical_skills',
  'why_it_fits', 'potential_weaknesses', 'notes', 'cv_version', 'referral_contact', 'salary',
]

export function filterPlacements(placements: Placement[], filters: Filters): Placement[] {
  const query = filters.search.trim().toLowerCase()
  const terms = query ? query.split(/\s+/) : []

  return placements.filter(p => {
    if (filters.priority !== 'all' && priorityOf(p) !== filters.priority) return false
    if (filters.status !== 'all' && p.application_status !== filters.status) return false
    if (filters.opportunityType !== 'all' && p.opportunity_type !== filters.opportunityType) return false
    if (filters.sector !== 'all' && sectorGroup(p) !== filters.sector) return false
    if (filters.country !== 'all' && countryGroup(p) !== filters.country) return false
    if (filters.stage !== 'all' && p.app_status !== filters.stage) return false
    if (!terms.length) return true

    const haystack = SEARCHABLE.map(key => p[key]).filter(Boolean).join(' ').toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

// --- Sorting -------------------------------------------------------------
//
// Every role is ranked on its own merits. Roles are NEVER collapsed per company:
// a company can run several distinct placements and each one carries its own
// CV fit, priority band and deadline.

/**
 * Newest first, with rows that carry no date still last. Reversing `byDate`'s
 * arguments would reverse its null handling too and float the undated rows to
 * the top, which on "recently applied" is exactly the wrong end.
 */
function byDateDesc(a: string | null, b: string | null): number {
  const left = parseDate(a)
  const right = parseDate(b)
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return right - left
}

/** Rows with no date sort last, in every date-based order. */
function byDate(a: string | null, b: string | null): number {
  const left = parseDate(a)
  const right = parseDate(b)
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left - right
}

export function sortPlacements(placements: Placement[], sort: SortOption): Placement[] {
  const rank = (p: Placement) => priorityScoreOf(p)
  const tiebreak = (a: Placement, b: Placement) =>
    rank(b) - rank(a)
    || (b.cv_fit ?? 0) - (a.cv_fit ?? 0)
    || a.company.localeCompare(b.company)
    || a.specific_role.localeCompare(b.specific_role)

  /** Most recently opened first; roles that have never opened sort last. */
  const byOpening = (a: Placement, b: Placement) => {
    const left = a.opened_at ? Date.parse(a.opened_at) : NaN
    const right = b.opened_at ? Date.parse(b.opened_at) : NaN
    if (Number.isNaN(left) && Number.isNaN(right)) return 0
    if (Number.isNaN(left)) return 1
    if (Number.isNaN(right)) return -1
    return right - left
  }

  return [...placements].sort((a, b) => {
    switch (sort) {
      case 'stage':
        // Furthest through the pipeline first, terminal outcomes last, then the
        // most recent application. A closed vacancy must not sink an offer.
        return STAGE_RANK[a.app_status] - STAGE_RANK[b.app_status]
          || byDateDesc(a.date_applied, b.date_applied)
          || a.company.localeCompare(b.company)
      case 'applied':
        return byDateDesc(a.date_applied, b.date_applied) || tiebreak(a, b)
      case 'company':
        return a.company.localeCompare(b.company) || a.specific_role.localeCompare(b.specific_role)
      case 'newest':
        // Freshly opened roles first — the ones the user has not seen yet.
        return (Number(isNewlyOpened(b)) - Number(isNewlyOpened(a))) || byOpening(a, b) || tiebreak(a, b)
      case 'deadline':
        return byDate(a.exact_deadline, b.exact_deadline) || tiebreak(a, b)
      case 'opening':
        return byDate(a.exact_opening_date, b.exact_opening_date) || tiebreak(a, b)
      case 'cv_fit':
        return (b.cv_fit ?? 0) - (a.cv_fit ?? 0) || tiebreak(a, b)
      case 'recent':
        return byDate(b.source_date_checked, a.source_date_checked) || tiebreak(a, b)
      default:
        return tiebreak(a, b)
    }
  })
}

export function countBy<T extends string>(placements: Placement[], key: (p: Placement) => T | null): Record<T, number> {
  const counts = {} as Record<T, number>
  for (const p of placements) {
    const value = key(p)
    if (value === null) continue
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}
