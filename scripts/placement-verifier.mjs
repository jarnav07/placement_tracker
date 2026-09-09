// Shared single-role verifier, used by discovery (`npm run discover`) and by the
// lightweight audit (`npm run audit`).
//
// It is a thin adapter over the same three stages the scheduled pass uses, so
// there is exactly ONE definition of "is this role open" in the repository:
//
//   1. `scripts/verify/evidence.mjs`  — deterministic pages + applicant tracking
//                                       system. Cannot hallucinate.
//   2. `scripts/verify/gemini.mjs`    — primary provider (Google Search grounded).
//   3. `scripts/verify/azure.mjs`     — secondary provider, on demand.
//   4. `scripts/verify/record.mjs`    — the gate that turns those into a status.
//
// This file previously carried its own 1 100-line copy of the fetching, board
// querying and gating logic. Two copies meant two behaviours: a fix to the
// scheduled audit never reached discovery, and discovery quietly inserted roles
// under rules the audit had already rejected.
//
// The tracked intake is 2027 (placements that START in 2027).

import {
  gatherEvidence, deterministicVerdict, TODAY, TARGET_INTAKE, STUDENT_TERM_RE,
} from './verify/evidence.mjs'
import { decideStatus, needsSecondOpinion, mergeRecords, TARGET_YEAR } from './verify/record.mjs'
import { verifyWithGemini, geminiConfigured } from './verify/gemini.mjs'
import { verifyWithAzure, azureConfigured } from './verify/azure.mjs'

