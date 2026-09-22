import { APPLICATION_STATUSES, OPPORTUNITY_TYPES, APPLICATION_STAGES, PRIORITIES } from '../lib/supabase'
import { COUNTRY_GROUPS, SECTOR_GROUPS, SORT_OPTIONS, type Filters, type SortOption, type View } from '../lib/filtering'
import { PRIORITY_LABELS } from '../lib/utils'

interface Props {
  filters: Filters
  sort: SortOption
  view: View
  onChange: (patch: Partial<Filters>) => void
  onSort: (sort: SortOption) => void
  onReset: () => void
  showReset: boolean
}

/**
 * One filter definition drives both the desktop control row and the mobile
 * filter sheet, so the two can never drift apart.
 */
export default function Filters({ filters, sort, view, onChange, onSort, onReset, showReset }: Props) {
  // Priority and availability describe the VACANCY. In the applications view
  // they are not just unhelpful, they are destructive: every role that closed
  // after the user applied falls to "Closed"/"Low", so leaving either control
  // reachable there is a way to empty the tab of real applications by accident.
  const showVacancyFilters = view !== 'applications'

  // Explore only holds roles that can still be applied to, so "Closed" there
  // is a filter that always returns nothing. Saved and Not interested keep it:
  // a closed role stays in those tabs and filtering to it is useful.
  const statuses = view === 'opportunities'
    ? APPLICATION_STATUSES.filter(status => status !== 'Closed')
    : APPLICATION_STATUSES

  return (
    <>
      {showVacancyFilters && (
        <label className="field-select">
          <span>Priority</span>
          <select value={filters.priority} onChange={e => onChange({ priority: e.target.value as Filters['priority'] })}>
            <option value="all">All priorities</option>
            {PRIORITIES.map(key => <option key={key} value={key}>{PRIORITY_LABELS[key]}</option>)}
          </select>
        </label>
      )}

      {showVacancyFilters && (
        <label className="field-select">
          <span>Availability</span>
          <select value={filters.status} onChange={e => onChange({ status: e.target.value as Filters['status'] })}>
            <option value="all">All statuses</option>
            {statuses.map(status => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
      )}

      <label className="field-select">
        <span>Type</span>
        <select value={filters.opportunityType} onChange={e => onChange({ opportunityType: e.target.value as Filters['opportunityType'] })}>
          <option value="all">All types</option>
          {OPPORTUNITY_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
        </select>
      </label>

      <label className="field-select">
        <span>Sector</span>
        <select value={filters.sector} onChange={e => onChange({ sector: e.target.value as Filters['sector'] })}>
          <option value="all">All sectors</option>
          {SECTOR_GROUPS.map(sector => <option key={sector} value={sector}>{sector}</option>)}
        </select>
      </label>

      <label className="field-select">
        <span>Region</span>
        <select value={filters.country} onChange={e => onChange({ country: e.target.value as Filters['country'] })}>
          <option value="all">All regions</option>
          {COUNTRY_GROUPS.map(country => <option key={country} value={country}>{country}</option>)}
        </select>
      </label>

      {view === 'applications' && (
        <label className="field-select">
          <span>Stage</span>
          <select value={filters.stage} onChange={e => onChange({ stage: e.target.value as Filters['stage'] })}>
            <option value="all">All stages</option>
            {APPLICATION_STAGES.map(stage => <option key={stage} value={stage}>{stage}</option>)}
          </select>
        </label>
      )}

      <label className="field-select">
        <span>Sort</span>
        <select value={sort} onChange={e => onSort(e.target.value as SortOption)}>
          {Object.entries(SORT_OPTIONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>

      {showReset && <button className="btn btn-ghost reset-filters" onClick={onReset}>Reset</button>}
    </>
  )
}
