import * as XLSX from 'xlsx'
import type { Placement, OverallPriority } from './supabase'
import { PRIORITY_LABELS, PRIORITY_ORDER, sortPlacements } from './utils'

const COLUMN_HEADERS = [
  'Company', 'Sector', 'Country', 'City / Location', 'Website', 'Careers Page',
  'Specific Role', 'Department', 'Engineering Area', 'Opportunity Type', 'Placement Type', 'Placement Duration',
  'Placement Start Date', 'Placement End Date',
  'Application Status', 'Exact Opening Date', 'Exact Deadline', 'Deadline Type', 'Date Info Verified', 'Application Link',
  'Degree Requirements', 'Min Grade Requirement', 'Year of Study Requirement', 'Required Technical Skills',
  'Citizenship Requirement', 'Right to Work Requirement', 'Security Clearance Requirement', 'Visa Requirement',
  'Salary', 'Salary Period', 'Other Benefits',
  'CV Fit /10', 'Aerospace Relevance /10', 'Rocket/Space Relevance /10', 'F1/Motorsport Relevance /10',
  'Aerodynamics/CFD Relevance /10', 'Propulsion Relevance /10', 'Controls/Avionics Relevance /10',
  'Prestige /10', 'Career Value /10', 'Overall Priority', 'Why It Fits My CV', 'Potential Weaknesses',
  'Application Status (Tracking)', 'Date Applied', 'CV Version', 'Cover Letter Required?', 'Referral/Contact',
  'Interview Date', 'Outcome', 'Notes',
  'Source URL', 'Source Type', 'Date Checked', 'What Was Verified',
]

function placementToRow(p: Placement): (string | number)[] {
  return [
    p.company, p.sector ?? '', p.country ?? '', p.city ?? '', p.website ?? '', p.careers_page ?? '',
    p.specific_role ?? '', p.department ?? '', p.engineering_area ?? '', p.opportunity_type ?? '', p.placement_type ?? '', p.placement_duration ?? '',
    p.placement_start_date ?? '', p.placement_end_date ?? '',
    p.application_status ?? '', p.exact_opening_date ?? '', p.exact_deadline ?? '', p.deadline_type ?? '', p.date_info_verified ?? '', p.application_link ?? '',
    p.degree_requirements ?? '', p.min_grade_requirement ?? '', p.year_of_study_requirement ?? '', p.required_technical_skills ?? '',
    p.citizenship_requirement ?? '', p.right_to_work_requirement ?? '', p.security_clearance_requirement ?? '', p.visa_requirement ?? '',
    p.salary ?? '', p.salary_period ?? '', p.other_benefits ?? '',
    p.cv_fit ?? '', p.aerospace_relevance ?? '', p.rocket_space_relevance ?? '', p.f1_motorsport_relevance ?? '',
    p.aero_cfd_relevance ?? '', p.propulsion_relevance ?? '', p.controls_avionics_relevance ?? '',
    p.prestige ?? '', p.career_value ?? '',
    p.overall_priority ? PRIORITY_LABELS[p.overall_priority as OverallPriority] : '',
    p.why_it_fits ?? '', p.potential_weaknesses ?? '',
    p.app_status ?? '', p.date_applied ?? '', p.cv_version ?? '', p.cover_letter_required ?? '', p.referral_contact ?? '',
    p.interview_date ?? '', p.outcome ?? '', p.notes ?? '',
    p.source_url ?? '', p.source_type ?? '', p.source_date_checked ?? '', p.source_verified ?? '',
  ]
}

function autoWidth(ws: XLSX.WorkSheet, headers: string[]) {
  const colWidths = headers.map((h) => ({ wch: Math.max(h.length + 2, 12) }))
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1')
  for (let r = 1; r <= range.e.r; r++) {
    for (let c = 0; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell && cell.v != null) {
        const len = String(cell.v).length
        if (len + 2 > colWidths[c]?.wch) colWidths[c].wch = Math.min(len + 2, 60)
      }
    }
  }
  ws['!cols'] = colWidths
}

