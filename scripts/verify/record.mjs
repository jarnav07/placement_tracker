// The shared verification record: what every provider must return, how it is
// cleaned, and how a status is decided from it.
//
// WHY THIS FILE EXISTS
//
// The previous audit asked one model for a status and then applied a gate that
// demanded, simultaneously: >= 80 % confidence, an integer intake year exactly
// equal to 2027, exact_role_found, direct_application_for_exact_role_found,
// official_source_found and a non-empty application link. Anything short of all
// six became "Unknown", and "Unknown" was then dropped by the write-back.
//
// The practical effect on a live board of 263 roles was that a placement could
// open and the tracker would never notice: most postings simply do not print the
// intake year ("Industrial Placement — Aerodynamics" says nothing about 2027),
// so `intake_year` came back as 0, the gate failed, the result was discarded and
// the row sat at "Not Yet Published" indefinitely. That is the false-negative
// machine this module replaces.
//
// The new gate keeps every claim evidence-backed but stops treating a missing
// intake year as a contradiction, and lets the deterministic applicant-tracking
// check — which cannot hallucinate — carry a decision on its own.

import { toIsoDate, toDatedValue, openingHasArrived, daysUntil } from './dates.mjs'
import { isSpecificPosting } from './evidence.mjs'

export const TARGET_YEAR = 2027

/**
 * How long a published opening date may keep asserting "Open Now" on its own.
 * The scheduled-openings job uses a longer grace to flip a card on the day; this
 * is the window in which a verification pass will re-assert from the date alone.
 */
export const SCHEDULED_OPENING_GRACE_DAYS = 7

export const STATES = ['Open Now', 'Opening Soon', 'Expected', 'Not Yet Published', 'Closed', 'Unknown']
export const OPPORTUNITY_TYPES = ['Industrial Placement', 'Spring Week / Insight', 'Internship / Co-op', 'Other Student Programme']
export const DEADLINE_TYPES = ['Rolling', 'Fixed', 'Vacancy dependent', 'TBC']

/**
 * Columns a provider may fill. Identity (`company`, `specific_role`), derived
 * ranking (`priority_score`, `overall_priority`, `opened_at`) and the user's own
 * tracking columns are deliberately absent — see AGENTS.md section 3.
 */
export const RESEARCHED_FIELDS = [
  'sector', 'country', 'city', 'engineering_area', 'opportunity_type',
  'placement_duration', 'placement_start_date', 'placement_end_date',
  'application_status', 'exact_opening_date', 'exact_deadline', 'deadline_type',
  'website', 'careers_page', 'application_link',
  'degree_requirements', 'min_grade_requirement', 'year_of_study_requirement',
  'required_technical_skills', 'work_eligibility', 'security_clearance_requirement',
  'salary', 'other_benefits',
  'cv_fit', 'aerospace_relevance', 'rocket_space_relevance', 'f1_motorsport_relevance',
  'aero_cfd_relevance', 'propulsion_relevance', 'controls_avionics_relevance',
  'prestige', 'career_value', 'why_it_fits', 'potential_weaknesses',
]

export const SCORE_FIELDS = [
  'cv_fit', 'aerospace_relevance', 'rocket_space_relevance', 'f1_motorsport_relevance',
  'aero_cfd_relevance', 'propulsion_relevance', 'controls_avionics_relevance',
  'prestige', 'career_value',
]

export const URL_FIELDS = ['website', 'careers_page', 'application_link']
export const DATE_FIELDS = ['exact_opening_date', 'exact_deadline']

/** Judgement fields: never stored, but they decide what the status may become. */
export const JUDGEMENT_FIELDS = [
  'intake_year', 'intake_2027_consistent', 'exact_role_found',
  'direct_application_for_exact_role_found', 'official_source_found',
  'opening_date_is_announced', 'confidence', 'evidence_summary',
]

// ---------------------------------------------------------------------------
// JSON schema, shared by both providers
// ---------------------------------------------------------------------------

const text = { type: 'string' }
const score = { type: 'integer', minimum: 0, maximum: 10 }

