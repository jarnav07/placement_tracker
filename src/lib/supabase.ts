import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: { params: { eventsPerSecond: 10 } },
})

/** Public availability of the opportunity itself. Maintained by the audit. */
export const APPLICATION_STATUSES = [
  'Open Now', 'Opening Soon', 'Expected', 'Not Yet Published', 'Closed', 'Unknown',
] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

/** Derived in Postgres by `placement_priority_band()`. Never written by hand. */
export const PRIORITIES = [
  'APPLY_IMMEDIATELY', 'APPLY_WHEN_OPENING', 'HIGH_PRIORITY_WATCH', 'GOOD_BACKUP', 'LOW_PRIORITY',
] as const
export type OverallPriority = (typeof PRIORITIES)[number]

/** The user's own progress on an application. Never written by automation. */
export const APP_STATUSES = [
  'Not Applied', 'Saved', 'Applied', 'Assessment', 'Interview',
  'Final Interview', 'Offer', 'Accepted', 'Rejected', 'Withdrawn',
] as const
export type AppStatus = (typeof APP_STATUSES)[number]

export const OPPORTUNITY_TYPES = [
  'Industrial Placement', 'Spring Week / Insight', 'Internship / Co-op', 'Other Student Programme',
] as const
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number]

export const DEADLINE_TYPES = ['Rolling', 'Fixed', 'Vacancy dependent', 'TBC'] as const
export type DeadlineType = (typeof DEADLINE_TYPES)[number]

/**
 * Mirrors `public.placements`. Grouped the same way the card is laid out.
 *
 * Ownership matters and is enforced by the automation:
 *   - RESEARCHED fields are written by the audit and may be overwritten at any time.
 *   - DERIVED fields are computed by a Postgres trigger and must never be written.
 *   - USER fields are the user's alone and automation must never touch them.
 */
export interface Placement {
  id: string
  created_at: string
  updated_at: string

  // --- Identity (researched, but never rewritten once tracked) ---
  company: string
  specific_role: string
  start_year: number | null

  // --- Classification (researched) ---
  sector: string | null
  engineering_area: string | null
  opportunity_type: OpportunityType
  country: string | null
  city: string | null

  // --- Programme (researched) ---
  placement_duration: string | null
  placement_start_date: string | null
  placement_end_date: string | null
  salary: string | null
  other_benefits: string | null

  // --- Availability (researched) ---
  application_status: ApplicationStatus
  exact_opening_date: string | null
  exact_deadline: string | null
  deadline_type: DeadlineType | null

  // --- Links (researched) ---
  website: string | null
  careers_page: string | null
  application_link: string | null

  // --- Eligibility (researched) ---
  degree_requirements: string | null
  min_grade_requirement: string | null
  year_of_study_requirement: string | null
  required_technical_skills: string | null
  work_eligibility: string | null
  security_clearance_requirement: string | null

  // --- Fit scoring, 0-10 (researched) ---
  cv_fit: number | null
  aerospace_relevance: number | null
  rocket_space_relevance: number | null
  f1_motorsport_relevance: number | null
  aero_cfd_relevance: number | null
  propulsion_relevance: number | null
  controls_avionics_relevance: number | null
  prestige: number | null
  career_value: number | null
  why_it_fits: string | null
  potential_weaknesses: string | null

  // --- Ranking (DERIVED in Postgres — read-only) ---
  priority_score: number
  overall_priority: OverallPriority

  // --- Verification trail (researched) ---
  source_date_checked: string | null
  source_verified: string | null

  // --- User-owned ---
  app_status: AppStatus
  date_applied: string | null
  cv_version: string | null
  cover_letter_required: string | null
  referral_contact: string | null
  interview_date: string | null
  notes: string | null
  not_interested: boolean
  archived: boolean
}

/** Columns the browser is allowed to write. Everything else is read-only here. */
export const USER_EDITABLE_FIELDS = [
  'app_status', 'date_applied', 'cv_version', 'cover_letter_required',
  'referral_contact', 'interview_date', 'notes', 'not_interested', 'archived',
] as const
export type UserEditableField = (typeof USER_EDITABLE_FIELDS)[number]
export type PlacementPatch = Partial<Pick<Placement, UserEditableField>>