function buildMasterSheet(placements: Placement[]): XLSX.WorkSheet {
  const sorted = sortPlacements(placements)
  const rows = sorted.map(placementToRow)
  const ws = XLSX.utils.aoa_to_sheet([COLUMN_HEADERS, ...rows])
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }
  ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_cell({ r: 0, c: COLUMN_HEADERS.length - 1 })}` }
  autoWidth(ws, COLUMN_HEADERS)
  return ws
}

function buildApplyNowSheet(placements: Placement[]): XLSX.WorkSheet {
  const filtered = sortPlacements(placements.filter((p) => p.application_status === 'Open Now'))
  const rows = filtered.map(placementToRow)
  const ws = XLSX.utils.aoa_to_sheet([COLUMN_HEADERS, ...rows])
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }
  autoWidth(ws, COLUMN_HEADERS)
  return ws
}

function buildOpeningSoonSheet(placements: Placement[]): XLSX.WorkSheet {
  const filtered = placements
    .filter((p) => p.application_status === 'Opening Soon')
    .sort((a, b) => (a.exact_opening_date ?? 'zzz').localeCompare(b.exact_opening_date ?? 'zzz'))
  const rows = filtered.map(placementToRow)
  const ws = XLSX.utils.aoa_to_sheet([COLUMN_HEADERS, ...rows])
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }
  autoWidth(ws, COLUMN_HEADERS)
  return ws
}

function buildTop25Sheet(placements: Placement[]): XLSX.WorkSheet {
  const sorted = sortPlacements(placements).slice(0, 25)
  const headers = ['Rank', 'Company', 'Opportunity Type', 'Sector', 'Role', 'CV Fit /10', 'Overall Priority', 'Application Status', 'Why It Fits']
  const rows = sorted.map((p, i) => [
    i + 1, p.company, p.opportunity_type ?? '', p.sector ?? '', p.specific_role ?? '', p.cv_fit ?? '',
    p.overall_priority ? PRIORITY_LABELS[p.overall_priority as OverallPriority] : '',
    p.application_status ?? '', p.why_it_fits ?? '',
  ])
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }
  autoWidth(ws, headers)
  return ws
}

function buildSectorSheet(placements: Placement[], sector: string): XLSX.WorkSheet {
  const filtered = sortPlacements(placements.filter((p) => p.sector === sector))
  const rows = filtered.map(placementToRow)
  const ws = XLSX.utils.aoa_to_sheet([COLUMN_HEADERS, ...rows])
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }
  autoWidth(ws, COLUMN_HEADERS)
  return ws
}

function buildAppTrackerSheet(placements: Placement[]): XLSX.WorkSheet {
  const headers = ['Company', 'Role', 'Opportunity Type', 'Deadline', 'Priority', 'Applied?', 'Date Applied', 'Interview?', 'Offer?', 'Rejected?', 'Notes']
  const sorted = sortPlacements(placements)
  const rows = sorted.map((p) => [
    p.company, p.specific_role ?? '', p.opportunity_type ?? '', p.exact_deadline ?? '',
    p.overall_priority ? PRIORITY_LABELS[p.overall_priority as OverallPriority] : '',
    p.app_status ?? 'Not Applied', p.date_applied ?? '',
    p.app_status === 'Interview' ? 'Yes' : '', p.app_status === 'Offer' ? 'Yes' : '',
    p.app_status === 'Rejected' ? 'Yes' : '', p.notes ?? '',
  ])
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }
  autoWidth(ws, headers)
  return ws
}

function buildSourcesSheet(placements: Placement[]): XLSX.WorkSheet {
  const headers = ['Company', 'Opportunity Type', 'Source URL', 'Source Type', 'Date Checked', 'What Was Verified']
  const sorted = sortPlacements(placements)
  const rows = sorted.map((p) => [
    p.company, p.opportunity_type ?? '', p.source_url ?? '', p.source_type ?? '', p.source_date_checked ?? '', p.source_verified ?? '',
  ])
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }
  autoWidth(ws, headers)
  return ws
}

export function downloadExcel(placements: Placement[]) {
  const wb = XLSX.utils.book_new()

  XLSX.utils.book_append_sheet(wb, buildMasterSheet(placements), 'MASTER TRACKER')
  XLSX.utils.book_append_sheet(wb, buildApplyNowSheet(placements), 'APPLY NOW')
  XLSX.utils.book_append_sheet(wb, buildOpeningSoonSheet(placements), 'OPENING SOON')
  XLSX.utils.book_append_sheet(wb, buildTop25Sheet(placements), 'TOP 25')
  XLSX.utils.book_append_sheet(wb, buildSectorSheet(placements, 'Motorsport'), 'MOTORSPORT')
  XLSX.utils.book_append_sheet(wb, buildSectorSheet(placements, 'Aerospace & Space'), 'AEROSPACE & SPACE')
  XLSX.utils.book_append_sheet(wb, buildSectorSheet(placements, 'Defence'), 'DEFENCE')
  XLSX.utils.book_append_sheet(wb, buildSectorSheet(placements, 'Engineering & Technology'), 'ENGINEERING & TECHNOLOGY')
  XLSX.utils.book_append_sheet(wb, buildSectorSheet(placements, 'Research & Advanced Tech'), 'RESEARCH & ADVANCED TECH')
  XLSX.utils.book_append_sheet(wb, buildAppTrackerSheet(placements), 'APPLICATION TRACKER')
  XLSX.utils.book_append_sheet(wb, buildSourcesSheet(placements), 'SOURCES')

  XLSX.writeFile(wb, '2027_Aerospace_Space_F1_Industrial_Placement_Tracker.xlsx')
}