/**
 * `dialect` matters: Azure's Responses API runs strict JSON-schema validation and
 * rejects unknown keywords, while Gemini's `responseSchema` accepts the same core
 * subset. The one real difference is that Azure needs every property listed in
 * `required`, so both are built from the same field list.
 */
export function buildSchema() {
  const properties = {
    sector: text, country: text, city: text, engineering_area: text,
    opportunity_type: { type: 'string', enum: OPPORTUNITY_TYPES },
    placement_duration: text, placement_start_date: text, placement_end_date: text,
    application_status: { type: 'string', enum: STATES },
    exact_opening_date: text, exact_deadline: text,
    // No empty member: Vertex rejects the whole request with
    // "response_schema.properties[deadline_type].enum[4]: cannot be empty".
    // "TBC" already carries "not established", and normalisation below coerces
    // anything unrecognised, so nothing is lost by removing the empty option.
    deadline_type: { type: 'string', enum: DEADLINE_TYPES },
    website: text, careers_page: text, application_link: text,
    degree_requirements: text, min_grade_requirement: text, year_of_study_requirement: text,
    required_technical_skills: text, work_eligibility: text, security_clearance_requirement: text,
    salary: text, other_benefits: text,
    cv_fit: score, aerospace_relevance: score, rocket_space_relevance: score,
    f1_motorsport_relevance: score, aero_cfd_relevance: score, propulsion_relevance: score,
    controls_avionics_relevance: score, prestige: score, career_value: score,
    why_it_fits: text, potential_weaknesses: text,
    intake_year: { type: 'integer' },
    intake_2027_consistent: { type: 'boolean' },
    exact_role_found: { type: 'boolean' },
    direct_application_for_exact_role_found: { type: 'boolean' },
    official_source_found: { type: 'boolean' },
    opening_date_is_announced: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence_summary: text,
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { url: text, type: text, evidence: text },
        required: ['url', 'type', 'evidence'],
      },
    },
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: [...RESEARCHED_FIELDS, ...JUDGEMENT_FIELDS, 'sources'],
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const asString = value => (typeof value === 'string' ? value.trim() : '')
const asBool = value => value === true || value === 'true' || value === 1 || value === '1'

function asUrl(value) {
  const raw = asString(value)
  if (!raw) return ''
  try { return new URL(raw).toString() } catch { return '' }
}

function asScore(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(10, Math.round(number))) : null
}

/** Turns one provider's raw JSON into the values we are willing to store. */
export function normaliseRecord(raw, provider) {
  const record = {}
  for (const field of RESEARCHED_FIELDS) {
    if (SCORE_FIELDS.includes(field)) record[field] = asScore(raw?.[field])
    else if (URL_FIELDS.includes(field)) record[field] = asUrl(raw?.[field])
    // Date columns only ever receive ISO dates. Prose such as "Not published for
    // 2027" is discarded here rather than written into a date column, where it
    // breaks sorting, the deadline weighting and the automatic opening rule.
    else if (DATE_FIELDS.includes(field)) record[field] = toIsoDate(raw?.[field])
    else record[field] = asString(raw?.[field])
  }

  record.application_status = STATES.includes(record.application_status) ? record.application_status : 'Unknown'
  record.opportunity_type = OPPORTUNITY_TYPES.includes(record.opportunity_type) ? record.opportunity_type : ''
  record.deadline_type = DEADLINE_TYPES.includes(record.deadline_type) ? record.deadline_type : ''

  const judgement = {
    provider,
    proposedStatus: record.application_status,
    confidence: Math.max(0, Math.min(1, Number(raw?.confidence) || 0)),
    intakeYear: Number.isFinite(Number(raw?.intake_year)) ? Number(raw.intake_year) : 0,
    intakeConsistent: asBool(raw?.intake_2027_consistent),
    exactRoleFound: asBool(raw?.exact_role_found),
    directApplication: asBool(raw?.direct_application_for_exact_role_found),
    officialSource: asBool(raw?.official_source_found),
    openingAnnounced: asBool(raw?.opening_date_is_announced),
    evidenceSummary: asString(raw?.evidence_summary),
    sources: Array.isArray(raw?.sources)
      ? raw.sources
          .map(source => ({ url: asUrl(source?.url), type: asString(source?.type), evidence: asString(source?.evidence) }))
          .filter(source => source.url)
          .slice(0, 8)
      : [],
  }

  return { record, judgement }
}

