import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, PRIORITIES, APP_STATUSES } from './lib/supabase'
import type { Placement, PlacementPatch, OverallPriority } from './lib/supabase'
import { PRIORITY_COLORS, PRIORITY_LABELS } from './lib/utils'
import {
  EMPTY_FILTERS, countBy, filterPlacements, hasActiveFilters, placementsForView, sortPlacements,
  type Filters as FilterState, type SortOption, type View,
} from './lib/filtering'
import { priorityOf } from './lib/ranking'
import { downloadExcel } from './lib/excel'
import PlacementCard from './components/PlacementCard'
import PlacementDetail from './components/PlacementDetail'
import MobilePlacementCard from './components/MobilePlacementCard'
import Filters from './components/Filters'
import './App.css'
import './mobile.css'

/** The pipeline reads left to right, so it is rendered in stage order, not count order. */
const PIPELINE_STAGES = APP_STATUSES.filter(stage => stage !== 'Not Applied')

const VIEWS: { key: View; label: string; short: string; icon: string }[] = [
  { key: 'opportunities', label: 'Opportunities', short: 'Explore', icon: '\u2302' },
  { key: 'applications', label: 'My applications', short: 'Applications', icon: '\u2713' },
  { key: 'not-interested', label: 'Not interested', short: 'Not interested', icon: '\u2212' },
]

