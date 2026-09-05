import type { ChangeEvent } from 'react'
import type { Placement, PlacementPatch, AppStatus } from '../lib/supabase'
import { APP_STATUSES } from '../lib/supabase'
import { PRIORITY_COLORS, PRIORITY_LONG_LABELS, STATUS_COLORS, formatDate, orDash, relativeDays } from '../lib/utils'
import { explainScore, priorityOf, priorityScoreOf } from '../lib/ranking'
import { daysUntil, sectorGroup } from '../lib/filtering'
import { Field, Pill, ScoreBar, ScoreDial, Section } from './ui'
import './PlacementDetail.css'

interface Props {
  placement: Placement
  onPatch: (patch: PlacementPatch) => void
  onClose?: () => void
}

/**
 * The full record for one role, plus the only editable surface in the app.
 * Every input here writes a USER-owned column; researched columns are read-only
 * because the audit owns them and would overwrite a manual edit on its next run.
 */
export default function PlacementDetail({ placement: p, onPatch, onClose }: Props) {
  const priority = priorityOf(p)
  const score = priorityScoreOf(p)
  const verifiedAgo = relativeDays(daysUntil(p.source_date_checked))
  const set = (field: keyof PlacementPatch) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    onPatch({ [field]: event.target.value || null } as PlacementPatch)

  const handleStage = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as AppStatus
    onPatch({
      app_status: next,
      // Stamp the application date the first time a role reaches "Applied".
      date_applied: next === 'Applied' && !p.date_applied ? new Date().toISOString().slice(0, 10) : p.date_applied,
    })
  }

  return (
    <div className="detail">
      <header className="detail-head">
        <div>
          <span className="detail-eyebrow">{p.opportunity_type} · {sectorGroup(p)}</span>
          <h2>{p.company}</h2>
          <p>{p.specific_role}</p>
          <div className="detail-tags">
            <Pill tone={PRIORITY_COLORS[priority]}>{PRIORITY_LONG_LABELS[priority]}</Pill>
            <Pill tone={STATUS_COLORS[p.application_status]}>{p.application_status}</Pill>
            {p.start_year && <Pill>{p.start_year} intake</Pill>}
          </div>
        </div>
        <div className="detail-head-right">
          <ScoreDial score={score} size={68} />
          {onClose && <button className="detail-close" onClick={onClose} aria-label="Close details">×</button>}
        </div>
      </header>

      <div className="detail-actions">
        {p.application_link && (
          <a className="btn btn-primary" href={p.application_link} target="_blank" rel="noopener noreferrer">
            {p.application_status === 'Open Now' ? 'Apply now' : 'Open listing'}
          </a>
        )}
        {p.careers_page && p.careers_page !== p.application_link && (
          <a className="btn btn-ghost" href={p.careers_page} target="_blank" rel="noopener noreferrer">Careers page</a>
        )}
        {p.website && (
          <a className="btn btn-ghost" href={p.website} target="_blank" rel="noopener noreferrer">Company site</a>
        )}
        <button
          className={`btn btn-ghost ${p.not_interested ? 'is-on' : ''}`}
          onClick={() => onPatch({ not_interested: !p.not_interested })}
        >
          {p.not_interested ? 'Move back to opportunities' : 'Not interested'}
        </button>
        {p.archived && (
          <button className="btn btn-ghost is-on" onClick={() => onPatch({ archived: false })}>
            Restore to board
          </button>
        )}
      </div>

      <Section title="My application">
        <div className="tracking-grid">
          <label>
            Stage
            <select value={p.app_status} onChange={handleStage}>
              {APP_STATUSES.map(stage => <option key={stage}>{stage}</option>)}
            </select>
          </label>
          <label>
            Date applied
            <input type="date" value={p.date_applied ?? ''} onChange={set('date_applied')} />
          </label>
          <label>
            Interview date
            <input type="date" value={p.interview_date ?? ''} onChange={set('interview_date')} />
          </label>
          <label>
            CV version
            <input type="text" placeholder="e.g. Aerospace v4" value={p.cv_version ?? ''} onChange={set('cv_version')} />
          </label>
          <label>
            Referral / contact
            <input type="text" placeholder="Name or LinkedIn" value={p.referral_contact ?? ''} onChange={set('referral_contact')} />
          </label>
          <label>
            Cover letter
            <select value={p.cover_letter_required ?? ''} onChange={set('cover_letter_required')}>
              <option value="">Not recorded</option>
              <option value="Yes">Required</option>
              <option value="No">Not required</option>
              <option value="Submitted">Submitted</option>
            </select>
          </label>
        </div>
        <label className="tracking-notes">
          Notes
          <textarea
            rows={4}
            placeholder="Interview notes, next steps, contacts, reminders…"
            value={p.notes ?? ''}
            onChange={set('notes')}
          />
        </label>
      </Section>

      <Section title={`Why it ranks ${score}/100`}>
        <ul className="score-breakdown">
          {explainScore(p).map(part => (
            <li key={part.label}><span>{part.label}</span><b>{part.value}</b></li>
          ))}
        </ul>
        <div className="score-bars">
          <ScoreBar label="CV fit" score={p.cv_fit} />
          <ScoreBar label="Aerospace" score={p.aerospace_relevance} />
          <ScoreBar label="Rocket & space" score={p.rocket_space_relevance} />
          <ScoreBar label="F1 & motorsport" score={p.f1_motorsport_relevance} />
          <ScoreBar label="Aero & CFD" score={p.aero_cfd_relevance} />
          <ScoreBar label="Propulsion" score={p.propulsion_relevance} />
          <ScoreBar label="Controls & avionics" score={p.controls_avionics_relevance} />
          <ScoreBar label="Prestige" score={p.prestige} />
          <ScoreBar label="Career value" score={p.career_value} />
        </div>
        {p.why_it_fits && <p className="detail-prose"><strong>Fit.</strong> {p.why_it_fits}</p>}
        {p.potential_weaknesses && <p className="detail-prose"><strong>Watch out.</strong> {p.potential_weaknesses}</p>}
      </Section>

      <Section title="Timing">
        <dl className="field-list">
          <Field label="Applications open" value={formatDate(p.exact_opening_date) ?? orDash(p.exact_opening_date, '')} />
          <Field label="Deadline" value={formatDate(p.exact_deadline) ?? orDash(p.exact_deadline, '')} />
          <Field label="Deadline type" value={p.deadline_type} />
          <Field label="Placement starts" value={p.placement_start_date} />
          <Field label="Placement ends" value={p.placement_end_date} />
          <Field label="Duration" value={p.placement_duration} />
        </dl>
      </Section>

      <Section title="Eligibility & package">
        <dl className="field-list">
          <Field label="Degree" value={p.degree_requirements} />
          <Field label="Minimum grade" value={p.min_grade_requirement} />
          <Field label="Year of study" value={p.year_of_study_requirement} />
          <Field label="Technical skills" value={p.required_technical_skills} />
          <Field label="Work eligibility" value={p.work_eligibility} />
          <Field label="Security clearance" value={p.security_clearance_requirement} />
          <Field label="Salary" value={p.salary} />
          <Field label="Other benefits" value={p.other_benefits} />
          <Field label="Engineering area" value={p.engineering_area} />
        </dl>
      </Section>

      <Section title="Verification">
        <p className="detail-meta">
          {p.source_date_checked
            ? <>Last checked {formatDate(p.source_date_checked)}{verifiedAgo ? ` (${verifiedAgo})` : ''}.</>
            : <>This role has not been verified yet.</>}
        </p>
        {p.source_verified && <pre className="detail-evidence">{p.source_verified}</pre>}
      </Section>
    </div>
  )
}
