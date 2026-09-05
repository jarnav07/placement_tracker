import * as XLSX from 'xlsx'
import type { Placement } from './supabase'
import { PRIORITY_LONG_LABELS } from './utils'
import { priorityOf, priorityScoreOf, domainRelevance } from './ranking'
import { SECTOR_GROUPS, sectorGroup, sortPlacements, type SectorGroup } from './filtering'

const COLUMNS: { header: string; value: (p: Placement) => string | number }[] = [
  { header: 'Rank score /100', value: p => priorityScoreOf(p) },
  { header: 'Overall priority', value: p => PRIORITY_LONG_LABELS[priorityOf(p)] },
  { header: 'Company', value: p => p.company },
  { header: 'Specific role', value: p => p.specific_role },
  { header: 'Opportunity type', value: p => p.opportunity_type },
  { header: 'Application status', value: p => p.application_status },
  { header: 'Sector group', value: p => sectorGroup(p) },
  { header: 'Engineering area', value: p => p.engineering_area ?? '' },
  { header: 'City', value: p => p.city ?? '' },
  { header: 'Country', value: p => p.country ?? '' },
  { header: 'Start year', value: p => p.start_year ?? '' },
  { header: 'Opening date', value: p => p.exact_opening_date ?? '' },
  { header: 'Deadline', value: p => p.exact_deadline ?? '' },
  { header: 'Deadline type', value: p => p.deadline_type ?? '' },
  { header: 'Duration', value: p => p.placement_duration ?? '' },
  { header: 'Placement start', value: p => p.placement_start_date ?? '' },
  { header: 'Placement end', value: p => p.placement_end_date ?? '' },
  { header: 'Salary', value: p => p.salary ?? '' },
  { header: 'Other benefits', value: p => p.other_benefits ?? '' },
  { header: 'CV fit /10', value: p => p.cv_fit ?? '' },
  { header: 'Best domain match /10', value: p => domainRelevance(p) },
  { header: 'Aerospace /10', value: p => p.aerospace_relevance ?? '' },
  { header: 'Rocket & space /10', value: p => p.rocket_space_relevance ?? '' },
  { header: 'F1 & motorsport /10', value: p => p.f1_motorsport_relevance ?? '' },
  { header: 'Aero & CFD /10', value: p => p.aero_cfd_relevance ?? '' },
  { header: 'Propulsion /10', value: p => p.propulsion_relevance ?? '' },
  { header: 'Controls & avionics /10', value: p => p.controls_avionics_relevance ?? '' },
  { header: 'Prestige /10', value: p => p.prestige ?? '' },
  { header: 'Career value /10', value: p => p.career_value ?? '' },
  { header: 'Why it fits', value: p => p.why_it_fits ?? '' },
  { header: 'Potential weaknesses', value: p => p.potential_weaknesses ?? '' },
  { header: 'Degree requirements', value: p => p.degree_requirements ?? '' },
  { header: 'Minimum grade', value: p => p.min_grade_requirement ?? '' },
  { header: 'Year of study', value: p => p.year_of_study_requirement ?? '' },
  { header: 'Technical skills', value: p => p.required_technical_skills ?? '' },
  { header: 'Work eligibility', value: p => p.work_eligibility ?? '' },
  { header: 'Security clearance', value: p => p.security_clearance_requirement ?? '' },
  { header: 'Application link', value: p => p.application_link ?? '' },
  { header: 'Careers page', value: p => p.careers_page ?? '' },
  { header: 'Website', value: p => p.website ?? '' },
  { header: 'My stage', value: p => p.app_status },
  { header: 'Date applied', value: p => p.date_applied ?? '' },
  { header: 'CV version', value: p => p.cv_version ?? '' },
  { header: 'Cover letter', value: p => p.cover_letter_required ?? '' },
  { header: 'Referral / contact', value: p => p.referral_contact ?? '' },
  { header: 'Interview date', value: p => p.interview_date ?? '' },
  { header: 'My notes', value: p => p.notes ?? '' },
  { header: 'Not interested', value: p => (p.not_interested ? 'Yes' : '') },
  { header: 'Last verified', value: p => p.source_date_checked ?? '' },
  { header: 'Verification evidence', value: p => p.source_verified ?? '' },
]

const HEADERS = COLUMNS.map(column => column.header)

