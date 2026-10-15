import { readBoundedServerSettingsFile } from '../Logging/RuntimeLogLevel'

export const REVISION_POLICY_DEFAULTS = {
  retentionDays: 900,
  maxCountPerItem: 200,
  maxCountPerUser: 0,
  maxBytesPerUser: 0,
  maxCountTotal: 0,
  maxBytesTotal: 0,
  debounceSeconds: 30,
  checkpointSeconds: 300,
} as const

export type RevisionPolicyLimits = { -readonly [K in keyof typeof REVISION_POLICY_DEFAULTS]: number }
export type RevisionUserLimits = {
  retentionDays?: number
  maxCountPerItem?: number
  maxCount?: number
  maxBytes?: number
}
export type RevisionPolicySettings = Partial<RevisionPolicyLimits> & { users?: Record<string, RevisionUserLimits> }
export type RevisionPolicyPatch = {
  [K in keyof RevisionPolicyLimits]?: number | null
} & { users?: Record<string, { [K in keyof RevisionUserLimits]?: number | null } | null> }

export const REVISION_POLICY_ENV: Record<keyof RevisionPolicyLimits, string> = {
  retentionDays: 'REVISIONS_RETENTION_DAYS',
  maxCountPerItem: 'REVISIONS_MAX_COUNT_PER_ITEM',
  maxCountPerUser: 'REVISIONS_MAX_COUNT_PER_USER',
  maxBytesPerUser: 'REVISIONS_MAX_BYTES_PER_USER',
  maxCountTotal: 'REVISIONS_MAX_COUNT_TOTAL',
  maxBytesTotal: 'REVISIONS_MAX_BYTES_TOTAL',
  debounceSeconds: 'REVISIONS_DEBOUNCE_SECONDS',
  checkpointSeconds: 'REVISIONS_CHECKPOINT_SECONDS',
}

export function revisionPolicyInteger(key: string, value: unknown): value is number {
  const maximum = key === 'retentionDays' ? 365_000 : key.endsWith('Seconds') ? 86_400 : Number.MAX_SAFE_INTEGER
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const userKeys = ['retentionDays', 'maxCountPerItem', 'maxCount', 'maxBytes']
const userId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validRevisionPolicy(value: unknown, patch = false): boolean {
  if (!object(value)) {
    return false
  }
  return Object.entries(value).every(([key, entry]) => {
    if (key !== 'users') {
      return (
        Object.hasOwn(REVISION_POLICY_DEFAULTS, key) && ((patch && entry === null) || revisionPolicyInteger(key, entry))
      )
    }
    return (
      object(entry) &&
      Object.keys(entry).length <= 10_000 &&
      Object.entries(entry).every(
        ([id, limits]) =>
          userId.test(id) &&
          ((patch && limits === null) ||
            (object(limits) &&
              Object.entries(limits).every(
                ([field, limit]) =>
                  userKeys.includes(field) && ((patch && limit === null) || revisionPolicyInteger(field, limit)),
              ))),
      )
    )
  })
}

export function revisionPolicyBaseline(read: (name: string) => string | undefined): RevisionPolicyLimits {
  const baseline = { ...REVISION_POLICY_DEFAULTS } as RevisionPolicyLimits
  for (const key of Object.keys(REVISION_POLICY_DEFAULTS) as Array<keyof RevisionPolicyLimits>) {
    const raw = read(REVISION_POLICY_ENV[key])
    if (raw === undefined || raw.trim() === '') {
      continue
    }
    const value = Number(raw)
    if (!revisionPolicyInteger(key, value)) {
      throw new Error(`Invalid ${REVISION_POLICY_ENV[key]}`)
    }
    baseline[key] = value
  }
  return baseline
}

/** Zero means unlimited; an account override can tighten, but never bypass, a server cap. */
const tighter = (server: number, user: number | undefined): number =>
  user === undefined || user === 0 ? server : server === 0 ? user : Math.min(server, user)

export function effectiveRevisionPolicy(
  settings: RevisionPolicySettings,
  baseline: RevisionPolicyLimits,
  userUuid?: string,
): RevisionPolicyLimits {
  const result = { ...baseline }
  for (const key of Object.keys(baseline) as Array<keyof RevisionPolicyLimits>) {
    if (settings[key] !== undefined) {
      result[key] = settings[key]!
    }
  }
  const user = userUuid ? settings.users?.[userUuid] : undefined
  return {
    ...result,
    retentionDays: tighter(result.retentionDays, user?.retentionDays),
    maxCountPerItem: tighter(result.maxCountPerItem, user?.maxCountPerItem),
    maxCountPerUser: tighter(result.maxCountPerUser, user?.maxCount),
    maxBytesPerUser: tighter(result.maxBytesPerUser, user?.maxBytes),
  }
}

export class RevisionPolicyResolver {
  constructor(
    private readonly settingsPath: string | undefined,
    readonly baseline: RevisionPolicyLimits = { ...REVISION_POLICY_DEFAULTS },
  ) {}

  async settings(): Promise<RevisionPolicySettings> {
    if (!this.settingsPath) {
      return {}
    }
    let text: string
    try {
      text = await readBoundedServerSettingsFile(this.settingsPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}
      }
      throw error
    }
    const root = JSON.parse(text) as unknown
    if (!object(root) || (root.revisions !== undefined && !validRevisionPolicy(root.revisions))) {
      throw new Error('Invalid revision policy settings')
    }
    return (root.revisions ?? {}) as RevisionPolicySettings
  }

  async resolve(userUuid?: string): Promise<RevisionPolicyLimits> {
    return effectiveRevisionPolicy(await this.settings(), this.baseline, userUuid)
  }
}
