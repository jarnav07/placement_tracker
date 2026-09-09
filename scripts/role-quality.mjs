// Shared judgement about whether a scraped link is a real student vacancy.
//
// This is the single definition used by:
//   - scripts/placement-discovery.mjs, to decide what may be inserted;
//   - the `archived` backfill in
//     supabase/migrations/20260905120000_schema_cleanup_and_ranking.sql.
//
// Keeping one definition is what stopped the tracker filling with product
// pages ("Propulsion systems"), navigation links ("View all placements") and
// blog posts ("Why be an engineer at Babcock?") — 122 of 378 rows at the time
// the rule was written.

export const OPPORTUNITY_TYPES = [
  'Industrial Placement',
  'Spring Week / Insight',
  'Internship / Co-op',
  'Other Student Programme',
]

/** Explicit student-opportunity vocabulary. */
export const STUDENT_TERM_RE =
  /\bplacements?\b|year in industry|sandwich year|undergraduate (?:placement|work|internship)|internship|intern\b|co-?op\b|spring (?:week|insight)|insight (?:week|programme|program)|summer analyst/i

/** Words that make a string read like a job title rather than a page title. */
const ROLE_NOUN_RE =
  /\b(engineer|engineering|intern|internship|placement|analyst|scientist|technician|developer|programmer|designer|architect|specialist|apprentice|trainee|student|graduate|aerodynamicist|machinist|draughtsman)\b/i

/** Navigation, marketing and editorial shapes that are never a vacancy. */
const NON_ROLE_RE =
  /^(find|view|search|see|browse|explore|discover|meet|watch|read|learn|download|subscribe|register|sign up|why|how|what|life at|working at|women in|international opportunities|from apprentice|stepping into|our |all |more |about |visit |join us|click)\b/i

/**
 * Collateral ABOUT a programme, which every careers site publishes next to the
 * vacancies themselves. "Download the CGI Graduate and Industrial Placement
 * Brochure" names a programme and a placement, so the title rules above all pass
 * it — but it is a PDF, and inserting it produces a row nobody can apply to.
 * The name of the asset can appear anywhere in the title, not only at the front.
 */
const MARKETING_ASSET_RE =
  /\b(brochure|prospectus|handbook|factsheet|fact sheet|flyer|leaflet|newsletter|webinar|podcast|video|blog|case stud(?:y|ies)|white ?paper|e-?book|guide|faqs?|infographic|report)\b/i

/** A document is never a vacancy, whatever its link text says. */
const DOCUMENT_HREF_RE = /\.(pdf|docx?|pptx?|xlsx?)(?:$|[?#])/i

const NON_ROLE_TAIL_RE =
  /(smart (?:career )?choice|careers?\s*\/\s*vacancies|opportunities|vacancies|job search|search results|privacy|cookies?|accessibility|contact us|newsletter)$/i

/** Roles that exist but are outside the tracker's remit. */
const EXCLUDED_ROLE_RE =
  /\b(graduate (?:scheme|programme|program|job|role)|experienced hire|senior|principal|lead|head of|director|manager|post-?doc|phd|apprenticeship)\b/i

/**
 * Is this label plausibly the title of a student vacancy?
 * Deliberately strict: a rejected candidate costs one missed role, an accepted
 * junk candidate costs a permanent bad row plus an AI call on every audit.
 */
export function looksLikeStudentRole(label, href = '') {
  const title = String(label ?? '').replace(/\s+/g, ' ').trim()
  if (title.length < 8 || title.length > 110) return false
  if (title.includes('?')) return false

  // A vacancy title names a discipline as well as a programme. A bare
  // "Internship" is the heading of a listing page, and it is useless as a row:
  // the board already has one such row per employer.
  if (title.split(' ').filter(Boolean).length < 2) return false

  if (NON_ROLE_RE.test(title)) return false
  if (NON_ROLE_TAIL_RE.test(title)) return false
  if (MARKETING_ASSET_RE.test(title)) return false
  if (DOCUMENT_HREF_RE.test(String(href ?? ''))) return false
  if (EXCLUDED_ROLE_RE.test(title)) return false
  if (!ROLE_NOUN_RE.test(title)) return false

  // Evidence must come from the LINK itself — its label or its URL. Testing the
  // whole source page (the old behaviour) made this gate meaningless, because
  // any careers page mentions "internship" somewhere.
  const evidence = `${title} ${href}`
  return STUDENT_TERM_RE.test(evidence)
}

/** Does the link, or its own page, name the intake year we track? */
export function mentionsIntakeYear(text, year) {
  return new RegExp(`\\b${year}\\b`).test(String(text ?? ''))
}

/** Best-effort classification from a title; the audit re-checks this properly. */
export function classifyOpportunity(text) {
  const value = String(text ?? '')
  if (/spring (?:week|insight)|insight (?:week|programme|program)|career kickstart/i.test(value)) return 'Spring Week / Insight'
  if (/industrial placement|year in industry|placement year|sandwich (?:year|placement)|12-?month placement|undergraduate placement|student placement|work placement/i.test(value)) return 'Industrial Placement'
  if (/internship|intern\b|co-?op\b|summer analyst/i.test(value)) return 'Internship / Co-op'
  return 'Other Student Programme'
}
