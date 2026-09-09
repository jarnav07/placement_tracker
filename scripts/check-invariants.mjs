// Guards the rules this project keeps breaking. Runs offline, in CI and locally:
//
//   npm run check
//
//  1. The TypeScript ranking mirrors the Postgres ranking exactly.
//  2. Automation never writes IDENTITY, DERIVED or USER-OWNED columns.
//  3. The browser never writes a researched column.
//  4. The board never collapses several roles at one company into one card.
//  5. The role-quality gate still rejects the scrape artefacts that polluted
//     the tracker, and still accepts real vacancies.
//  6. Every source file references only columns that still exist.
//  7. Free-text dates parse the way both implementations expect.
//  8. A placement opens automatically only on a date the employer actually
//     published, at day precision.
//  9. The availability gate does not go back to demanding a printed intake year.

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { looksLikeStudentRole, classifyOpportunity } from './role-quality.mjs'
import { parseDateText, toIsoDate, openingHasArrived, openingIsDue, daysUntil } from './verify/dates.mjs'
import { openingDecision } from './apply-scheduled-openings.mjs'
import {
  detectBoard, queryBoardJobs, findRoleOnBoard, roleTitleWords, norm, deterministicVerdict,
} from './verify/evidence.mjs'
import { decideStatus } from './verify/record.mjs'

/** Real tracked links, plus two that are careers pages rather than a board. */
const BOARD_URLS = [
  ['https://jobs.smartrecruiters.com/McLarenRacingLtd1/744000145935629-engineering-intern', 'smartrecruiters', 'McLarenRacingLtd1'],
  ['https://jobs.lever.co/palantir', 'lever', 'palantir'],
  ['https://jobs.lever.co/palantir/1b6f1d82', 'lever', 'palantir'],
  ['https://boards.greenhouse.io/anduril', 'greenhouse', 'anduril'],
  ['https://job-boards.greenhouse.io/anduril/jobs/123', 'greenhouse', 'anduril'],
  ['https://boards.greenhouse.io/embed/job_board?for=reactionengines', 'greenhouse', 'reactionengines'],
  ['https://jobs.ashbyhq.com/isomorphiclabs', 'ashby', 'isomorphiclabs'],
  ['https://rolls-royce.wd3.myworkdayjobs.com/en-US/RRCareers', 'workday', 'rolls-royce'],
  ['https://apply.workable.com/oxa/', 'workable', 'oxa'],
  ['https://example.recruitee.com/o/intern', 'recruitee', 'example'],
  ['https://example.teamtailor.com/jobs/123', 'teamtailor', 'example'],
  ['https://www.palantir.com/careers/jobs/', null, null],
  ['https://racingcareers.mclaren.com/early-careers', null, null],
]

/** Stubbed board payloads, shaped like each provider's real public API. */
const BOARD_RESPONSES = new Map([
  ['boards-api.greenhouse.io', {
    jobs: [
      { title: 'Aerodynamics Industrial Placement 2027', absolute_url: 'https://x/1', location: { name: 'Bristol' } },
      { title: 'Senior Propulsion Engineer', absolute_url: 'https://x/2', location: { name: 'Bristol' } },
    ],
  }],
  ['api.lever.co', [{ text: 'Software Engineering Internship', hostedUrl: 'https://l/1', categories: { location: 'London' } }]],
  ['api.ashbyhq.com', {
    jobs: [
      { title: 'Research Intern', jobUrl: 'https://a/1', location: 'London', isListed: true },
      { title: 'Hidden Intern', jobUrl: 'https://a/2', location: 'London', isListed: false },
    ],
  }],
  ['api.smartrecruiters.com', {
    content: [{ name: 'Engineering Intern', applyUrl: 'https://s/1', id: 'i1', location: { city: 'Woking', country: 'uk' } }],
  }],
  ['apply.workable.com/api', { jobs: [{ title: 'Autonomy Intern', url: 'https://w/1', city: 'Oxford', country: 'UK' }] }],
  ['recruitee.com/api/offers', { offers: [{ title: 'Placement Student', careers_url: 'https://r/1', city: 'Leeds' }] }],
  ['teamtailor.com/jobs.json', { jobs: [{ title: 'Year in Industry Engineer', careersite_job_url: 'https://t/1', location: 'Derby' }] }],
])