const env = name => (process.env[name] || '').trim().replace(/^['"]|['"]$/g, '')

/** Providers are opt-in so discovery can run deterministically and for free. */
export const useGemini = env('USE_GEMINI') !== 'false' && geminiConfigured
export const useAzure = env('USE_AZURE') === 'true' && azureConfigured

/**
 * Maps the pipeline's own vocabulary onto the legacy result shape that discovery
 * and `npm run audit` consume. Keeping the adapter here means those two scripts
 * did not have to change when the verification internals did.
 */
function toLegacyResult({ role, evidence, verdict, primary, secondary, record, decision }) {
  const judgements = [primary?.judgement, secondary?.judgement].filter(Boolean)
  const best = judgements[0] ?? null

  const statusWord = {
    'Open Now': 'OPEN_NOW',
    'Opening Soon': 'OPENING_SOON',
    Expected: 'EXPECTED',
    'Not Yet Published': 'NOT_YET_PUBLISHED',
    Closed: 'CLOSED',
  }[decision.status] ?? (verdict.status ?? 'UNKNOWN')

  const boardLive = verdict.status === 'OPEN_NOW'
  const studentConfirmed =
    evidence.signals.student ||
    evidence.postingSignals?.student === true ||
    STUDENT_TERM_RE.test(role.specific_role || '') ||
    judgements.some(judgement => judgement.exactRoleFound && judgement.directApplication)

  // The intake is "acceptable" when it is stated as 2027, or unstated with
  // nothing contradicting it — the distinction that stopped this tracker seeing
  // openings at all. Consumers should gate on this, not on a printed year.
  const intakeAcceptable =
    judgements.some(judgement => judgement.intakeYear === TARGET_YEAR || (!judgement.intakeYear && judgement.intakeConsistent)) ||
    (boardLive && verdict.intakeConfirmed) ||
    verdict.intakeConfirmed

  const statedYear = judgements.find(judgement => judgement.intakeYear > 0)?.intakeYear ?? null

  return {
    status: statusWord,
    confidence: decision.confidence || verdict.confidence || best?.confidence || 0,
    intake_year: statedYear ? String(statedYear) : (intakeAcceptable ? String(TARGET_YEAR) : ''),
    intake_year_confirmed: statedYear === TARGET_YEAR,
    intake_2027_acceptable: intakeAcceptable && statedYear !== TARGET_YEAR + 1 && statedYear !== TARGET_YEAR - 1,
    exact_student_program_found: Boolean(studentConfirmed),
    exact_role_found: boardLive || judgements.some(judgement => judgement.exactRoleFound) || evidence.signals.titleContiguous,
    direct_application_for_exact_role_found:
      decision.status === 'Open Now' && (boardLive || judgements.some(judgement => judgement.directApplication)),
    official_program_source_found: boardLive || judgements.some(judgement => judgement.officialSource) || evidence.pages.length > 0,
    opening_date: record?.exact_opening_date ?? '',
    opening_timing: record?.exact_opening_date ?? '',
    deadline: record?.exact_deadline ?? '',
    deadline_type: record?.deadline_type ?? '',
    verified_application_url: decision.applicationUrl || verdict.applicationUrl || record?.application_link || '',
    location_city: record?.city ?? '',
    location_country: record?.country ?? '',
    salary: record?.salary ?? '',
    degree_requirements: record?.degree_requirements ?? '',
    placement_duration: record?.placement_duration ?? '',
    programme_type: record?.opportunity_type ?? '',
    website: record?.website ?? '',
    evidence_summary: decision.reason,
    sources: [
      ...evidence.pages.map(page => ({ url: page.url, type: 'page', evidence: 'Fetched by the tracker' })),
      ...(verdict.applicationUrl ? [{ url: verdict.applicationUrl, type: 'job-board', evidence: verdict.reason }] : []),
      ...judgements.flatMap(judgement => judgement.sources),
    ].slice(0, 10),
    mappedApplicationStatus: decision.status,
    evidence: [
      `Verification ${TODAY}: ${decision.status ?? 'no status change'}`
        + `${decision.status ? ` (${Math.round(decision.confidence * 100)}% confidence)` : ''}.`,
      `Deterministic check: ${verdict.status ?? 'no assertion'}. ${verdict.reason}`,
      // The decision often just restates the deterministic reason; do not print it twice.
      decision.reason.startsWith(verdict.reason) ? '' : decision.reason,
      ...judgements.map(judgement => `${judgement.provider}: ${judgement.evidenceSummary}`).filter(Boolean),
      evidence.pages.length ? 'Checked URLs:\n' + evidence.pages.map(page => `- ${page.url}`).join('\n') : '',
    ].filter(Boolean).join('\n').slice(0, 4000),
  }
}

/**
 * Verifies one role.
 *
 * The deterministic stage always runs. A provider is consulted only when that
 * stage could not decide AND it actually gathered something to reason over —
 * when nothing was fetchable there is nothing for a model to analyse, and
 * spending a call to have it guess is exactly how a false status gets written.
 *
 * Returns `{ ok, mode, result?, error? }`. A provider failure never deletes,
 * blanks or guesses a value.
 */
export async function verifyPlacement(role) {
  const evidence = await gatherEvidence(role)

  if (!evidence.pages.length && !evidence.board.ok) {
    return { ok: false, mode: 'deterministic', error: 'No fetchable pages or job board for this role' }
  }

  const verdict = deterministicVerdict(role, evidence)

  let primary = null
  let secondary = null

  // A decisive deterministic verdict needs no provider at all.
  const decisive = verdict.status === 'OPEN_NOW' && verdict.confidence >= 0.9

  if (!decisive && useGemini) {
    const result = await verifyWithGemini(role, evidence, verdict)
    if (result.ok) primary = result
    else console.warn(`  Gemini unavailable for ${role.company} — ${role.specific_role}: ${result.error}`)
  }

  if (!decisive && useAzure) {
    const second = needsSecondOpinion({
      role,
      verdict,
      primary: primary?.judgement ?? null,
      primaryFailed: !primary,
    })
    if (second.needed) {
      const result = await verifyWithAzure(role, evidence, verdict)
      if (result.ok) secondary = result
      else console.warn(`  Azure unavailable for ${role.company} — ${role.specific_role}: ${result.error}`)
    }
  }

  const record = mergeRecords(primary?.record ?? null, secondary?.record ?? null)
  const decision = decideStatus({
    role,
    record,
    verdict,
    primary: primary?.judgement ?? null,
    secondary: secondary?.judgement ?? null,
    today: TODAY,
  })

  const mode = primary ? 'gemini' : secondary ? 'azure' : 'deterministic'
  return { ok: true, mode, result: toLegacyResult({ role, evidence, verdict, primary, secondary, record, decision }) }
}

export { TODAY, TARGET_INTAKE }
