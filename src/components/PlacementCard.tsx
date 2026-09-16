import type { Placement } from '../lib/supabase'
import { PRIORITY_COLORS, PRIORITY_LABELS, STAGE_COLORS, STATUS_COLORS, orDash, relativeDays, formatDate, slug } from '../lib/utils'
import { priorityOf, priorityScoreOf, domainRelevance, isNewlyOpened, openedAgo } from '../lib/ranking'
import { countryGroup, daysUntil, hasApplication, isSaved, sectorGroup } from '../lib/filtering'
import { Pill, SaveButton, ScoreDial } from './ui'
import './PlacementCard.css'

interface Props {
  placement: Placement
  /** Inserted into the board while this tab was open — a brief highlight, not the badge. */
  isNew?: boolean
  isSelected?: boolean
  onOpen: () => void
  onToggleSave: () => void
}

/**
 * The board card: one card per ROLE, never per company. A company running four
 * distinct placements gets four cards, each with its own rank, fit and deadline.
 *
 * Also the card for the saved tab: a saved role is still a role you are deciding
 * about, so it wants the same facts — score, deadline, apply link. The
 * applications tab gets its own card instead, because there the question has
 * changed from "is this worth applying to" to "where is this one up to".
 */
export default function PlacementCard({ placement: p, isNew, isSelected, onOpen, onToggleSave }: Props) {
  const saved = isSaved(p)
  const priority = priorityOf(p)
  const score = priorityScoreOf(p)
  const deadlineIn = daysUntil(p.exact_deadline)
  const urgent = deadlineIn !== null && deadlineIn >= 0 && deadlineIn <= 21
  // Applications opened within the last few days — the mark that says "this is
  // one you have not seen yet". Survives a reload, unlike the insert highlight.
  const justOpened = isNewlyOpened(p)
  // The scraped `city` sometimes already carries the country; do not repeat it.
  const cityText = (p.city ?? '').trim()
  const countryText = (p.country ?? '').trim()
  const location = [cityText, countryText.toLowerCase() && cityText.toLowerCase().includes(countryText.toLowerCase()) ? '' : countryText]
    .filter(Boolean).join(', ') || countryGroup(p) || 'Location TBC'

  return (
    <article
      className={[
        'card',
        `card--${slug(priority)}`,
        isNew ? 'is-new' : '',
        justOpened ? 'just-opened' : '',
        saved ? 'is-saved' : '',
        isSelected ? 'is-selected' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--priority-color': PRIORITY_COLORS[priority] } as React.CSSProperties}
    >
      <button className="card-hit" onClick={onOpen} aria-label={`Open ${p.company} — ${p.specific_role}`} />

      {justOpened && (
        <span className="card-new" title={openedAgo(p) ?? 'Recently opened'}>
          <i aria-hidden="true" />New
        </span>
      )}

      <header className="card-head">
        <div className="card-title">
          <h3>{p.company}</h3>
          <p>{p.specific_role}</p>
        </div>
        <ScoreDial score={score} />
      </header>

      <div className="card-tags">
        <Pill tone={PRIORITY_COLORS[priority]}>{PRIORITY_LABELS[priority]}</Pill>
        <Pill tone={STATUS_COLORS[p.application_status]}>{p.application_status}</Pill>
        <Pill>{p.opportunity_type}</Pill>
        {hasApplication(p) && <Pill tone={STAGE_COLORS[p.app_status]}>{p.app_status}</Pill>}
      </div>

      <dl className="card-facts">
        <div><dt>Location</dt><dd>{location}</dd></div>
        <div><dt>Sector</dt><dd>{sectorGroup(p)}</dd></div>
        <div><dt>Duration</dt><dd>{orDash(p.placement_duration)}</dd></div>
        <div><dt>Salary</dt><dd>{orDash(p.salary)}</dd></div>
        <div>
          <dt>Opens</dt>
          <dd>{formatDate(p.exact_opening_date) ?? orDash(p.exact_opening_date)}</dd>
        </div>
        <div className={urgent ? 'is-urgent' : undefined}>
          <dt>Deadline</dt>
          <dd>
            {formatDate(p.exact_deadline) ?? orDash(p.exact_deadline)}
            {deadlineIn !== null && <em> · {relativeDays(deadlineIn)}</em>}
          </dd>
        </div>
      </dl>

      <div className="card-scores">
        <span className="mini" title="CV fit"><b>{p.cv_fit ?? '—'}</b> CV fit</span>
        <span className="mini" title="Best matching domain"><b>{domainRelevance(p) || '—'}</b> domain</span>
        <span className="mini" title="Career value"><b>{p.career_value ?? '—'}</b> career</span>
        <span className="mini" title="Prestige"><b>{p.prestige ?? '—'}</b> prestige</span>
      </div>

      <footer className="card-foot">
        {p.application_link
          ? <a className="btn btn-primary" href={p.application_link} target="_blank" rel="noopener noreferrer">
              {p.application_status === 'Open Now' ? 'Apply' : 'View listing'}
            </a>
          : <span className="btn btn-disabled">No link</span>}
        {/* Offered only while no application exists: past that, the stage is the
            pipeline's and a save toggle would overwrite it. */}
        {!hasApplication(p) && <SaveButton saved={saved} onToggle={onToggleSave} />}
        <button className="btn btn-ghost card-details" onClick={onOpen}>Details</button>
      </footer>
    </article>
  )
}
