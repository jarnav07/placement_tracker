import type { ChangeEvent } from 'react'
import type { AppStatus, Placement, PlacementPatch } from '../lib/supabase'
import { APPLICATION_STAGES } from '../lib/supabase'
import {
  STAGE_COLORS, STAGE_ENDED, STAGE_LADDER, STATUS_COLORS,
  formatDate, isBlank, relativeDays, slug, stagePatch,
} from '../lib/utils'
import { daysUntil } from '../lib/filtering'
import { Pill } from './ui'
import './PlacementCard.css'
import './ApplicationCard.css'

interface Props {
  placement: Placement
  isSelected?: boolean
  onOpen: () => void
  onPatch: (patch: PlacementPatch) => void
}

/**
 * The card for the applications tab.
 *
 * It deliberately shows almost nothing the board card shows. On the board the
 * question is "is this worth applying to", so the card is a ranking: match
 * score, fit dimensions, sector, salary, priority band. Here the user has
 * already answered that question — they applied — and the only things that move
 * are their own: which stage they are at, when they applied, when the interview
 * is, which CV went out, who the referral was.
 *
 * So: no score dial, no fit numbers, no priority band, no salary. The vacancy's
 * own availability survives as one muted line, because a role can close after
 * you apply and you should be able to see that without it deciding whether the
 * card appears at all.
 */
export default function ApplicationCard({ placement: p, isSelected, onOpen, onPatch }: Props) {
  const stage = p.app_status
  const colour = STAGE_COLORS[stage]
  const ended = STAGE_ENDED.includes(stage)
  const reached = STAGE_LADDER.indexOf(stage)

  // `daysUntil` on a past date is negative, which `relativeDays` reads as "12 days ago".
  const appliedAgo = relativeDays(daysUntil(p.date_applied))
  const interviewIn = daysUntil(p.interview_date)
  // An interview inside a week is the one thing on this card worth colouring.
  const interviewSoon = interviewIn !== null && interviewIn >= 0 && interviewIn <= 7

  const handleStage = (event: ChangeEvent<HTMLSelectElement>) =>
    onPatch(stagePatch(event.target.value as AppStatus, p))

  return (
    <article
      className={[
        'card', 'appcard', `appcard--${slug(stage)}`,
        ended ? 'is-ended' : '', isSelected ? 'is-selected' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--priority-color': colour, '--stage-color': colour } as React.CSSProperties}
    >
      <button className="card-hit" onClick={onOpen} aria-label={`Open ${p.company} — ${p.specific_role}`} />

      <header className="card-head">
        <div className="card-title">
          <h3>{p.company}</h3>
          <p>{p.specific_role}</p>
        </div>
        <span className="appcard-stage">{stage}</span>
      </header>

      {/* Where the application is on the ladder. Rejected and Withdrawn do not
          get a position — they are how it stopped, not how far it got. */}
      {ended
        ? <p className="appcard-ended">This application ended at <b>{stage.toLowerCase()}</b>.</p>
        : (
          <ol className="appcard-ladder" aria-label={`Stage ${reached + 1} of ${STAGE_LADDER.length}: ${stage}`}>
            {STAGE_LADDER.map((step, index) => (
              <li
                key={step}
                className={index < reached ? 'is-done' : index === reached ? 'is-now' : ''}
                title={step}
              >
                <i aria-hidden="true" />
                <span>{step === 'Final Interview' ? 'Final' : step}</span>
              </li>
            ))}
          </ol>
        )}

      <dl className="card-facts appcard-facts">
        <div>
          <dt>Applied</dt>
          <dd>
            {formatDate(p.date_applied) ?? 'Not recorded'}
            {appliedAgo && <em> · {appliedAgo}</em>}
          </dd>
        </div>
        <div className={interviewSoon ? 'is-urgent' : undefined}>
          <dt>Interview</dt>
          <dd>
            {formatDate(p.interview_date) ?? 'Not scheduled'}
            {interviewIn !== null && <em> · {relativeDays(interviewIn)}</em>}
          </dd>
        </div>
        <div>
          <dt>CV sent</dt>
          <dd>{isBlank(p.cv_version) ? 'Not recorded' : p.cv_version}</dd>
        </div>
        <div>
          <dt>Cover letter</dt>
          <dd>{isBlank(p.cover_letter_required) ? 'Not recorded' : p.cover_letter_required}</dd>
        </div>
        {!isBlank(p.referral_contact) && (
          <div className="appcard-wide">
            <dt>Referral / contact</dt>
            <dd>{p.referral_contact}</dd>
          </div>
        )}
      </dl>

      {!isBlank(p.notes) && <p className="appcard-notes">{p.notes}</p>}

      {/* The vacancy's own state, kept quiet. It never decides whether this card
          is rendered — an application you made is yours whatever the employer
          does to the listing afterwards. */}
      <p className="appcard-vacancy">
        <Pill tone={STATUS_COLORS[p.application_status]}>{p.application_status}</Pill>
        <span>{p.opportunity_type}</span>
      </p>

      <footer className="card-foot appcard-foot">
        <label className="appcard-stage-picker">
          <span>Stage</span>
          <select value={stage} onChange={handleStage} aria-label={`Stage for ${p.company}`}>
            {APPLICATION_STAGES.map(option => <option key={option}>{option}</option>)}
          </select>
        </label>
        {p.application_link && (
          <a className="btn btn-ghost" href={p.application_link} target="_blank" rel="noopener noreferrer">Listing</a>
        )}
        <button className="btn btn-ghost card-details" onClick={onOpen}>Details</button>
      </footer>
    </article>
  )
}
