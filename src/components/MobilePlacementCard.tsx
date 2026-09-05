import { useRef, useState } from 'react'
import type { Placement, PlacementPatch } from '../lib/supabase'
import { PRIORITY_COLORS, PRIORITY_LABELS, STATUS_COLORS, orDash, relativeDays, formatDate } from '../lib/utils'
import { priorityOf, priorityScoreOf } from '../lib/ranking'
import { daysUntil } from '../lib/filtering'
import { scoreColor } from '../lib/utils'
import './MobilePlacementCard.css'

interface Props {
  placement: Placement
  onOpen: () => void
  /** Swipe actions go through the app's single writer, so state stays in sync. */
  onPatch: (patch: PlacementPatch) => void
}

const SWIPE_THRESHOLD = 80
const MAX_SWIPE = 120
const SWIPE_SNAP_DURATION = 180
const DIRECTION_LOCK_DISTANCE = 8

export default function MobilePlacementCard({ placement: p, onOpen, onPatch }: Props) {
  const priority = priorityOf(p)
  const score = priorityScoreOf(p)
  const stage = p.app_status !== 'Not Applied' ? p.app_status : null
  const deadlineIn = daysUntil(p.exact_deadline)

  const cardRef = useRef<HTMLButtonElement>(null)
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

  const commitSwipe = (direction: 'left' | 'right') => {
    if (direction === 'left') {
      onPatch({ not_interested: !p.not_interested })
      return
    }
    const applied = p.app_status !== 'Not Applied'
    onPatch({
      app_status: applied ? 'Not Applied' : 'Applied',
      date_applied: applied ? null : (p.date_applied ?? new Date().toISOString().slice(0, 10)),
    })
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

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
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

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
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

  const releasePointer = (e: React.PointerEvent<HTMLButtonElement>) => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    } catch { /* browsers without pointer capture */ }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (activePointerId.current !== e.pointerId || !pointerStart.current) return
    releasePointer(e)
    finishSwipe()
  }

  const handlePointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
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
      ? (stage ? 'Un-apply' : 'Mark applied')
      : null

  return (
    <button
      ref={cardRef}
      className="mpc"
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
      aria-label={`Open ${p.company} — ${p.specific_role}`}
    >
      {swipeLabel && <span className={`mpc-swipe ${swipeSide}`}>{swipeLabel}</span>}
      <span className="mpc-body">
        <span className="mpc-top">
          <span className="mpc-company">{p.company}</span>
          <span className="mpc-score" style={{ color: scoreColor(score / 10) }}>{score}</span>
        </span>
        <span className="mpc-role">{p.specific_role}</span>
        <span className="mpc-tags">
          <span className="mpc-tag" style={{ '--pill-accent': PRIORITY_COLORS[priority] } as React.CSSProperties}>
            {PRIORITY_LABELS[priority]}
          </span>
          <span className="mpc-tag" style={{ '--pill-accent': STATUS_COLORS[p.application_status] } as React.CSSProperties}>
            {p.application_status}
          </span>
          {stage && <span className="mpc-tag" style={{ '--pill-accent': '#38bdf8' } as React.CSSProperties}>{stage}</span>}
        </span>
        <span className="mpc-meta">
          <span>{p.city ?? p.country ?? 'Location TBC'}</span>
          <span>{formatDate(p.exact_deadline) ?? orDash(p.exact_deadline, 'Deadline TBC')}</span>
          <span>{deadlineIn !== null ? relativeDays(deadlineIn) : orDash(p.salary, 'Salary TBC')}</span>
        </span>
      </span>
    </button>
  )
}
