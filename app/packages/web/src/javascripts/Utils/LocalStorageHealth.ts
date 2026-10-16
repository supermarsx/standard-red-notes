import { addToast, dismissToast, ToastType } from '@standardnotes/toast'
import type { WebApplication } from '@/Application/WebApplication'
import { HIGH_USAGE_THRESHOLD, type StorageEstimateResult } from './StorageQuotaTypes'

export type LocalStorageHealthCode = 'quota-exceeded' | 'database-unavailable' | 'write-ok'
type StorageSource = 'items' | 'outbox'
const failures = new Map<StorageSource, Exclude<LocalStorageHealthCode, 'write-ok'>>()
let nearQuota = false
let shown: string | undefined
let toastId: string | undefined

const messages = {
  'quota-exceeded':
    'Local storage could not save data because the browser quota was exceeded or disk space is low. Free space on this computer, then retry saving. Do not clear this site’s data: it may contain unsynced notes.',
  'database-unavailable':
    'The local sync database is unavailable on this device. Check free disk space and browser storage permissions, then retry. Do not clear this site’s data: it may contain unsynced notes.',
  'near-quota':
    'This site is nearing its browser storage quota. Free disk space before local saves fail. This estimate measures the site’s quota, not the computer’s remaining disk space. Do not clear site data containing unsynced notes.',
}

function renderWarning(): void {
  const failure = [...failures.values()].includes('quota-exceeded')
    ? 'quota-exceeded'
    : failures.size
      ? 'database-unavailable'
      : undefined
  const code = failure ?? (nearQuota ? 'near-quota' : undefined)
  if (shown === code) {
    return
  }
  if (toastId) {
    dismissToast(toastId)
    toastId = undefined
  }
  if (!code) {
    shown = undefined
    return
  }
  toastId = addToast({
    type: ToastType.Error,
    message: messages[code],
    autoClose: false,
    actions: [
      {
        label: 'Storage settings',
        handler: () => {
          const application = window.mainApplicationGroup?.primaryApplication as WebApplication | undefined
          application?.openPreferences('storage')
        },
      },
    ],
  })
  shown = code
}

/** Closed codes only: worker errors must never carry notes, tokens or raw messages. */
export function reportLocalStorageHealth(code: LocalStorageHealthCode, source: StorageSource = 'outbox'): void {
  if (!['quota-exceeded', 'database-unavailable', 'write-ok'].includes(code)) {
    return
  }
  if (code === 'write-ok') {
    failures.delete(source)
  } else if (code === 'quota-exceeded' || failures.get(source) !== 'quota-exceeded') {
    failures.set(source, code)
  }
  try {
    renderWarning()
  } catch {
    /* Warnings never change storage outcomes. */
  }
}

/** Advisory origin-quota pressure is not a measurement of OS disk capacity. */
export function reportStorageEstimate(estimate: StorageEstimateResult | undefined): void {
  if (!estimate || !Number.isFinite(estimate.usedFraction) || !Number.isFinite(estimate.quota) || estimate.quota <= 0) {
    return
  }
  nearQuota = estimate.usedFraction >= HIGH_USAGE_THRESHOLD
  try {
    renderWarning()
  } catch {
    /* Advisory UI must not break launch. */
  }
}

/** Reuse the existing estimate API without repeated persistence prompts or tight polls. */
export function watchStoragePressure(
  estimate: () => Promise<StorageEstimateResult | undefined>,
  report: (estimate: StorageEstimateResult | undefined) => void = reportStorageEstimate,
): () => void {
  let stopped = false
  let checking = false
  // Launch already estimates storage; subsequent wake events are rate-limited.
  let lastProbe = Date.now()
  const check = async () => {
    if (
      stopped ||
      checking ||
      document.visibilityState === 'hidden' ||
      navigator.onLine === false ||
      Date.now() - lastProbe < 60_000
    ) {
      return
    }
    checking = true
    lastProbe = Date.now()
    try {
      const result = await estimate()
      if (!stopped) {
        report(result)
      }
    } catch {
      // A missing estimate is not evidence of a full or healthy disk.
    } finally {
      checking = false
    }
  }
  const wake = () => void check()
  const timer = setInterval(wake, 5 * 60_000)
  window.addEventListener('focus', wake)
  window.addEventListener('online', wake)
  document.addEventListener('visibilitychange', wake)
  return () => {
    stopped = true
    clearInterval(timer)
    window.removeEventListener('focus', wake)
    window.removeEventListener('online', wake)
    document.removeEventListener('visibilitychange', wake)
  }
}
