// Guards the rules this project keeps breaking. Runs offline, in CI and locally:
//
//   npm run check
//
// 1. The TypeScript ranking mirrors the Postgres ranking exactly.
// 2. Automation never writes IDENTITY, DERIVED or USER-OWNED columns.
// 3. The browser never writes a researched column.
// 4. The board never collapses several roles at one company into one card.
// 5. The role-quality gate still rejects the scrape artefacts that polluted
//    the tracker, and still accepts real vacancies.
// 6. Every source file references only columns that still exist.

import fs from 'node:fs'
import { looksLikeStudentRole, classifyOpportunity } from './role-quality.mjs'

const read = path => fs.readFileSync(path, 'utf8')
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`PASS  ${label}`)
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

// --- 1. Ranking parity ------------------------------------------------------

const squash = text => text.replace(/\s+/g, ' ')
const migration = squash(read('supabase/migrations/20260905120000_schema_cleanup_and_ranking.sql'))
const ranking = squash(read('src/lib/ranking.ts'))

for (const [label, weight] of [['cv_fit', '0.45'], ['domain', '0.30'], ['career_value', '0.15'], ['prestige', '0.10']]) {
  check(`ranking weight for ${label} (${weight}) matches SQL and TypeScript`,
    migration.includes(`${weight} * `) && ranking.includes(`${weight} * `))
}
for (const [status, bonus] of [['Open Now', '18'], ['Opening Soon', '10'], ['Expected', '4'], ['Closed', '-40']]) {
  check(`status bonus ${status} = ${bonus} in both implementations`,
    migration.includes(`WHEN '${status}' THEN ${bonus}`) && ranking.includes(`'${status}': ${bonus},`))
}
for (const threshold of ['75', '58', '42']) {
  check(`priority band threshold ${threshold} present in both implementations`,
    migration.includes(`p_score >= ${threshold}`) && ranking.includes(`>= ${threshold}`))
}

// --- 2/3. Column ownership --------------------------------------------------

const USER_OWNED = ['app_status', 'date_applied', 'cv_version', 'cover_letter_required',
  'referral_contact', 'interview_date', 'notes', 'not_interested', 'archived']
const DERIVED = ['priority_score', 'overall_priority']
const IDENTITY = ['company', 'specific_role']

const azure = read('scripts/azure-placement-audit.mjs')
const researchedBlock = azure.slice(azure.indexOf('const RESEARCHED_FIELDS'), azure.indexOf('const SCORE_FIELDS'))

for (const column of [...USER_OWNED, ...DERIVED, ...IDENTITY]) {
  check(`audit never lists '${column}' as a researched (writable) column`,
    !new RegExp(`'${column}'`).test(researchedBlock))
}
check('audit writes only fields drawn from RESEARCHED_FIELDS',
  azure.includes('for (const field of RESEARCHED_FIELDS)'))

const app = read('src/App.tsx')
check('browser writes go through a single patch function', app.includes('const patchPlacement = useCallback'))
check('browser patch type is restricted to user-owned columns',
  read('src/lib/supabase.ts').includes('export type PlacementPatch = Partial<Pick<Placement, UserEditableField>>'))

const detail = read('src/components/PlacementDetail.tsx')
for (const column of ['cv_fit', 'application_status', 'exact_deadline', 'salary', 'why_it_fits']) {
  check(`detail panel does not offer an editor for researched column '${column}'`,
    !new RegExp(`onChange=\\{set\\('${column}'\\)`).test(detail))
}

// --- 4. One card per role ---------------------------------------------------

const filtering = read('src/lib/filtering.ts')
check('sorting does not de-duplicate by company',
  !/companyKey|seen\.has\(key\)/.test(filtering),
  'a previous version showed one card per company, hiding 270 of 378 roles')

// --- 5. Role-quality gate ---------------------------------------------------

const SHOULD_REJECT = [
  'Propulsion systems', 'Space ground systems', 'Uncrewed Aerial Systems', 'Amazon Design',
  'Find available internships', 'View all placements', 'See Internships',
  'Why be an engineer at Babcock?', 'Explore all internships Explore all internships',
  'Meet Thomas - Bringing engineering ideas to life every day', 'Graduate Scheme - Engineering',
  'Senior Aerodynamics Engineer', 'Sustainability standards and performance',
  'International opportunities Outside of the UK? Find out about roles in Canada',
]
const SHOULD_ACCEPT = [
  'Aerodynamic Design Industrial Placement', 'Mechanical Engineering Placement 2027',
  'Software Development Engineer Student Internship', 'Engineering Intern',
  'Industrial Placement - Aerodynamics/CFD/Performance', 'Thermofluids Engineering Placement 2027',
]
check('role gate rejects every known scrape artefact',
  SHOULD_REJECT.every(title => !looksLikeStudentRole(title)),
  SHOULD_REJECT.filter(title => looksLikeStudentRole(title)).join(', '))
check('role gate accepts every known real vacancy',
  SHOULD_ACCEPT.every(title => looksLikeStudentRole(title)),
  SHOULD_ACCEPT.filter(title => !looksLikeStudentRole(title)).join(', '))
check('opportunity classification is stable',
  classifyOpportunity('Aerodynamic Design Industrial Placement') === 'Industrial Placement'
  && classifyOpportunity('Engineering Intern') === 'Internship / Co-op'
  && classifyOpportunity('Spring Week Insight Programme') === 'Spring Week / Insight')

// --- 6. No references to dropped columns ------------------------------------

const DROPPED = ['placement_type', 'salary_period', 'date_info_verified', 'source_type',
  'source_url', 'citizenship_requirement', 'right_to_work_requirement', 'visa_requirement']
const SOURCES = [
  'src/App.tsx', 'src/lib/supabase.ts', 'src/lib/filtering.ts', 'src/lib/utils.ts',
  'src/lib/excel.ts', 'src/lib/ranking.ts', 'src/components/PlacementCard.tsx',
  'src/components/PlacementDetail.tsx', 'src/components/MobilePlacementCard.tsx',
  'src/components/Filters.tsx', 'scripts/azure-placement-audit.mjs',
  'scripts/placement-discovery.mjs', 'scripts/placement-audit.mjs',
  'scripts/placement-verifier.mjs', 'scripts/role-monitor.mjs',
]
// `department` survives only inside the migration that removes it.
for (const column of [...DROPPED, 'department']) {
  const offenders = SOURCES.filter(file => new RegExp(`\\b${column}\\b`).test(read(file)))
  check(`no source file references the dropped column '${column}'`, offenders.length === 0, offenders.join(', '))
}

// --- Result -----------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} invariant(s) broken.`)
  process.exit(1)
}
console.log('\nAll invariants hold.')
