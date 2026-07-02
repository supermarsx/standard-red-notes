/**
 * Standard Red Notes: pure UI helpers for the Admin Users tab's filter bar
 * (active-filter summary chips). Lives in its own file — adminHelpers.ts is
 * owned by a concurrent change and must stay untouched.
 */

import { AdminUsersFilterState } from './adminHelpers'

export type AdminUsersActiveFilterChip = {
  /** The filter-state key the chip describes (also used as the React key). */
  key: keyof AdminUsersFilterState
  /** Human-readable summary, e.g. 'Created after 2026-01-01'. */
  label: string
}

const SUBSCRIPTION_LABELS: Record<Exclude<AdminUsersFilterState['subscription'], 'any'>, string> = {
  active: 'Active subscription',
  inactive: 'Inactive subscription',
  none: 'No subscription',
}

/**
 * Describe every non-default filter as a short human-readable chip, in the
 * same order the controls appear in the bar. Empty array = nothing filtering
 * (mirrors adminUsersFiltersAreEmpty).
 */
export const describeAdminUsersActiveFilters = (filters: AdminUsersFilterState): AdminUsersActiveFilterChip[] => {
  const chips: AdminUsersActiveFilterChip[] = []

  const email = filters.email.trim()
  if (email !== '') {
    chips.push({ key: 'email', label: `Email contains "${email}"` })
  }
  if (filters.subscription !== 'any') {
    chips.push({ key: 'subscription', label: SUBSCRIPTION_LABELS[filters.subscription] })
  }
  if (filters.banned !== 'any') {
    chips.push({ key: 'banned', label: filters.banned === 'yes' ? 'Banned only' : 'Not banned' })
  }
  if (filters.role !== '') {
    chips.push({ key: 'role', label: `Role: ${filters.role}` })
  }
  if (filters.createdAfter !== '') {
    chips.push({ key: 'createdAfter', label: `Created after ${filters.createdAfter}` })
  }
  if (filters.createdBefore !== '') {
    chips.push({ key: 'createdBefore', label: `Created before ${filters.createdBefore}` })
  }

  return chips
}