// ---------------------------------------------------------------------------
// Status decision
// ---------------------------------------------------------------------------

/** The intake is acceptable when it is 2027, or unstated but not contradicted. */
function intakeAcceptable(judgement) {
  if (judgement.intakeYear === TARGET_YEAR) return true
  // 0 / missing means "the posting does not print a year". Employers take
  // listings down once a cycle closes, so a live posting with no year is far more
  // likely to be the current cycle than a stale one — but only when the model
  // explicitly confirms nothing contradicts a 2027 start.
  if (!judgement.intakeYear && judgement.intakeConsistent) return true
  return false
}

/** The intake is refuted when the provider positively names a different year. */
function intakeRefuted(judgement) {
  return judgement.intakeYear > 0 && judgement.intakeYear !== TARGET_YEAR
}

/**
 * Decides the status to store from the deterministic verdict plus one or two
 * provider judgements.
 *
 * Returns `{ status, confidence, reason }`, where `status: null` means NO
 * ASSERTION — the row keeps whatever it had. That distinction is the point:
 * "we could not establish anything today" is not the same as "Unknown", and the
 * old pipeline conflated the two.
 */
export function decideStatus({ role, record, verdict, primary, secondary, today }) {
  const reasons = []
  const boardLive = verdict.status === 'OPEN_NOW'
  const boardAbsent = verdict.status === 'CLOSED'
  const providers = [primary, secondary].filter(Boolean)

  const saysOpen = providers.filter(p => p.proposedStatus === 'Open Now')
  const saysClosed = providers.filter(p => p.proposedStatus === 'Closed')

  // --- 1. The applicant tracking system is decisive when it lists the role ---
  if (boardLive) {
    const contradicted = saysClosed.some(p => p.confidence >= 0.85 && intakeAcceptable(p))
    if (!contradicted) {
      reasons.push(verdict.reason)
      if (saysOpen.length) reasons.push(`${saysOpen.map(p => p.provider).join(' and ')} agree${saysOpen.length === 1 ? 's' : ''}.`)
      return {
        status: 'Open Now',
        confidence: Math.max(verdict.confidence, ...saysOpen.map(p => p.confidence), 0),
        reason: reasons.join(' '),
        applicationUrl: verdict.applicationUrl,
      }
    }
    reasons.push(`${verdict.reason} However ${saysClosed.map(p => p.provider).join(' and ')} report the 2027 intake as closed, so no change is asserted.`)
    return { status: null, confidence: 0, reason: reasons.join(' '), applicationUrl: '' }
  }

  // --- 2. A provider may open a role the board could not confirm -------------
  const openBacked = saysOpen.filter(p =>
    p.confidence >= 0.75
    && p.exactRoleFound
    && p.directApplication
    && p.officialSource
    && intakeAcceptable(p)
    && !intakeRefuted(p))

  if (openBacked.length && !boardAbsent) {
    // `exactRoleFound` and `directApplication` are the model's claims ABOUT ITS
    // OWN WORK. On their own they opened 71 of 78 roles from nothing more than a
    // reading of a generic careers page — the precise failure AGENTS.md warns
    // about. "Open Now" is the claim that makes the user stop and apply, so it
    // needs one corroborating fact the model did not author:
    //
    //   a) a link that unambiguously addresses ONE vacancy, or
    //   b) a fetched page that itself says applications are open, or
    //   c) a second provider reaching the same conclusion independently.
    const postingUrl = [
      ...openBacked.map(p => p.applicationUrl),
      record?.application_link,
      role.application_link,
    ].find(url => url && isSpecificPosting(url))

    const corroboration = postingUrl
      ? `the application link addresses a single posting (${postingUrl})`
      : verdict.pageSaysOpen
        ? 'the tracked page itself states applications are open'
        : openBacked.length > 1
          ? 'two providers reached this independently'
          : null

    if (!corroboration) {
      return {
        status: null,
        confidence: 0,
        reason: `${openBacked.map(p => p.provider).join(' and ')} judged this open, but nothing outside that judgement`
          + ' supports it: no applicant tracking system listed the role, the tracked link points at a landing page'
          + ' rather than one vacancy, and no fetched page states that applications are open.'
          + ' Leaving the status unchanged rather than telling you to apply.',
        applicationUrl: '',
      }
    }

    const confidence = Math.max(...openBacked.map(p => p.confidence))
    return {
      status: 'Open Now',
      confidence: openBacked.length > 1 ? Math.min(1, confidence + 0.05) : confidence,
      reason: `${openBacked.map(p => p.provider).join(' and ')} found a live application route for the exact 2027 role`
        + `${openBacked.length > 1 ? ', independently of each other' : ''}, and ${corroboration}.`
        + ` ${openBacked[0].evidenceSummary}`,
      applicationUrl: postingUrl ?? '',
    }
  }

  // --- 3. Closure needs the board's silence or a confident, unopposed model --
  const closedBacked = saysClosed.filter(p => p.confidence >= 0.8 && intakeAcceptable(p))
  if (boardAbsent && !saysOpen.length) {
    return {
      status: 'Closed',
      confidence: Math.max(verdict.confidence, ...closedBacked.map(p => p.confidence), 0),
      reason: `${verdict.reason}${closedBacked.length ? ` ${closedBacked.map(p => p.provider).join(' and ')} agree.` : ''}`,
      applicationUrl: '',
    }
  }
  if (closedBacked.length && !saysOpen.length && !boardLive) {
    // With two providers, both must agree before a role is closed: a wrong
    // "Closed" costs the user the role entirely.
    const unanimous = closedBacked.length === providers.length
    if (unanimous) {
      return {
        status: 'Closed',
        confidence: Math.max(...closedBacked.map(p => p.confidence)),
        reason: `${closedBacked.map(p => p.provider).join(' and ')} confirm the exact 2027 intake has closed. ${closedBacked[0].evidenceSummary}`,
        applicationUrl: '',
      }
    }
    return { status: null, confidence: 0, reason: 'Providers disagree about closure; the stored status is kept.', applicationUrl: '' }
  }

  // --- 4. A published opening date that has arrived opens the role -----------
  // The tracker's promise: when a posting names the day applications go live,
  // that day flips the card without waiting for a model to notice.
  //
  // A published date is a PREDICTION, though, not evidence that anything opened,
  // and the date itself is usually one the model supplied. Two limits keep that
  // from becoming a standing "apply now" nobody ever checked:
  //
  //   - a short window. `openingHasArrived` allows 45 days by default, which is
  //     right for the cheap scheduled job that flips a card on the day, and far
  //     too long here: this runs on every pass, so a date could re-assert an
  //     unverified role for six weeks. After a week a genuine opening has a live
  //     posting or an open signal, and the ordinary corroborated paths catch it.
  //   - the board's silence wins. If the employer's own board was enumerated and
  //     the role is not on it, a date does not override that.
  const announced = providers.find(p => p.openingAnnounced)
  const openingDate = record?.exact_opening_date || role.exact_opening_date
  if (announced && !boardAbsent && openingHasArrived(openingDate, today, SCHEDULED_OPENING_GRACE_DAYS)) {
    return {
      status: 'Open Now',
      confidence: 0.8,
      reason: `The employer published ${openingDate} as the day applications open for this role, and that day has arrived.`
        + ' This is the published schedule rather than a confirmed live application, so it stands only briefly'
        + ' unless a posting or an open application route corroborates it.',
      applicationUrl: '',
    }
  }

  // --- 5. Forward-looking states --------------------------------------------
  const soon = providers.find(p =>
    p.proposedStatus === 'Opening Soon' && p.confidence >= 0.7 && intakeAcceptable(p) && !intakeRefuted(p))
  if (soon) {
    return { status: 'Opening Soon', confidence: soon.confidence, reason: soon.evidenceSummary, applicationUrl: '' }
  }

  const expected = providers.find(p =>
    p.proposedStatus === 'Expected' && p.confidence >= 0.6 && intakeAcceptable(p) && !intakeRefuted(p))
  if (expected) {
    return { status: 'Expected', confidence: expected.confidence, reason: expected.evidenceSummary, applicationUrl: '' }
  }

  const notPublished = providers.find(p => p.proposedStatus === 'Not Yet Published' && p.confidence >= 0.6)
  if (notPublished) {
    return { status: 'Not Yet Published', confidence: notPublished.confidence, reason: notPublished.evidenceSummary, applicationUrl: '' }
  }

  // --- 6. No assertion -------------------------------------------------------
  // Deliberately NOT "Unknown". Today's run established nothing, so the row keeps
  // what it had; only a stale time-sensitive claim is cleared, by the caller.
  return {
    status: null,
    confidence: 0,
    reason: `No provider established the availability of the exact 2027 role today. ${verdict.reason}`,
    applicationUrl: '',
  }
}

