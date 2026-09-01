import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: { params: { eventsPerSecond: 10 } },
})

export type ApplicationStatus = 'Open Now' | 'Opening Soon' | 'Expected' | 'Not Yet Published' | 'Closed'
export type OverallPriority = 'APPLY_IMMEDIATELY' | 'APPLY_WHEN_OPENING' | 'HIGH_PRIORITY_WATCH' | 'GOOD_BACKUP' | 'LOW_PRIORITY'
export type AppStatus = 'Not Applied' | 'Saved' | 'Applied' | 'Assessment' | 'Interview' | 'Final Interview' | 'Offer' | 'Accepted' | 'Rejected' | 'Withdrawn'
export type OpportunityType = 'Industrial Placement' | 'Spring Week / Insight' | 'Internship / Co-op' | 'Other Student Programme'

export interface Placement {
  id: string
  company: string
  sector: string | null
  country: string | null
  city: string | null
  website: string | null
  careers_page: string | null
  specific_role: string | null
  department: string | null
  engineering_area: string | null
  opportunity_type: string | null
  placement_type: string | null
  placement_duration: string | null
  placement_start_date: string | null
  placement_end_date: string | null
  application_status: string | null
  exact_opening_date: string | null
  exact_deadline: string | null
  deadline_type: string | null
  date_info_verified: string | null
  application_link: string | null
  degree_requirements: string | null
  min_grade_requirement: string | null
  year_of_study_requirement: string | null
  required_technical_skills: string | null
  citizenship_requirement: string | null
  right_to_work_requirement: string | null
  security_clearance_requirement: string | null
  visa_requirement: string | null
  salary: string | null
  salary_period: string | null
  other_benefits: string | null
  cv_fit: number | null
  aerospace_relevance: number | null
  rocket_space_relevance: number | null
  f1_motorsport_relevance: number | null
  aero_cfd_relevance: number | null
  propulsion_relevance: number | null
  controls_avionics_relevance: number | null
  prestige: number | null
  career_value: number | null
  overall_priority: string | null
  why_it_fits: string | null
  potential_weaknesses: string | null
  app_status: string | null
  date_applied: string | null
  cv_version: string | null
  cover_letter_required: string | null
  referral_contact: string | null
  interview_date: string | null
  outcome: string | null
  notes: string | null
  not_interested: boolean | null
  source_url: string | null
  source_type: string | null
  source_date_checked: string | null
  source_verified: string | null
  created_at: string
  updated_at: string
}
