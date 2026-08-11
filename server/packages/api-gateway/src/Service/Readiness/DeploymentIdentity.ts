import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'fs'

export const DEFAULT_DEPLOYMENT_MARKER_PATH = '/usr/share/srn-deployment/deployment.json'
const MAX_DEPLOYMENT_MARKER_BYTES = 512
const fullLowercaseGitRevision = /^[0-9a-f]{40}$/
const safeDeploymentVersion = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/

export type DeploymentIdentity = {
  revision: string | null
  version: string | null
}

export function normalizeDeploymentRevision(value: string | undefined): string | null {
  return value !== undefined && fullLowercaseGitRevision.test(value) ? value : null
}

export function normalizeDeploymentVersion(value: string | undefined): string | null {
  return value !== undefined && safeDeploymentVersion.test(value) ? value : null
}

export function readDeploymentMarker(markerPath: string, trustedUid = 0): DeploymentIdentity | undefined {
  let descriptor: number | undefined
  try {
    const pathStats = lstatSync(markerPath)
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      pathStats.uid !== trustedUid ||
      (pathStats.mode & 0o777) !== 0o444 ||
      pathStats.size === 0 ||
      pathStats.size > MAX_DEPLOYMENT_MARKER_BYTES
    ) {
      return undefined
    }

    descriptor = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const openedStats = fstatSync(descriptor)
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.uid !== trustedUid ||
      (openedStats.mode & 0o777) !== 0o444 ||
      openedStats.size !== pathStats.size
    ) {
      return undefined
    }

    const buffer = Buffer.alloc(openedStats.size)
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
    if (bytesRead !== buffer.length) {
      return undefined
    }

    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    const marker = parsed as Record<string, unknown>
    if (
      Object.keys(marker).sort().join(',') !== 'revision,version' ||
      typeof marker.revision !== 'string' ||
      typeof marker.version !== 'string'
    ) {
      return undefined
    }

    const revision = marker.revision === '' ? null : normalizeDeploymentRevision(marker.revision)
    const version = marker.version === '' ? null : normalizeDeploymentVersion(marker.version)
    if ((marker.revision !== '' && revision === null) || (marker.version !== '' && version === null)) {
      return undefined
    }

    return { revision, version }
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
}

export function verifiedDeploymentIdentity(
  expectedRevision: string | undefined,
  expectedVersion: string | undefined,
  marker: DeploymentIdentity | undefined,
): DeploymentIdentity {
  const revision = normalizeDeploymentRevision(expectedRevision)
  const version =
    expectedVersion === undefined || expectedVersion === '' ? null : normalizeDeploymentVersion(expectedVersion)

  // Empty is the compatibility mode for local source starts. Invalid values,
  // missing markers, and stale-image mismatches never become public identity.
  if (
    revision === null ||
    (expectedVersion !== undefined && expectedVersion !== '' && version === null) ||
    marker === undefined ||
    marker.revision !== revision ||
    marker.version !== version
  ) {
    return { revision: null, version: null }
  }

  return { revision, version }
}