const BOARD_LISTINGS = [
  ['https://boards.greenhouse.io/anduril', 'Aerodynamics Industrial Placement 2027', 2],
  ['https://jobs.lever.co/palantir', 'Software Engineering Internship', 1],
  ['https://jobs.ashbyhq.com/isomorphiclabs', 'Research Intern', 1],
  ['https://jobs.smartrecruiters.com/McLarenRacingLtd1/x', 'Engineering Intern', 1],
  ['https://apply.workable.com/oxa/', 'Autonomy Intern', 1],
  ['https://example.recruitee.com/o/x', 'Placement Student', 1],
  ['https://example.teamtailor.com/jobs/1', 'Year in Industry Engineer', 1],
]

const read = path => fs.readFileSync(path, 'utf8')
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`PASS  ${label}`)
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

// --- 1. Ranking parity ------------------------------------------------------

const squash = text => text.replace(/\s+/g, ' ')
const rankingMigration = squash(read('supabase/migrations/20260907120000_opening_automation_and_deadline_priority.sql'))
const ranking = squash(read('src/lib/ranking.ts'))

for (const [label, weight] of [['cv_fit', '0.45'], ['domain', '0.30'], ['career_value', '0.15'], ['prestige', '0.10']]) {
  check(`ranking weight for ${label} (${weight}) matches SQL and TypeScript`,
    rankingMigration.includes(`${weight} * `) && ranking.includes(`${weight} * `))
}
for (const [status, bonus] of [['Open Now', '18'], ['Opening Soon', '10'], ['Expected', '4'], ['Closed', '-40']]) {
  check(`status bonus ${status} = ${bonus} in both implementations`,
    rankingMigration.includes(`WHEN '${status}' THEN ${bonus}`) && ranking.includes(`'${status}': ${bonus},`))
}
for (const threshold of ['75', '58', '42', '55']) {
  check(`priority band threshold ${threshold} present in both implementations`,
    rankingMigration.includes(`p_score >= ${threshold}`) && ranking.includes(`>= ${threshold}`))
}

// The deadline term is the newest half of the ranking and the easiest to let drift.
for (const [days, bonus] of [['7', '14'], ['14', '11'], ['30', '8'], ['60', '5'], ['120', '2']]) {
  check(`deadline bonus (<= ${days} days => +${bonus}) matches SQL and TypeScript`,
    rankingMigration.includes(`p_deadline_days <= ${days} THEN ${bonus}`)
    && ranking.includes(`{ withinDays: ${days}, bonus: ${bonus} }`))
}
check('passed-deadline penalty (-25) matches SQL and TypeScript',
  rankingMigration.includes('p_deadline_days < 0 THEN -25')
  && ranking.includes('PASSED_DEADLINE_PENALTY = -25'))
check('the deadline bonus applies only to Open Now in both implementations',
  rankingMigration.includes("p_application_status <> 'Open Now' THEN 0")
  && ranking.includes("if (status !== 'Open Now') return 0"))

// --- 2/3. Column ownership --------------------------------------------------

const USER_OWNED = ['app_status', 'date_applied', 'cv_version', 'cover_letter_required',
  'referral_contact', 'interview_date', 'notes', 'not_interested', 'archived']
// `opened_at` joins the derived class: the placements_opening trigger owns it, and
// an audit that wrote it could fake a role being new.
const DERIVED = ['priority_score', 'overall_priority', 'opened_at']
const IDENTITY = ['company', 'specific_role']

const record = read('scripts/verify/record.mjs')
const researchedBlock = record.slice(record.indexOf('export const RESEARCHED_FIELDS'), record.indexOf('export const SCORE_FIELDS'))

for (const column of [...USER_OWNED, ...DERIVED, ...IDENTITY]) {
  check(`the verification record never lists '${column}' as a researched (writable) column`,
    !new RegExp(`'${column}'`).test(researchedBlock))
}

const verification = read('scripts/placement-verification.mjs')
check('the scheduled pass writes only fields drawn from RESEARCHED_FIELDS',
  verification.includes('for (const field of RESEARCHED_FIELDS)'))
check('the scheduled pass decides the status itself rather than storing a raw provider answer',
  verification.includes("if (field === 'application_status') continue")
  && verification.includes('if (decision.status) {'))

