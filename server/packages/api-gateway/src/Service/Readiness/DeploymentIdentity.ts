import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'fs'

export const DEFAULT_DEPLOYMENT_MARKER_PATH = '/usr/share/srn-deployment/deployment.json'
const MAX_DEPLOYMENT_MARKER_BYTES = 512
const fullLowercaseGitRevision = /^[0-9a-f]{40}$/
const safeDeploymentVersion = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/

/**
 * The sentinel a build with no revision argument records, instead of an empty
 * string that would be indistinguishable from a serialization bug. Mirrors the
 * `revision='unstamped'` default in the `deployment-identity` stage of all three
 * Dockerfiles.
 */
export const UNSTAMPED_DEPLOYMENT_SENTINEL = 'unstamped'

/**
 * How the build derives a version when only a revision was supplied. The
 * `deployment-identity` stage of `server/Dockerfile`, `Dockerfile.single` and
 * `app/Dockerfile` (byte-identical stages) runs:
 *
 *   version="src-$(printf '%s' "${revision}" | cut -c1-12)"
 *
 * …and `deploy/lxc/install.sh` repeats it for the LXC topology.
 *
 * These two constants and `deriveDeploymentVersion` below are the TypeScript
 * half of that one rule. There is no single definition reachable from both an
 * Alpine `RUN` line and this module — the three build contexts differ and
 * `.dockerignore` excludes the scripts directory from the server image — so the
 * agreement is pinned by a test that parses the prefix, the character count and
 * the sentinel back out of each Dockerfile and compares them to these values
 * (see DeploymentIdentity.spec.ts).
 */
const DERIVED_DEPLOYMENT_VERSION_PREFIX = 'src-'
const DERIVED_DEPLOYMENT_VERSION_REVISION_CHARACTERS = 12

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

/**
 * The runtime half of the build's version derivation, for the documented
 * single-argument invocation `--build-arg SRN_DEPLOY_REVISION=$(git rev-parse HEAD)`.
 *
 * Without this, that invocation could never publish identity: the build bakes
 * `src-<first 12 of revision>` into the marker while the runtime read an absent
 * `SRN_DEPLOY_VERSION` as `null`, the two disagreed, and the whole identity was
 * discarded as if the image were unstamped — which is also what the remedy text
 * for an unstamped build tells the operator to fix by rebuilding with exactly
 * that one argument. Measured live on compose: revision-only published
 * `{ revision: null, version: null }`.
 *
 * Returns `null` when the derived token would not survive the same validation
 * the build applies (`[ "${#version}" -le 128 ]` plus the alphanumeric-first,
 * `[0-9A-Za-z._+-]` charset); the build exits 64 there, and refusing to publish
 * is this side's fail-closed equivalent.
 */
export function deriveDeploymentVersion(revision: string): string | null {
  const derived =
    revision === UNSTAMPED_DEPLOYMENT_SENTINEL
      ? UNSTAMPED_DEPLOYMENT_SENTINEL
      : `${DERIVED_DEPLOYMENT_VERSION_PREFIX}${revision.slice(0, DERIVED_DEPLOYMENT_VERSION_REVISION_CHARACTERS)}`

  return normalizeDeploymentVersion(derived)
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
  // An absent SRN_DEPLOY_VERSION means "whatever the build derived", not "no
  // version": the build derives one from the revision whenever it is not given
  // one, so the runtime has to derive the same token or the comparison below
  // rejects a perfectly good image. Compose defaults this variable to empty, so
  // this is the path nearly every self-hosted deployment takes.
  const version =
    expectedVersion === undefined || expectedVersion === ''
      ? revision === null
        ? null
        : deriveDeploymentVersion(revision)
      : normalizeDeploymentVersion(expectedVersion)

  // Empty is the compatibility mode for local source starts. Invalid values,
  // missing markers, and stale-image mismatches never become public identity.
  //
  // The `marker.revision !== revision` comparison is what rejects a marker baked
  // into a DIFFERENT image, and it is independent of the version: two revisions
  // sharing their first 12 characters derive the same version token, and that
  // case is still refused on the revision alone.
  if (
    revision === null ||
    version === null ||
    marker === undefined ||
    marker.revision !== revision ||
    marker.version !== version
  ) {
    return { revision: null, version: null }
  }

  return { revision, version }
}
