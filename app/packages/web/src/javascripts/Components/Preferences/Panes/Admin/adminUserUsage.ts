import type { AdminUserTokenUsageWindow, AdminUserUsageResponse } from '@standardnotes/snjs'

export const formatAdminTokenCount = (tokens: number): string => `${Math.max(0, tokens).toLocaleString()} tokens`

export const describeAdminTokenWindow = (window: AdminUserTokenUsageWindow): string => {
  if (window.usedTokens === null || window.unavailable) {
    return window.limitTokens > 0
      ? `Usage unavailable · ${formatAdminTokenCount(window.limitTokens)} limit`
      : 'Usage unavailable · unlimited'
  }

  const used = formatAdminTokenCount(window.usedTokens)
  return window.limitTokens > 0 ? `${used} of ${formatAdminTokenCount(window.limitTokens)}` : `${used} · unlimited`
}

export const describeAdminTokenRollOff = (window: AdminUserTokenUsageWindow): string => {
  if (window.usedTokens === null || window.unavailable) {
    return 'Next roll-off time unavailable.'
  }
  if (window.usedTokens === 0) {
    return 'No retained usage is waiting to roll off.'
  }
  if (!window.resetsAt) {
    return 'Next roll-off time unavailable.'
  }
  const rollOff = new Date(window.resetsAt)
  if (Number.isNaN(rollOff.getTime())) {
    return 'Next roll-off time unavailable.'
  }
  return `Next tokens roll off ${rollOff.toLocaleString()}.`
}

export const adminTokenUsageProgress = (window: AdminUserTokenUsageWindow): number | null => {
  if (window.usedTokens === null || window.unavailable || window.limitTokens <= 0) {
    return null
  }
  return Math.min(100, Math.max(0, (window.usedTokens / window.limitTokens) * 100))
}

export const describeAdminUsageHistory = (history: AdminUserUsageResponse['history']): string => {
  if (history.totalEvents === null) {
    return 'Retained usage history is unavailable.'
  }
  if (history.totalEvents === 0) {
    return 'No usage events are retained for this user.'
  }
  if (history.truncated) {
    return `Showing the newest ${history.events.length.toLocaleString()} of ${history.totalEvents.toLocaleString()} retained events.`
  }
  return `${history.totalEvents.toLocaleString()} usage event${history.totalEvents === 1 ? '' : 's'} retained.`
}