const openings = read('scripts/apply-scheduled-openings.mjs')
for (const column of [...USER_OWNED, ...DERIVED]) {
  check(`the scheduled-openings pass never writes '${column}'`,
    !new RegExp(`${column}:`).test(openings.slice(openings.indexOf('const update = {'), openings.indexOf('if (DRY_RUN)'))))
}

const app = read('src/App.tsx')
check('browser writes go through a single patch function', app.includes('const patchPlacement = useCallback'))
check('browser patch type is restricted to user-owned columns',
  read('src/lib/supabase.ts').includes('export type PlacementPatch = Partial<Pick<Placement, UserEditableField>>'))
check('opened_at is not user-editable',
  !read('src/lib/supabase.ts').slice(
    read('src/lib/supabase.ts').indexOf('export const USER_EDITABLE_FIELDS'),
    read('src/lib/supabase.ts').indexOf('export type UserEditableField'),
  ).includes('opened_at'))

const detail = read('src/components/PlacementDetail.tsx')
for (const column of ['cv_fit', 'application_status', 'exact_deadline', 'salary', 'why_it_fits', 'opened_at']) {
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
  'src/components/Filters.tsx',
  'scripts/placement-verification.mjs', 'scripts/apply-scheduled-openings.mjs',
  'scripts/placement-discovery.mjs', 'scripts/placement-audit.mjs',
  'scripts/placement-verifier.mjs', 'scripts/role-monitor.mjs',
  'scripts/verify/dates.mjs', 'scripts/verify/evidence.mjs',
  'scripts/verify/record.mjs', 'scripts/verify/gemini.mjs', 'scripts/verify/azure.mjs',
]
// `department` survives only inside the migration that removes it.
for (const column of [...DROPPED, 'department']) {
  const offenders = SOURCES.filter(file => new RegExp(`\\b${column}\\b`).test(read(file)))
  check(`no source file references the dropped column '${column}'`, offenders.length === 0, offenders.join(', '))
}

// --- 7. Date parsing --------------------------------------------------------
//
// Both the automatic opening rule and the deadline weighting read these columns,
// and years of model output filled them with prose. Every case below is a real
// value taken from the live table.

const DATE_CASES = [
  ['2026-09-14', '2026-09-14', 'day'],
  ['4 September 2026', '2026-09-04', 'day'],
  ['September 4, 2026', '2026-09-04', 'day'],
  ['25 August 2026', '2026-08-25', 'day'],
  ['04/09/2026', '2026-09-04', 'day'],
  ['November 2026', '2026-11-01', 'month'],
  ['Autumn 2026', '2026-09-01', 'season'],
  // Day-shaped but not a real day: it must not claim day precision, because a
  // day-precision date is what opens a placement automatically.
  ['31 February 2027', '2027-02-01', 'month'],
  // Prose that asserts there is no date, even with a year sitting next to it.
  ['Not published for 2027', '', 'none'],
  ['Not yet published for 2027; placements start each September', '', 'none'],
  ['Vacancy dependent', '', 'none'],
  ['Year-round / vacancy dependent', '', 'none'],
  ['TBC', '', 'none'],
  ['', '', 'none'],
]
for (const [input, expectedIso, expectedPrecision] of DATE_CASES) {
  const parsed = parseDateText(input)
  check(`date "${input || '(empty)'}" parses as ${expectedPrecision}${expectedIso ? ` ${expectedIso}` : ''}`,
    parsed.iso === expectedIso && parsed.precision === expectedPrecision,
    `got ${parsed.precision} ${parsed.iso || '(none)'}`)
}

check('prose is never stored in a date column',
  toIsoDate('Not published for 2027') === '' && toIsoDate('Vacancy dependent') === '' && toIsoDate('TBC') === '')
check('a real date survives normalisation to ISO',
  toIsoDate('4 September 2026') === '2026-09-04' && toIsoDate('2026-12-31') === '2026-12-31')
check('daysUntil counts whole days from today, in both directions',
  daysUntil('2026-09-10', '2026-09-07') === 3 && daysUntil('2026-09-01', '2026-09-07') === -6
  && daysUntil('2026-09-07', '2026-09-07') === 0 && daysUntil('Vacancy dependent', '2026-09-07') === null)

// --- 8. Automatic opening ---------------------------------------------------

check('a day-precision opening date opens the role on the day it arrives',
  openingHasArrived('2026-09-07', '2026-09-07') === true
  && openingHasArrived('2026-09-06', '2026-09-07') === true)
