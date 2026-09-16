import { useRef, useState } from 'react'
import type { Placement, PlacementPatch } from '../lib/supabase'
import {
  PRIORITY_COLORS, PRIORITY_LABELS, STAGE_COLORS, STAGE_ENDED, STAGE_LADDER, STATUS_COLORS,
  orDash, relativeDays, formatDate, isBlank, stagePatch,
} from '../lib/utils'
import { priorityOf, priorityScoreOf, isNewlyOpened, openedAgo } from '../lib/ranking'
import { daysUntil, hasApplication, isSaved } from '../lib/filtering'
import { scoreColor } from '../lib/utils'
import { SaveButton } from './ui'
import './MobilePlacementCard.css'

interface Props {
  placement: Placement
  /**
   * `application` swaps the ranking half of the row for the user's own record.
   * The gestures are identical in both — the swipe is how this app is used.
   */
  variant?: 'opportunity' | 'application'
  onOpen: () => void
  /** Swipe actions go through the app's single writer, so state stays in sync. */
  onPatch: (patch: PlacementPatch) => void
}

const SWIPE_THRESHOLD = 80
const MAX_SWIPE = 120
const SWIPE_SNAP_DURATION = 180
const DIRECTION_LOCK_DISTANCE = 8

export default function MobilePlacementCard({ placement: p, variant = 'opportunity', onOpen, onPatch }: Props) {
  const isApplicationRow = variant === 'application'
  const applied = hasApplication(p)
  const saved = isSaved(p)
  const priority = priorityOf(p)
  const score = priorityScoreOf(p)
  const deadlineIn = daysUntil(p.exact_deadline)
  const urgent = deadlineIn !== null && deadlineIn >= 0 && deadlineIn <= 21
  const justOpened = isNewlyOpened(p)

  // `daysUntil` on a past date is negative, which `relativeDays` reads as "12 days ago".
  const appliedAgo = relativeDays(daysUntil(p.date_applied))
  const interviewIn = daysUntil(p.interview_date)
  const interviewSoon = interviewIn !== null && interviewIn >= 0 && interviewIn <= 7
  const ladderStep = STAGE_LADDER.indexOf(p.app_status)

  const cardRef = useRef<HTMLDivElement>(null)
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const activePointerId = useRef<number | null>(null)
  const gestureAxis = useRef<'horizontal' | 'vertical' | null>(null)
  const swipeX = useRef(0)
  const didSwipe = useRef(false)
  const hapticTriggered = useRef(false)
  const animationFrame = useRef<number | null>(null)
  const resetTimer = useRef<number | null>(null)
  const [swipeSide, setSwipeSide] = useState<'left' | 'right' | null>(null)

  const applySwipeVisual = (x: number, animate = false) => {
    const card = cardRef.current
    if (!card) return
    if (animationFrame.current !== null) {
      cancelAnimationFrame(animationFrame.current)
      animationFrame.current = null
    }
    const clamped = Math.max(-MAX_SWIPE, Math.min(MAX_SWIPE, x))
    swipeX.current = clamped
    card.classList.toggle('is-dragging', !animate)
    animationFrame.current = requestAnimationFrame(() => {
      const rotation = Math.max(-4, Math.min(4, clamped * 0.028))
      const scale = 1 - Math.min(Math.abs(clamped) / MAX_SWIPE, 1) * 0.012
      card.style.transform = `translate3d(${clamped}px, 0, 0) rotate(${rotation}deg) scale(${scale})`
      animationFrame.current = null
    })
  }

  const resetSwipeVisual = () => {
    const card = cardRef.current
    if (!card) return
    card.classList.remove('is-dragging')
    card.style.transform = 'translate3d(0, 0, 0) rotate(0deg) scale(1)'
    swipeX.current = 0
  }

  /** A short low tone as the swipe crosses its commit threshold. Purely optional. */
  const triggerClick = () => {
    try {
      const AudioContextClass = window.AudioContext
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextClass) return
      const context = new AudioContextClass()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const now = context.currentTime
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(115, now)
      oscillator.frequency.exponentialRampToValueAtTime(70, now + 0.025)
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.045, now + 0.002)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.028)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(now)
      oscillator.stop(now + 0.03)
      window.setTimeout(() => void context.close(), 100)
    } catch {
      // Feedback must never interfere with the gesture.
    }
  }

  /**
   * Right is "one step further in": a saved role becomes an application rather
   * than being thrown back to Not Applied, which is what it did while `Saved`
   * still counted as applied. Only a real application un-applies.
   */
  const commitSwipe = (direction: 'left' | 'right') => {
    if (direction === 'left') {
      onPatch({ not_interested: !p.not_interested })
      return
    }
    onPatch(stagePatch(applied ? 'Not Applied' : 'Applied', p))
  }

  const finishSwipe = () => {
    const dx = swipeX.current
    pointerStart.current = null
    activePointerId.current = null
    gestureAxis.current = null
    hapticTriggered.current = false
    setSwipeSide(null)

    if (Math.abs(dx) < SWIPE_THRESHOLD) {
      applySwipeVisual(0, true)
      resetTimer.current = window.setTimeout(resetSwipeVisual, SWIPE_SNAP_DURATION)
      didSwipe.current = false
      return
    }

    applySwipeVisual(dx > 0 ? 18 : -18, true)
    resetTimer.current = window.setTimeout(() => {
      resetSwipeVisual()
      commitSwipe(dx < 0 ? 'left' : 'right')
    }, SWIPE_SNAP_DURATION)
    window.setTimeout(() => { didSwipe.current = false }, SWIPE_SNAP_DURATION)
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== null) return
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current)
      resetTimer.current = null
    }
    activePointerId.current = e.pointerId
    pointerStart.current = { x: e.clientX, y: e.clientY }
    gestureAxis.current = null
    swipeX.current = 0
    didSwipe.current = false
    hapticTriggered.current = false
    setSwipeSide(null)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* enhancement only */ }
    cardRef.current?.classList.add('is-dragging')
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointerStart.current || activePointerId.current !== e.pointerId) return
    const dx = e.clientX - pointerStart.current.x
    const dy = e.clientY - pointerStart.current.y

    if (gestureAxis.current === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DIRECTION_LOCK_DISTANCE) return
      gestureAxis.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
    }
    if (gestureAxis.current === 'vertical') return

    e.preventDefault()
    didSwipe.current = true
    setSwipeSide(Math.abs(dx) >= 35 ? (dx < 0 ? 'left' : 'right') : null)
    if (Math.abs(dx) >= SWIPE_THRESHOLD && !hapticTriggered.current) {
      hapticTriggered.current = true
      triggerClick()
    }
    applySwipeVisual(dx)
  }

  const releasePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    } catch { /* browsers without pointer capture */ }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== e.pointerId || !pointerStart.current) return
    releasePointer(e)
    finishSwipe()
  }

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== e.pointerId || !pointerStart.current) return
    releasePointer(e)
    pointerStart.current = null
    activePointerId.current = null
    gestureAxis.current = null
    hapticTriggered.current = false
    setSwipeSide(null)
    applySwipeVisual(0, true)
    resetTimer.current = window.setTimeout(resetSwipeVisual, SWIPE_SNAP_DURATION)
    didSwipe.current = false
  }

  const swipeLabel = swipeSide === 'left'
    ? (p.not_interested ? 'Back to board' : 'Not interested')
    : swipeSide === 'right'
      ? (applied ? 'Un-apply' : 'Mark applied')
      : null

  return (
    /*
     * A div rather than a button, because the row now carries its own Save
     * button and a button inside a button is invalid. Every pointer handler
     * still sits on this one element, so the swipe gesture is byte-for-byte the
     * one it was; the role, tabindex and key handler put the keyboard and
     * screen-reader behaviour back.
     */
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      className={`mpc${justOpened ? ' just-opened' : ''}${saved ? ' is-saved' : ''}`}
      style={{ '--priority-color': PRIORITY_COLORS[priority] } as React.CSSProperties}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onClick={event => {
        // A completed swipe must not also count as a tap.
        if (didSwipe.current) { event.preventDefault(); event.stopPropagation(); return }
        onOpen()
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen()
      }}
      aria-label={`Open ${p.company} — ${p.specific_role}`}
    >
      {swipeLabel && <span className={`mpc-swipe ${swipeSide}`}>{swipeLabel}</span>}
      <span className="mpc-body">
        <span className="mpc-top">
          <span className="mpc-titles">
            <span className="mpc-company">{p.company}</span>
            <span className="mpc-role">{p.specific_role}</span>
          </span>
          <span className="mpc-actions">
            {/* Save sits beside the score, at a full 44px, because on a phone it
                is the action taken while scanning — the swipe is for the two
                decisions, this is for "come back to it". */}
            {!isApplicationRow && !applied && (
              <SaveButton compact saved={saved} onToggle={() => onPatch(stagePatch(saved ? 'Not Applied' : 'Saved', p))} />
            )}
            {isApplicationRow
              ? (
                <span
                  className="mpc-stage"
                  style={{ '--stage-color': STAGE_COLORS[p.app_status] } as React.CSSProperties}
                  title={`Stage: ${p.app_status}`}
                >
                  {ladderStep === -1
                    ? <b>{STAGE_ENDED.includes(p.app_status) ? '—' : '·'}</b>
                    : <b>{ladderStep + 1}<small>/{STAGE_LADDER.length}</small></b>}
                </span>
              )
              /* The score reads as match quality, not a stray number, so it gets
                 a tinted badge in its own colour rather than plain coloured text. */
              : (
                <span
                  className="mpc-score"
                  style={{ '--score-color': scoreColor(score / 10) } as React.CSSProperties}
                  title={`Ranking score ${score}/100`}
                >
                  {score}
                </span>
              )}
          </span>
        </span>

        {isApplicationRow
          ? (
            <>
              <span className="mpc-tags">
                <span
                  className="mpc-tag mpc-tag--stage"
                  style={{ '--pill-accent': STAGE_COLORS[p.app_status] } as React.CSSProperties}
                >
                  {p.app_status}
                </span>
                <span className="mpc-tag" style={{ '--pill-accent': STATUS_COLORS[p.application_status] } as React.CSSProperties}>
                  {p.application_status}
                </span>
                {!isBlank(p.cv_version) && <span className="mpc-tag">CV {p.cv_version}</span>}
              </span>
              {/* Their record, not the ranking: when they applied and what is next. */}
              <span className="mpc-meta">
                <span>{p.date_applied ? `Applied ${formatDate(p.date_applied)}` : 'No date applied'}</span>
                {appliedAgo && <><span aria-hidden="true">·</span><span>{appliedAgo}</span></>}
                {p.interview_date && (
                  <b className={interviewSoon ? 'is-urgent' : undefined}>
                    Interview {relativeDays(interviewIn) ?? formatDate(p.interview_date)}
                  </b>
                )}
              </span>
            </>
          )
          : (
            <>
              <span className="mpc-tags">
                {/* Applications opened in the last few days. First in the row so it is
                    the first thing read while thumbing down the list. */}
                {justOpened && (
                  <span className="mpc-tag mpc-tag--new" title={openedAgo(p) ?? 'Recently opened'}>
                    <i aria-hidden="true" />New
                  </span>
                )}
                <span className="mpc-tag" style={{ '--pill-accent': PRIORITY_COLORS[priority] } as React.CSSProperties}>
                  {PRIORITY_LABELS[priority]}
                </span>
                <span className="mpc-tag" style={{ '--pill-accent': STATUS_COLORS[p.application_status] } as React.CSSProperties}>
                  {p.application_status}
                </span>
                {applied && (
                  <span className="mpc-tag" style={{ '--pill-accent': STAGE_COLORS[p.app_status] } as React.CSSProperties}>
                    {p.app_status}
                  </span>
                )}
              </span>
              {/* One fact line: where, when, and how long is left — the countdown is
                  the only part that changes colour, so urgency is the thing you see. */}
              <span className="mpc-meta">
                <span>{p.city ?? p.country ?? 'Location TBC'}</span>
                <span aria-hidden="true">·</span>
                <span>{formatDate(p.exact_deadline) ?? orDash(p.exact_deadline, 'Deadline TBC')}</span>
                {deadlineIn !== null && (
                  <b className={urgent ? 'is-urgent' : undefined}>{relativeDays(deadlineIn)}</b>
                )}
              </span>
            </>
          )}
      </span>
    </div>
  )
}
