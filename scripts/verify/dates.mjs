// Date handling for the availability pipeline.
//
// `exact_opening_date` and `exact_deadline` are free-text columns and years of
// model output have filled them with prose: "Not published for 2027", "Autumn
// 2026", "Vacancy dependent", "4 September 2026", "2026-09-14". Two features now
// depend on those columns being machine-readable:
//
//   1. a placement whose posting names the day applications go live is flipped to
//      "Open Now" on that day (`scripts/apply-scheduled-openings.mjs`);
//   2. the ranking gives weight to how close the deadline is.
//
// So every date written back is normalised to ISO `YYYY-MM-DD`, and prose that
// contains no date at all is stored as an empty value rather than being smuggled
// into a date column.
//
// Precision matters and is never invented:
//   'day'    — a specific calendar day. Only this may auto-open a placement.
//   'month'  — "November 2026". Enough to schedule a re-check, never to auto-open.
//   'season' — "Autumn 2026". Anchored to a month for sorting only; approximate.
//   'none'   — no date in the text.

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** Seasons are anchored to their first month, and always marked approximate. */
const SEASONS = { spring: 3, summer: 6, autumn: 9, fall: 9, winter: 12 }

const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*'

/** Text that means "there is no date", even when a year appears next to it. */
const NO_DATE_RE =
  /\b(not\s+(yet\s+)?(published|stated|announced|available|applicable|specified|confirmed|disclosed|listed)|no\s+(specific|published|annual|confirmed)|vacancy[- ]dependent|role[- ]dependent|year[- ]round|rolling|ongoing|continuous|tbc|tba|to be confirmed|to be announced|unknown|unspecified|n\/a|none)\b/i

const pad = value => String(value).padStart(2, '0')

function validParts(year, month, day) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return false
  if (!Number.isInteger(month) || month < 1 || month > 12) return false
  if (day === null) return true
  if (!Number.isInteger(day) || day < 1 || day > 31) return false
  // Reject 31 February and friends by round-tripping through UTC.
  const at = new Date(Date.UTC(year, month - 1, day))
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day
}

/**
 * Extracts the first real date from free text.
 * Returns `{ iso, precision, approximate }`; `iso` is '' when there is no date.
 * A month-precision result is anchored to the 1st so it still sorts.
 */
export function parseDateText(value) {
  const text = String(value ?? '').trim()
  const none = { iso: '', precision: 'none', approximate: false }
  if (!text) return none

  const day = (year, month, dayOfMonth) => validParts(year, month, dayOfMonth)
    ? { iso: `${year}-${pad(month)}-${pad(dayOfMonth)}`, precision: 'day', approximate: false }
    : null
  const month = (year, monthNumber, approximate) => validParts(year, monthNumber, null)
    ? { iso: `${year}-${pad(monthNumber)}-01`, precision: approximate ? 'season' : 'month', approximate: true }
    : null

  // --- Day precision -------------------------------------------------------

  // 2026-09-14 (also matches the date inside "opens 2026-09-14, closes …")
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/)
  if (iso) {
    const parsed = day(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    if (parsed) return parsed
  }

  // 4 September 2026 / 4th Sept 2026
  const dmy = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(20\\d{2})\\b`, 'i'))
  if (dmy) {
    const parsed = day(Number(dmy[3]), MONTHS[dmy[2].slice(0, 3).toLowerCase()], Number(dmy[1]))
    if (parsed) return parsed
  }

  // September 4, 2026 / Sept 4 2026
  const mdy = text.match(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'i'))
  if (mdy) {
    const parsed = day(Number(mdy[3]), MONTHS[mdy[1].slice(0, 3).toLowerCase()], Number(mdy[2]))
    if (parsed) return parsed
  }

  // 04/09/2026 and 04-09-2026, read as UK day-first — the tracker is UK-based and
  // every ambiguous case would otherwise silently shift by months.
  const slashed = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/)
  if (slashed) {
    const parsed = day(Number(slashed[3]), Number(slashed[2]), Number(slashed[1]))
    if (parsed) return parsed
  }

  // --- Month precision -----------------------------------------------------

  const monthYear = text.match(new RegExp(`\\b${MONTH_RE}\\.?\\s+(20\\d{2})\\b`, 'i'))
  if (monthYear) {
    const parsed = month(Number(monthYear[2]), MONTHS[monthYear[1].slice(0, 3).toLowerCase()], false)
    if (parsed) return parsed
  }

  const isoMonth = text.match(/\b(20\d{2})-(\d{1,2})\b/)
  if (isoMonth) {
    const parsed = month(Number(isoMonth[1]), Number(isoMonth[2]), false)
    if (parsed) return parsed
  }

  // --- Season precision ----------------------------------------------------

  const season = text.match(/\b(spring|summer|autumn|fall|winter)\s+(20\d{2})\b/i)
  if (season) {
    const parsed = month(Number(season[2]), SEASONS[season[1].toLowerCase()], true)
    if (parsed) return parsed
  }

  return none
}

/**
 * The value to store in a date column: ISO when a date was found, '' otherwise.
 * Prose such as "Not published for 2027" is discarded rather than stored — it is
 * not a date, and keeping it there breaks sorting, the deadline weighting and the
 * automatic opening rule.
 */
export function toIsoDate(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const parsed = parseDateText(text)
  if (!parsed.iso) return ''
  // "Applications are not yet published; the programme normally starts September
  // 2027" contains a date but asserts there is none. Trust the assertion.
  if (NO_DATE_RE.test(text) && parsed.precision !== 'day') return ''
  return parsed.iso
}

/** Same, but keeps the precision so callers can refuse to act on a vague date. */
export function toDatedValue(value) {
  const iso = toIsoDate(value)
  if (!iso) return { iso: '', precision: 'none', approximate: false }
  return { ...parseDateText(value), iso }
}

export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/** Whole days from `today` to `value`. Negative when the date has passed. */
export function daysUntil(value, today = todayIso()) {
  const iso = toIsoDate(value)
  if (!iso) return null
  const at = Date.parse(`${iso}T00:00:00Z`)
  const from = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(at) || Number.isNaN(from)) return null
  return Math.round((at - from) / 86_400_000)
}

/**
 * Has a published opening date arrived?
 *
 * Only a DAY-precision date qualifies. "November 2026" is not a promise that
 * applications open on 1 November, and flipping a placement to "Open Now" on a
 * guess is exactly the kind of wrong claim this tracker must not make. Month and
 * season dates instead make the row due for re-verification (`openingIsDue`).
 *
 * `graceDays` bounds how far in the past a stale opening date may still fire, so
 * a date left over from an earlier cycle cannot resurrect a dead role.
 */
export function openingHasArrived(value, today = todayIso(), graceDays = 45) {
  const parsed = toDatedValue(value)
  if (parsed.precision !== 'day') return false
  const days = daysUntil(parsed.iso, today)
  return days !== null && days <= 0 && days >= -graceDays
}

/** True once we have reached the month a vaguer opening date points at. */
export function openingIsDue(value, today = todayIso()) {
  const parsed = toDatedValue(value)
  if (parsed.precision === 'none') return false
  const days = daysUntil(parsed.iso, today)
  return days !== null && days <= 0
}