check('a future opening date does not open the role early',
  openingHasArrived('2026-09-08', '2026-09-07') === false)
check('a month-precision opening date never opens a role automatically',
  openingHasArrived('November 2026', '2026-12-01') === false
  && openingHasArrived('Autumn 2026', '2026-12-01') === false,
  '"November 2026" is not a promise that applications open on 1 November')
check('a vague opening date still marks the role due for re-verification',
  openingIsDue('November 2026', '2026-11-15') === true && openingIsDue('November 2026', '2026-10-15') === false)
check('a stale opening date cannot resurrect a role from an earlier cycle',
  openingHasArrived('2026-01-01', '2026-09-07') === false)

const OPENING_CASES = [
  [{ application_status: 'Opening Soon', exact_opening_date: '2026-09-05', exact_deadline: '2026-10-30' }, true,
    'an announced day that has arrived, with the deadline still ahead'],
  [{ application_status: 'Not Yet Published', exact_opening_date: '2026-09-07', exact_deadline: null }, true,
    'an announced day that is today'],
  [{ application_status: 'Opening Soon', exact_opening_date: '2026-09-20', exact_deadline: null }, false,
    'the announced day has not arrived'],
  [{ application_status: 'Opening Soon', exact_opening_date: '2026-09-05', exact_deadline: '2026-09-01' }, false,
    'the deadline has already passed'],
  [{ application_status: 'Closed', exact_opening_date: '2026-09-05', exact_deadline: null }, false,
    'a closed role is never re-opened by a date'],
  [{ application_status: 'Open Now', exact_opening_date: '2026-09-05', exact_deadline: null }, false,
    'already open'],
  [{ application_status: 'Opening Soon', exact_opening_date: 'November 2026', exact_deadline: null }, false,
    'a month is not a day'],
  [{ application_status: 'Opening Soon', exact_opening_date: 'Not published for 2027', exact_deadline: null }, false,
    'prose is not a date'],
]
for (const [role, expected, why] of OPENING_CASES) {
  const decision = openingDecision(role, '2026-09-07')
  check(`scheduled opening: ${why}`, decision.open === expected, `got open=${decision.open} (${decision.reason})`)
}

// --- 9. The availability gate -----------------------------------------------
//
// The tracker's worst failure mode was silence: a placement opened, the gate
// demanded a printed intake year that most postings never carry, the answer was
// discarded and the row sat unchanged. These guard the fix.

check('a missing intake year is not treated as a contradiction',
  record.includes('if (!judgement.intakeYear && judgement.intakeConsistent) return true'),
  'requiring a printed "2027" is what made the tracker miss openings')
check('a live listing on the employer job board can open a role on its own',
  record.includes('if (boardLive) {') && record.includes("status: 'Open Now'"))
check('an inconclusive run leaves the stored status alone rather than stamping Unknown',
  record.includes('status: null') && record.includes('// --- 6. No assertion'))
check('closing a role needs the board\'s silence or agreement between providers',
  record.includes('const unanimous = closedBacked.length === providers.length'))
check('Azure is still consulted as the secondary provider',
  verification.includes('verifyWithAzure') && read('scripts/verify/azure.mjs').includes('SECONDARY verification provider'))
check('Gemini is the primary provider',
  verification.includes('verifyWithGemini') && read('scripts/verify/gemini.mjs').includes('PRIMARY verification provider'))
// --- 9b. Gemini backends ----------------------------------------------------
//
// Vertex AI and AI Studio reach the same models through different endpoints and
// key types, and the failure mode when they are mixed up is a nightly run that
// verifies nothing. These pin the parts that are easy to get subtly wrong.

const gemini = read('scripts/verify/gemini.mjs')

check('Vertex uses the global express-mode endpoint at the version Google\'s own SDK uses',
  gemini.includes("const VERTEX_ROOT = 'https://aiplatform.googleapis.com/v1beta1'")
  && gemini.includes('publishers/google/models/${encodeURIComponent(model)}:generateContent'),
  'express mode is global: it takes no project id and no location')
check('AI Studio keeps its own endpoint',
  gemini.includes("const AISTUDIO_ROOT = 'https://generativelanguage.googleapis.com/v1beta'"))