/**
 * Does the primary result need a second opinion from the secondary provider?
 *
 * The secondary is not run on every row — it exists to catch the decisions that
 * cost the user something: opening a role that is not open, closing one that is,
 * and any low-confidence answer that would change a status the user relies on.
 */
export function needsSecondOpinion({ role, verdict, primary, primaryFailed }) {
  if (primaryFailed) return { needed: true, why: 'the primary provider failed' }
  if (!primary) return { needed: true, why: 'the primary provider returned nothing' }

  const stored = role.application_status
  const proposed = primary.proposedStatus
  const consequential = ['Open Now', 'Closed']

  if (consequential.includes(proposed) && proposed !== stored) {
    return { needed: true, why: `the primary provider proposes a consequential change (${stored} → ${proposed})` }
  }
  if (consequential.includes(stored) && proposed !== stored) {
    return { needed: true, why: `the primary provider would clear a consequential status (${stored} → ${proposed})` }
  }
  if (verdict.status === 'OPEN_NOW' && proposed === 'Closed') {
    return { needed: true, why: 'the primary provider contradicts a live job-board listing' }
  }
  if (verdict.status === 'CLOSED' && proposed === 'Open Now') {
    return { needed: true, why: 'the primary provider contradicts a fully enumerated job board' }
  }
  // The deterministic stage can carry a decision the primary provider never
  // proposed — a live board listing opens a role whatever the model called it.
  // Those flips are consequential too, so they get the same second look.
  if (verdict.status === 'OPEN_NOW' && stored !== 'Open Now') {
    return { needed: true, why: `the job board lists the role live while the tracker has it as ${stored}` }
  }
  if (verdict.status === 'CLOSED' && stored === 'Open Now') {
    return { needed: true, why: 'the job board no longer lists a role the tracker has as Open Now' }
  }
  if (primary.confidence < 0.7) {
    return { needed: true, why: `the primary provider is only ${Math.round(primary.confidence * 100)}% confident` }
  }
  return { needed: false, why: '' }
}

/**
 * Merges the researched columns of two providers. The primary wins wherever it
 * established a value; the secondary only fills gaps, so a second opinion can
 * enrich a record but never quietly rewrite it.
 */
export function mergeRecords(primaryRecord, secondaryRecord) {
  if (!secondaryRecord) return { ...primaryRecord }
  if (!primaryRecord) return { ...secondaryRecord }
  const merged = { ...primaryRecord }
  for (const field of RESEARCHED_FIELDS) {
    const value = merged[field]
    const missing = value === null || value === undefined || value === ''
    if (missing) merged[field] = secondaryRecord[field]
  }
  return merged
}

/** Days to the deadline, for logging and for the freshness heuristics. */
export function deadlineDays(role, today) {
  return daysUntil(role.exact_deadline, today)
}

export { toIsoDate, toDatedValue }
