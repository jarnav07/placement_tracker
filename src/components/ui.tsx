import type { ReactNode } from 'react'
import { scoreColor, isBlank } from '../lib/utils'

/** Small labelled pill. `tone` drives the accent colour via a CSS variable. */
export function Pill({ children, tone, title }: { children: ReactNode; tone?: string; title?: string }) {
  return (
    <span className="pill" style={tone ? ({ '--pill-accent': tone } as React.CSSProperties) : undefined} title={title}>
      {children}
    </span>
  )
}

/** 0-100 ranking dial. The number is the headline; the ring encodes the same value. */
export function ScoreDial({ score, size = 56, label = 'match' }: { score: number; size?: number; label?: string }) {
  const radius = (size - 6) / 2
  const circumference = 2 * Math.PI * radius
  const colour = scoreColor(score / 10)
  return (
    <div className="score-dial" style={{ width: size, height: size }} title={`Ranking score ${score}/100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} className="dial-track" strokeWidth={4} fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={radius} strokeWidth={4} fill="none"
          stroke={colour} strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.max(0, Math.min(100, score)) / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="dial-value">
        <strong style={{ color: colour }}>{score}</strong>
        <small>{label}</small>
      </div>
    </div>
  )
}

/** Horizontal 0-10 bar used for every fit dimension. */
export function ScoreBar({ label, score }: { label: string; score: number | null }) {
  const value = Math.max(0, Math.min(10, score ?? 0))
  return (
    <div className="score-row">
      <span className="score-label">{label}</span>
      <span className="score-track">
        <span className="score-fill" style={{ width: `${value * 10}%`, background: scoreColor(value) }} />
      </span>
      <span className="score-value">{score === null ? '—' : `${value}`}</span>
    </div>
  )
}

/** A label/value row that renders nothing when the value is a placeholder. */
export function Field({ label, value, href }: { label: string; value: string | null | undefined; href?: string | null }) {
  if (isBlank(value)) return null
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>
        {href
          ? <a href={href} target="_blank" rel="noopener noreferrer">{value}</a>
          : value}
      </dd>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="detail-section">
      <h4>{title}</h4>
      {children}
    </section>
  )
}