check('both backends send the key as a header, never in the URL',
  !/generateUrl:[^\n]*\bkey=/.test(gemini) && (gemini.match(/'x-goog-api-key'/g) ?? []).length >= 2,
  'a key in a query string can reach a log')
check('a Vertex key rejection explains that express mode is the requirement',
  gemini.includes('API keys are not supported by this API') && gemini.includes('express mode'),
  'that error means the wrong KIND of key, not a malformed one')
check('the provider self-test exercises auth, grounding and structured output',
  read('scripts/check-providers.mjs').includes('pingGemini')
  && gemini.includes('export async function pingGemini'))

/** Backend selection is env-driven, so it is checked in a real child process. */
function backendFor(env) {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e', "const m = await import('./scripts/verify/gemini.mjs'); process.stdout.write(m.geminiBackend)",
  ], { env: { ...process.env, VERTEX_API_KEY: '', GEMINI_API_KEY: '', GEMINI_BACKEND: '', GOOGLE_GENAI_USE_VERTEXAI: '', GOOGLE_API_KEY: '', GOOGLE_VERTEX_API_KEY: '', GOOGLE_CLOUD_API_KEY: '', ...env }, encoding: 'utf8' })
  return result.stdout?.trim()
}

const BACKEND_CASES = [
  [{ VERTEX_API_KEY: 'k' }, 'vertex', 'a Vertex key selects Vertex'],
  [{ GEMINI_API_KEY: 'k' }, 'aistudio', 'an AI Studio key selects AI Studio'],
  [{ VERTEX_API_KEY: 'k', GEMINI_API_KEY: 'k' }, 'vertex', 'Vertex wins when both keys are set'],
  [{ VERTEX_API_KEY: 'k', GEMINI_API_KEY: 'k', GEMINI_BACKEND: 'aistudio' }, 'aistudio', 'GEMINI_BACKEND overrides'],
  [{ GEMINI_API_KEY: 'k', GOOGLE_GENAI_USE_VERTEXAI: 'true' }, 'vertex', "Google's own SDK variable is honoured"],
  [{}, 'none', 'no key selects no backend'],
]
for (const [env, expected, why] of BACKEND_CASES) {
  check(`backend selection: ${why}`, backendFor(env) === expected, `got ${backendFor(env)}`)
}

check('the deterministic evidence stage has exactly one implementation',
  read('scripts/placement-verifier.mjs').includes("from './verify/evidence.mjs'")
  && verification.includes("from './verify/evidence.mjs'"),
  'discovery and the scheduled pass must not drift apart again')

// --- 10. Applicant tracking systems -----------------------------------------
//
// The deterministic stage is the only part of the pipeline that cannot
// hallucinate, so it is the part most worth testing. `fetch` is stubbed, so this
// runs offline and in CI.

check('every applicant tracking system the tracker claims to read is detected',
  BOARD_URLS.every(([url, type, key]) => {
    const board = detectBoard(url)
    return type === null ? board === null : (board?.type === type && board?.key === key)
  }),
  BOARD_URLS.filter(([url, type, key]) => {
    const board = detectBoard(url)
    return type === null ? board !== null : (board?.type !== type || board?.key !== key)
  }).map(([url]) => url).join(', '))

const realFetch = globalThis.fetch
globalThis.fetch = async url => {
  const key = String(url)
  for (const [pattern, body] of BOARD_RESPONSES) {
    if (key.includes(pattern)) {
      return { ok: true, status: 200, url: key, json: async () => body, text: async () => JSON.stringify(body) }
    }
  }
  return { ok: false, status: 404, url: key, json: async () => ({}), text: async () => '' }
}

try {
  for (const [url, roleTitle, expectedCount] of BOARD_LISTINGS) {
    const board = detectBoard(url)
    const words = roleTitleWords(roleTitle)
    const listing = await queryBoardJobs(board, '', url, words)
    const found = listing ? findRoleOnBoard(listing.jobs, words, norm(roleTitle)) : null
    check(`${board.type}: the listing parses and the exact role is matched`,
      listing?.jobs.length === expectedCount && Boolean(found?.match),
      JSON.stringify({ jobs: listing?.jobs?.length, match: found?.match?.title }))
  }

  const ashby = detectBoard('https://jobs.ashbyhq.com/isomorphiclabs')
  const hiddenWords = roleTitleWords('Hidden Intern')
  const hiddenListing = await queryBoardJobs(ashby, '', 'https://jobs.ashbyhq.com/isomorphiclabs', hiddenWords)
  check('an unlisted job-board posting is never treated as live',
    !findRoleOnBoard(hiddenListing.jobs, hiddenWords, norm('Hidden Intern')).match)
} finally {
  globalThis.fetch = realFetch
}

