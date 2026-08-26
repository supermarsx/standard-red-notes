/**
 * Wording for what happened when a second launch hit the single-instance lock.
 *
 * Kept out of application.ts (and free of any electron import) so it can be
 * tested directly. The lock itself is untouched: a second process always loses
 * and the running window is focused. What this adds is the ability to say WHICH
 * BUILD lost, because "the window focused" looks identical whether you launched
 * the same binary twice or launched a freshly built one over a stale instance —
 * and in the second case you are about to test the old code believing it is new.
 */
export type SecondInstancePayload = {
  version: string
}

export function describeSecondInstance(runningVersion: string, additionalData: unknown): string {
  const payload = (additionalData ?? {}) as Record<string, unknown>
  const incomingVersion = typeof payload.version === 'string' ? payload.version : undefined

  if (!incomingVersion) {
    return (
      'A second launch was blocked by the single-instance lock; focusing the running instance ' +
      `(version ${runningVersion}). The second process did not report its version.`
    )
  }

  if (incomingVersion === runningVersion) {
    return `A second launch of version ${incomingVersion} was blocked by the single-instance lock; focusing the running instance.`
  }

  return (
    `A second launch of version ${incomingVersion} was blocked by the single-instance lock, ` +
    `but the running instance is version ${runningVersion}. THE NEWLY LAUNCHED BUILD IS NOT RUNNING — ` +
    'the window being focused belongs to the older instance. Quit it fully before launching the new build.'
  )
}