function autoWidth(sheet: XLSX.WorkSheet, headers: string[]) {
  const widths = headers.map(header => ({ wch: Math.max(header.length + 2, 12) }))
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1')
  for (let row = 1; row <= range.e.r; row++) {
    for (let col = 0; col <= range.e.c; col++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })]
      if (cell?.v == null || !widths[col]) continue
      widths[col].wch = Math.min(Math.max(widths[col].wch, String(cell.v).length + 2), 60)
    }
  }
  sheet['!cols'] = widths
}

function sheetFrom(headers: string[], rows: (string | number)[][]): XLSX.WorkSheet {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows])
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 }
  sheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_cell({ r: 0, c: headers.length - 1 })}` }
  autoWidth(sheet, headers)
  return sheet
}

function fullSheet(placements: Placement[]): XLSX.WorkSheet {
  const ranked = sortPlacements(placements, 'priority')
  return sheetFrom(HEADERS, ranked.map(p => COLUMNS.map(column => column.value(p))))
}

function shortlistSheet(placements: Placement[]): XLSX.WorkSheet {
  const headers = ['Rank', 'Score /100', 'Priority', 'Company', 'Role', 'Type', 'Status', 'Deadline', 'CV fit', 'Why it fits', 'Apply']
  const rows = sortPlacements(placements, 'priority').slice(0, 40).map((p, index) => [
    index + 1, priorityScoreOf(p), PRIORITY_LONG_LABELS[priorityOf(p)], p.company, p.specific_role,
    p.opportunity_type, p.application_status, p.exact_deadline ?? '', p.cv_fit ?? '',
    p.why_it_fits ?? '', p.application_link ?? '',
  ])
  return sheetFrom(headers, rows)
}

function pipelineSheet(placements: Placement[]): XLSX.WorkSheet {
  const headers = ['Company', 'Role', 'Stage', 'Date applied', 'Interview date', 'CV version', 'Cover letter', 'Referral', 'Deadline', 'Notes']
  const rows = sortPlacements(placements.filter(p => p.app_status !== 'Not Applied'), 'deadline').map(p => [
    p.company, p.specific_role, p.app_status, p.date_applied ?? '', p.interview_date ?? '',
    p.cv_version ?? '', p.cover_letter_required ?? '', p.referral_contact ?? '', p.exact_deadline ?? '', p.notes ?? '',
  ])
  return sheetFrom(headers, rows)
}

function sectorSheet(placements: Placement[], sector: SectorGroup): XLSX.WorkSheet {
  // Filters on the DERIVED sector group, not the raw column: the raw values are
  // employer free text and would leave most of these sheets empty.
  return fullSheet(placements.filter(p => sectorGroup(p) === sector))
}

const SHEET_NAMES: Record<SectorGroup, string> = {
  'Aerospace & Space': 'Aerospace & Space',
  'Defence': 'Defence',
  'Motorsport': 'Motorsport',
  'Engineering & Technology': 'Engineering & Tech',
  'Research & Advanced Tech': 'Research',
}

export function downloadExcel(placements: Placement[]) {
  // The export mirrors the board: archived scrape artefacts are excluded,
  // Not Interested roles are kept but flagged in their own column.
  const tracked = placements.filter(p => !p.archived)
  const active = tracked.filter(p => !p.not_interested)
  const workbook = XLSX.utils.book_new()

  XLSX.utils.book_append_sheet(workbook, shortlistSheet(active), 'Top 40')
  XLSX.utils.book_append_sheet(workbook, fullSheet(tracked), 'All roles')
  XLSX.utils.book_append_sheet(workbook, fullSheet(active.filter(p => p.application_status === 'Open Now')), 'Open now')
  XLSX.utils.book_append_sheet(workbook, fullSheet(active.filter(p => p.application_status === 'Opening Soon')), 'Opening soon')
  XLSX.utils.book_append_sheet(workbook, pipelineSheet(tracked), 'My pipeline')
  for (const sector of SECTOR_GROUPS) {
    XLSX.utils.book_append_sheet(workbook, sectorSheet(active, sector), SHEET_NAMES[sector])
  }

  const stamp = new Date().toISOString().slice(0, 10)
  XLSX.writeFile(workbook, `placement-tracker-2027-${stamp}.xlsx`)
}