// --- 11. The deterministic verdict ------------------------------------------

const NO_SIGNALS = {
  has2027: false, hasCycle2027: false, student: false, openSignal: false,
  closedSignal: false, titleMatched: false, titleContiguous: false,
}
const evidenceFor = board => ({
  roleWords: [], roleNorm: '', pages: [], deadLinks: [], posting: null, postingSignals: null, signals: NO_SIGNALS, board,
})
const trackedRole = { specific_role: 'Aerodynamics Industrial Placement', application_status: 'Not Yet Published' }
const verdictOf = board => deterministicVerdict(trackedRole, evidenceFor(board)).status

check('a live student posting on the employer ATS opens the role even with no printed intake year',
  verdictOf({ ok: true, found: true, job: { title: 'Aerodynamics Industrial Placement', url: 'https://x/1' }, boardType: 'greenhouse', boardUrl: 'https://b', liveCount: 12, complete: true }) === 'OPEN_NOW',
  'this is the single biggest false-negative fix; do not re-add an intake-year requirement here')
check('a graduate-scheme posting does not open a student role',
  verdictOf({ ok: true, found: true, job: { title: 'Graduate Programme - Aerodynamics', url: 'https://x/1' }, boardType: 'greenhouse', boardUrl: 'https://b', liveCount: 12, complete: true }) === null)
check('a fully enumerated board without the role closes it',
  verdictOf({ ok: true, found: false, loose: null, boardType: 'greenhouse', boardUrl: 'https://b', liveCount: 40, complete: true }) === 'CLOSED')
check('an INCOMPLETE board without the role asserts nothing',
  verdictOf({ ok: true, found: false, loose: null, boardType: 'workday', boardUrl: 'https://b', liveCount: 20, complete: false }) === null,
  'Workday paginates; absence on page one is not closure')
check('a loosely similar posting prevents a false Closed',
  verdictOf({ ok: true, found: false, loose: { title: 'Aerodynamics Placement (12 months)' }, boardType: 'greenhouse', boardUrl: 'https://b', liveCount: 40, complete: true }) === null,
  'a renamed but live posting must never close a role')
check('an unreachable board asserts nothing',
  verdictOf({ ok: false, reason: 'no queryable board found' }) === null)

// --- 12. The status decision ------------------------------------------------

const judgement = (overrides = {}) => ({
  provider: 'Test', proposedStatus: 'Unknown', confidence: 0.9, intakeYear: 0, intakeConsistent: true,
  exactRoleFound: true, directApplication: true, officialSource: true, openingAnnounced: false,
  evidenceSummary: 'test', sources: [], ...overrides,
})
const noVerdict = { status: null, confidence: 0, intakeConfirmed: false, applicationUrl: '', reason: 'none' }
const liveVerdict = { status: 'OPEN_NOW', confidence: 0.95, intakeConfirmed: true, applicationUrl: 'https://x/1', reason: 'live' }
const absentVerdict = { status: 'CLOSED', confidence: 0.8, intakeConfirmed: false, applicationUrl: '', reason: 'absent' }
const decide = args => decideStatus({
  role: { application_status: 'Not Yet Published', exact_opening_date: null },
  record: {}, verdict: noVerdict, primary: null, secondary: null, today: '2026-09-07', ...args,
}).status

check('a live board listing opens the role even when the model is unsure',
  decide({ verdict: liveVerdict, primary: judgement({ proposedStatus: 'Unknown', confidence: 0.3 }) }) === 'Open Now')
check('a confident, contradicting model stops a board listing from opening the role',
  decide({ verdict: liveVerdict, primary: judgement({ proposedStatus: 'Closed', confidence: 0.9 }) }) === null)
check('an unstated intake year no longer blocks Open Now',
  decide({ primary: judgement({ proposedStatus: 'Open Now', confidence: 0.8, intakeYear: 0, intakeConsistent: true }) }) === 'Open Now',
  'the previous gate demanded intake_year === 2027, which most postings never print')