export default function App() {
  const [placements, setPlacements] = useState<Placement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [view, setView] = useState<View>('opportunities')
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [sort, setSort] = useState<SortOption>('priority')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newIds, setNewIds] = useState<Set<string>>(new Set())
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const highlightTimers = useRef<number[]>([])

  // --- Data ---------------------------------------------------------------

  useEffect(() => {
    let cancelled = false

    async function load() {
      const { data, error: loadError } = await supabase
        .from('placements')
        .select('*')
        .order('priority_score', { ascending: false })
      if (cancelled) return
      if (loadError) { setError(loadError.message); setLoading(false); return }
      setPlacements((data ?? []) as Placement[])
      setLoading(false)
    }
    void load()

    const channel = supabase
      .channel('placements-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'placements' }, payload => {
        if (payload.eventType === 'INSERT') {
          const row = payload.new as Placement
          setPlacements(prev => (prev.some(p => p.id === row.id) ? prev : [row, ...prev]))
          setNewIds(prev => new Set(prev).add(row.id))
          highlightTimers.current.push(window.setTimeout(
            () => setNewIds(prev => { const next = new Set(prev); next.delete(row.id); return next }),
            6000,
          ))
        } else if (payload.eventType === 'UPDATE') {
          const row = payload.new as Placement
          setPlacements(prev => prev.map(p => (p.id === row.id ? row : p)))
        } else if (payload.eventType === 'DELETE') {
          const row = payload.old as Placement
          setPlacements(prev => prev.filter(p => p.id !== row.id))
          setSelectedId(prev => (prev === row.id ? null : prev))
        }
      })
      .subscribe(status => setConnected(status === 'SUBSCRIBED'))

    return () => {
      cancelled = true
      highlightTimers.current.forEach(window.clearTimeout)
      void supabase.removeChannel(channel)
    }
  }, [])

  /**
   * The single writer. Only user-owned columns are ever sent, and the derived
   * ranking columns are re-read from the row the database returns so the UI can
   * never drift from `placements_apply_ranking()`.
   */
  const patchPlacement = useCallback(async (id: string, patch: PlacementPatch) => {
    setPlacements(prev => prev.map(p => (p.id === id ? { ...p, ...patch } : p)))
    const { data, error: saveError } = await supabase
      .from('placements').update(patch).eq('id', id).select().single()
    if (saveError) {
      setError(`Could not save: ${saveError.message}`)
      return
    }
    setError(null)
    if (data) setPlacements(prev => prev.map(p => (p.id === id ? (data as Placement) : p)))
  }, [])

  // --- Derived ------------------------------------------------------------

  const board = useMemo(() => placementsForView(placements, 'opportunities'), [placements])

  const stats = useMemo(() => ({
    tracked: placements.filter(p => !p.archived).length,
    board: board.length,
    open: board.filter(p => p.application_status === 'Open Now').length,
    soon: board.filter(p => p.application_status === 'Opening Soon').length,
    applied: placements.filter(p => !p.archived && p.app_status !== 'Not Applied').length,
    hidden: placements.filter(p => p.not_interested && !p.archived).length,
  }), [placements, board])

  const priorityCounts = useMemo(() => countBy<OverallPriority>(board, priorityOf), [board])
  const stageCounts = useMemo(
    () => countBy(placements.filter(p => !p.archived), p => (p.app_status === 'Not Applied' ? null : p.app_status)),
    [placements],
  )

  const visible = useMemo(() => {
    const scoped = placementsForView(placements, view)
    return sortPlacements(filterPlacements(scoped, filters), sort)
  }, [placements, view, filters, sort])

  const selected = useMemo(
    () => placements.find(p => p.id === selectedId) ?? null,
    [placements, selectedId],
  )

  // --- Actions ------------------------------------------------------------

  const updateFilters = useCallback((patch: Partial<FilterState>) => setFilters(prev => ({ ...prev, ...patch })), [])
  const resetFilters = useCallback(() => { setFilters(EMPTY_FILTERS); setSort('priority') }, [])
  const filtersActive = hasActiveFilters(filters)

  const changeView = useCallback((next: View) => {
    setView(next)
    setSelectedId(null)
    setMobileFiltersOpen(false)
    setMobileSearchOpen(false)
    // Stage only exists inside the applications view; carrying it out is confusing.
    setFilters(prev => (next === 'applications' ? prev : { ...prev, stage: 'all' }))
  }, [])

  const jumpTo = useCallback((patch: Partial<FilterState>) => {
    setView('opportunities')
    setFilters({ ...EMPTY_FILTERS, ...patch })
  }, [])

  const patchSelected = useCallback(
    (patch: PlacementPatch) => { if (selectedId) void patchPlacement(selectedId, patch) },
    [selectedId, patchPlacement],
  )

  const emptyMessage = {
    opportunities: 'No opportunities match these filters.',
    applications: 'You have not tracked any applications yet.',
    'not-interested': 'Nothing has been marked as not interested.',
  }[view]

  const searchPlaceholder = view === 'applications'
    ? 'Search your applications, notes and contacts…'
    : 'Search companies, roles, skills, locations…'

  return (
    <>
      {/* ---------------------------------------------------------------- */}
      {/* Desktop                                                          */}
      {/* ---------------------------------------------------------------- */}
      <div className="desktop-app">
        <header className="app-header">
          <div className="shell header-inner">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true">✈</span>
              <div>
                <h1>Placement Tracker</h1>
                <p>2027–28 intake · aerospace, space, motorsport &amp; engineering · {stats.tracked} roles tracked</p>
              </div>
            </div>
            <div className="header-actions">
              <span className={`live ${connected ? 'is-live' : ''}`}>
                <i aria-hidden="true" />{connected ? 'Live' : 'Connecting…'}
              </span>
              <button className="btn btn-primary" onClick={() => downloadExcel(placements)}>Export Excel</button>
            </div>
          </div>

          <div className="shell stat-row">
            <div className="stat"><b>{stats.board}</b><span>On the board</span></div>
            <button className="stat stat--open" onClick={() => jumpTo({ status: 'Open Now' })}>
              <b>{stats.open}</b><span>Open now</span>
            </button>
            <button className="stat stat--soon" onClick={() => jumpTo({ status: 'Opening Soon' })}>
              <b>{stats.soon}</b><span>Opening soon</span>
            </button>
            <button className="stat stat--applied" onClick={() => changeView('applications')}>
              <b>{stats.applied}</b><span>Applications</span>
            </button>
            <button className="stat stat--muted" onClick={() => changeView('not-interested')}>
              <b>{stats.hidden}</b><span>Not interested</span>
            </button>
          </div>
        </header>

        <main className="shell app-main">
          <nav className="view-tabs" aria-label="Views">
            {VIEWS.map(item => (
              <button
                key={item.key}
                className={view === item.key ? 'is-active' : ''}
                onClick={() => changeView(item.key)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {view === 'opportunities' && (
            <div className="priority-tabs">
              <button
                className={filters.priority === 'all' ? 'is-active' : ''}
                onClick={() => updateFilters({ priority: 'all' })}
              >
                <i style={{ background: '#64748b' }} />All<b>{board.length}</b>
              </button>
              {PRIORITIES.map(key => (
                <button
                  key={key}
                  className={filters.priority === key ? 'is-active' : ''}
                  onClick={() => updateFilters({ priority: filters.priority === key ? 'all' : key })}
                >
                  <i style={{ background: PRIORITY_COLORS[key] }} />{PRIORITY_LABELS[key]}<b>{priorityCounts[key] ?? 0}</b>
                </button>
              ))}
            </div>
          )}

          {view === 'applications' && (
            <div className="pipeline">
              {stats.applied === 0
                ? <p className="pipeline-empty">Open any role and set a stage to start your pipeline.</p>
                : PIPELINE_STAGES.map(stage => (
                    <button
                      key={stage}
                      className={filters.stage === stage ? 'is-active' : ''}
                      onClick={() => updateFilters({ stage: filters.stage === stage ? 'all' : stage })}
                    >
                      <b>{stageCounts[stage] ?? 0}</b><span>{stage}</span>
                    </button>
                  ))}
            </div>
          )}

          <div className="controls">
            <input
              className="search"
              type="search"
              placeholder={searchPlaceholder}
              value={filters.search}
              onChange={e => updateFilters({ search: e.target.value })}
            />
            <Filters
              filters={filters} sort={sort} view={view}
              onChange={updateFilters} onSort={setSort} onReset={resetFilters} showReset={filtersActive}
            />
          </div>

          {error && <p className="alert">{error}</p>}

          <p className="result-count">
            <strong>{visible.length}</strong> {visible.length === 1 ? 'role' : 'roles'}
            {filtersActive ? ' matching your filters' : ''}
          </p>

          {loading
            ? <p className="empty">Loading placements…</p>
            : visible.length === 0
              ? (
                <div className="empty">
                  <p>{emptyMessage}</p>
                  {filtersActive && <button className="btn btn-ghost" onClick={resetFilters}>Reset filters</button>}
                </div>
              )
              : (
                <div className="card-grid">
                  {visible.map(p => (
                    <PlacementCard
                      key={p.id}
                      placement={p}
                      isNew={newIds.has(p.id)}
                      isSelected={selectedId === p.id}
                      onOpen={() => setSelectedId(p.id)}
                    />
                  ))}
                </div>
              )}
        </main>

        {selected && (
          <>
            <div className="drawer-backdrop" onClick={() => setSelectedId(null)} />
            <aside className="drawer" aria-label={`${selected.company} details`}>
              <PlacementDetail placement={selected} onPatch={patchSelected} onClose={() => setSelectedId(null)} />
            </aside>
          </>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Mobile                                                           */}
      {/* ---------------------------------------------------------------- */}
      <div className="mobile-app">
        <header className="m-top">
          <div>
            <span className="m-eyebrow">2027–28 INTAKE</span>
            <h1>{VIEWS.find(item => item.key === view)?.label}</h1>
          </div>
          <div className="m-tools">
            <button className={`m-icon ${connected ? 'is-live' : ''}`} aria-label="Realtime connection status">
              <i />
            </button>
            <button className="m-icon" onClick={() => setMobileSearchOpen(open => !open)} aria-label="Search">⌕</button>
            <button className="m-icon" onClick={() => downloadExcel(placements)} aria-label="Export to Excel">⇩</button>
          </div>
        </header>

        <main className="m-main">
          {view === 'opportunities' && (
            <div className="m-stats">
              <button onClick={() => jumpTo({ status: 'Open Now' })}><b>{stats.open}</b><span>Open now</span></button>
              <button onClick={() => jumpTo({ status: 'Opening Soon' })}><b>{stats.soon}</b><span>Opening soon</span></button>
              <button onClick={() => changeView('applications')}><b>{stats.applied}</b><span>Applied</span></button>
            </div>
          )}

          {mobileSearchOpen && (
            <div className="m-search">
              <span aria-hidden="true">⌕</span>
              <input
                autoFocus type="search" placeholder="Search placements…"
                value={filters.search} onChange={e => updateFilters({ search: e.target.value })}
              />
              <button onClick={() => { updateFilters({ search: '' }); setMobileSearchOpen(false) }} aria-label="Clear search">×</button>
            </div>
          )}

          {view === 'opportunities' && (
            <div className="m-priority">
              <button className={filters.priority === 'all' ? 'is-active' : ''} onClick={() => updateFilters({ priority: 'all' })}>
                All<small>{board.length}</small>
              </button>
              {PRIORITIES.map(key => (
                <button
                  key={key}
                  className={filters.priority === key ? 'is-active' : ''}
                  onClick={() => updateFilters({ priority: filters.priority === key ? 'all' : key })}
                >
                  <i style={{ background: PRIORITY_COLORS[key] }} />{PRIORITY_LABELS[key]}<small>{priorityCounts[key] ?? 0}</small>
                </button>
              ))}
            </div>
          )}

          <div className="m-list-bar">
            <span><b>{visible.length}</b> {visible.length === 1 ? 'role' : 'roles'}</span>
            <button className={filtersActive ? 'has-filters' : ''} onClick={() => setMobileFiltersOpen(open => !open)}>
              Filter{filtersActive ? ' ·' : ''}
            </button>
          </div>

          {mobileFiltersOpen && (
            <section className="m-filters">
              <header>
                <b>Filter &amp; sort</b>
                <button onClick={() => setMobileFiltersOpen(false)}>Done</button>
              </header>
              <Filters
                filters={filters} sort={sort} view={view}
                onChange={updateFilters} onSort={setSort} onReset={resetFilters} showReset={filtersActive}
              />
            </section>
          )}

          {error && <p className="alert">{error}</p>}

          {loading
            ? <p className="m-empty">Loading placements…</p>
            : visible.length === 0
              ? (
                <div className="m-empty">
                  <b>Nothing here</b>
                  <span>{filtersActive ? 'Try changing your filters.' : emptyMessage}</span>
                  {filtersActive && <button onClick={resetFilters}>Reset filters</button>}
                </div>
              )
              : (
                <div className="m-list">
                  {visible.map(p => (
                    <MobilePlacementCard
                      key={p.id}
                      placement={p}
                      onOpen={() => setSelectedId(p.id)}
                      onPatch={patch => void patchPlacement(p.id, patch)}
                    />
                  ))}
                </div>
              )}
        </main>

        <nav className="m-tabs" aria-label="Main navigation">
          {VIEWS.slice(0, 2).map(item => (
            <button key={item.key} className={view === item.key ? 'is-active' : ''} onClick={() => changeView(item.key)}>
              <span aria-hidden="true">{item.icon}</span>
              <small>{item.short}</small>
              {item.key === 'applications' && stats.applied > 0 && <em>{stats.applied}</em>}
            </button>
          ))}
        </nav>
        <button
          className={`m-hidden-fab ${view === 'not-interested' ? 'is-active' : ''}`}
          onClick={() => changeView('not-interested')}
          aria-label={`Not interested (${stats.hidden})`}
        >
          <span aria-hidden="true">{'\u2212'}</span>
          {stats.hidden > 0 && <em>{stats.hidden}</em>}
        </button>

        {selected && (
          <div className="m-sheet-backdrop" onClick={() => setSelectedId(null)}>
            <section className="m-sheet" onClick={e => e.stopPropagation()}>
              <span className="m-grabber" aria-hidden="true" />
              <div className="m-sheet-scroll">
                <PlacementDetail placement={selected} onPatch={patchSelected} onClose={() => setSelectedId(null)} />
              </div>
            </section>
          </div>
        )}
      </div>
    </>
  )
}