check('a positively stated wrong intake year still blocks Open Now',
  decide({ primary: judgement({ proposedStatus: 'Open Now', confidence: 0.95, intakeYear: 2026, intakeConsistent: false }) }) === null)
check('Open Now still needs a direct application route',
  decide({ primary: judgement({ proposedStatus: 'Open Now', confidence: 0.95, directApplication: false }) }) === null)
check('one provider alone cannot close a role when a second disagrees',
  decide({
    primary: judgement({ proposedStatus: 'Closed', confidence: 0.95 }),
    secondary: judgement({ provider: 'Second', proposedStatus: 'Expected', confidence: 0.8 }),
  }) === null,
  'a wrong Closed costs the user the placement entirely')
check('both providers agreeing does close a role',
  decide({
    primary: judgement({ proposedStatus: 'Closed', confidence: 0.9 }),
    secondary: judgement({ provider: 'Second', proposedStatus: 'Closed', confidence: 0.85 }),
  }) === 'Closed')
check('an enumerated board without the role closes it when no provider says otherwise',
  decide({ verdict: absentVerdict, primary: judgement({ proposedStatus: 'Unknown', confidence: 0.2 }) }) === 'Closed')
check('a published opening day that has arrived opens the role',
  decideStatus({
    role: { application_status: 'Opening Soon', exact_opening_date: '2026-09-05' },
    record: { exact_opening_date: '2026-09-05' },
    verdict: noVerdict,
    primary: judgement({ proposedStatus: 'Unknown', confidence: 0.4, openingAnnounced: true }),
    secondary: null,
    today: '2026-09-07',
  }).status === 'Open Now')
check('an inconclusive run asserts nothing at all',
  decide({ primary: judgement({ proposedStatus: 'Unknown', confidence: 0.4 }) }) === null,
  'the row must keep its stored status rather than being stamped Unknown')

// --- 9c. Model JSON parsing -------------------------------------------------
// Vertex express mode treats responseMimeType as a hint and will answer
// "Here is the JSON: {...}". A strict JSON.parse in the provider health check
// therefore failed the whole nightly pass over a response verification would
// have handled, so both paths must use the same tolerant parser.
const { parseJsonLoose } = await import('./verify/gemini.mjs')

for (const [label, payload] of [
  ['a bare object', '{"summary":"ok"}'],
  ['a prose preamble', 'Here is the JSON you requested:\n{"summary":"ok"}'],
  ['a json fence', '```json\n{"summary":"ok"}\n```'],
  ['a bare fence', '```\n{"summary":"ok"}\n```'],
  ['trailing prose', 'Sure! {"summary":"ok"} Hope that helps.'],
]) {
  let parsed = null
  try { parsed = parseJsonLoose(payload) } catch { /* reported below */ }
  check(`model JSON parser handles ${label}`, parsed?.summary === 'ok')
}
for (const [label, payload] of [['empty output', '   '], ['no object at all', 'no json here']]) {
  let threw = false
  try { parseJsonLoose(payload) } catch { threw = true }
  check(`model JSON parser still rejects ${label}`, threw)
}
check('the provider health check uses the tolerant parser, not a bare JSON.parse',
  /parseJsonLoose\(structured\.text/.test(gemini) && !/\n\s*JSON\.parse\(structured\.text\)/.test(gemini),
  'a strict parse here silently disables every nightly verification run')

// Gemini 2.5 models reason before answering. A structured call that leaves
// thinking on can spend its whole budget reasoning and get cut off mid-preamble,
// which is exactly how the nightly pass died: 256 output tokens, and the reply
// never reached the JSON.
for (const marker of ['thinkingConfig: { thinkingBudget: 0 }', 'maxOutputTokens: 8192', 'maxOutputTokens: 2048']) {
  check(`structured Gemini calls set ${marker}`, gemini.includes(marker))
}
check('no structured Gemini call is left on a starvation budget',
  !/maxOutputTokens: (?:256|512)\b/.test(gemini),
  'a thinking model needs room for the object after its reasoning')
check('a truncated response is reported as truncation',
  gemini.includes("finishReason === 'MAX_TOKENS'"),
  'MAX_TOKENS read as malformed JSON is what made this look like a bad API key')

// --- Result -----------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} invariant(s) broken.`)
  process.exit(1)
}
console.log('\nAll invariants hold.')
