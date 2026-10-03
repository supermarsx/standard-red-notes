import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveDeploymentVersion,
  fetchJson,
  verifyDeploymentIdentity,
  verifyServerDeploymentIdentity,
} from "./verify-deployment-identity.mjs";
// The implementation this script has to mirror. Imported for the pin below, in
// the test only: the verifier itself stays self-contained so a host-run
// operator script never depends on a server package's source tree.
import { deriveDeploymentVersion as deriveInApiGateway } from "../server/packages/api-gateway/src/Service/Readiness/DeploymentIdentity.ts";

const revision = "0123456789abcdef0123456789abcdef01234567";
const version = "ci-123.1";
const identity = { revision, version };
const derived = "src-0123456789ab";

test("accepts exact non-null app and server deployment identity", () => {
  assert.deepEqual(
    verifyDeploymentIdentity({
      readiness: { status: "ready", deployment: identity },
      appMarker: identity,
      expectedRevision: revision,
      expectedVersion: version,
    }),
    identity,
  );
});

/**
 * The documented single-argument build is
 * `--build-arg SRN_DEPLOY_REVISION=$(git rev-parse HEAD)`, and it is what the
 * unstamped remedy text tells an operator to run. It publishes the version the
 * build derived, so verifying it with `--expected-revision` alone has to expect
 * that same derived token.
 *
 * Expecting a null version here — what this script did before — could never
 * pass: a stamped deployment publishes a revision AND a version, an unstamped
 * one publishes neither and is refused on its null revision. The revision-only
 * invocation therefore reported "does not match the expected release" against
 * every live stack, which is the opposite of what it exists to do.
 */
test("verifies the documented revision-only build against the version it derives", () => {
  const stamped = { revision, version: derived };

  assert.deepEqual(
    verifyServerDeploymentIdentity({
      readiness: { status: "ready", deployment: stamped },
      expectedRevision: revision,
    }),
    stamped,
  );
  for (const expectedVersion of [undefined, ""]) {
    assert.deepEqual(
      verifyDeploymentIdentity({
        readiness: { status: "ready", deployment: stamped },
        appMarker: stamped,
        expectedRevision: revision,
        expectedVersion,
      }),
      stamped,
      String(expectedVersion),
    );
  }
});

test("a revision-only run still refuses anything but the version that revision derives", () => {
  for (const [name, deployment, appMarker] of [
    [
      "unpublished identity",
      { revision: null, version: null },
      { revision, version: derived },
    ],
    [
      "an empty published version",
      { revision, version: "" },
      { revision, version: derived },
    ],
    [
      "a version derived from a different revision",
      { revision, version: "src-ffffffffffff" },
      { revision, version: derived },
    ],
    [
      "an explicitly stamped version this revision does not derive",
      { revision, version: "v26.8.11" },
      { revision, version: derived },
    ],
    [
      "an app marker that disagrees with the server",
      { revision, version: derived },
      { revision, version: "src-ffffffffffff" },
    ],
  ]) {
    assert.throws(
      () =>
        verifyDeploymentIdentity({
          readiness: { status: "ready", deployment },
          appMarker,
          expectedRevision: revision,
        }),
      undefined,
      name,
    );
  }
});

test("an explicit expected version is never replaced by the derived one", () => {
  assert.deepEqual(
    verifyServerDeploymentIdentity({
      readiness: { status: "ready", deployment: identity },
      expectedRevision: revision,
      expectedVersion: version,
    }),
    identity,
  );
  for (const [name, expectedVersion] of [
    ["a stamped release verified against the derived token", version],
    ["an unsafe version token", "not a version"],
  ]) {
    assert.throws(
      () =>
        verifyServerDeploymentIdentity({
          readiness: {
            status: "ready",
            deployment: { revision, version: derived },
          },
          expectedRevision: revision,
          expectedVersion,
        }),
      undefined,
      name,
    );
  }
});

test("never derives a version for a revision it would not accept", () => {
  for (const expectedRevision of [
    undefined,
    "",
    "unstamped",
    "0123456789ab",
    "0123456789ABCDEF0123456789abcdef01234567",
    `${revision}0`,
  ]) {
    assert.throws(
      () =>
        verifyServerDeploymentIdentity({
          readiness: {
            status: "ready",
            deployment: { revision, version: derived },
          },
          expectedRevision,
        }),
      /expected deployment identity is invalid/u,
      String(expectedRevision),
    );
  }
});

test("rejects null, stale, malformed, and cross-tier deployment identity", () => {
  for (const [name, readiness, appMarker] of [
    [
      "null server",
      { status: "ready", deployment: { revision: null, version: null } },
      identity,
    ],
    [
      "stale server",
      { status: "ready", deployment: { ...identity, version: "ci-122.1" } },
      identity,
    ],
    [
      "stale app",
      { status: "ready", deployment: identity },
      { ...identity, version: "ci-122.1" },
    ],
    [
      "extra app field",
      { status: "ready", deployment: identity },
      { ...identity, mutable: true },
    ],
    [
      "cross-tier mismatch",
      {
        status: "ready",
        deployment: { ...identity, revision: "f".repeat(40) },
      },
      { ...identity, revision: "e".repeat(40) },
    ],
  ]) {
    assert.throws(
      () =>
        verifyDeploymentIdentity({
          readiness,
          appMarker,
          expectedRevision: revision,
          expectedVersion: version,
        }),
      undefined,
      name,
    );
  }
});

/**
 * ONE RULE, FOUR COPIES. The build derives the version in busybox ash inside
 * the `deployment-identity` stage of three Dockerfiles, `deploy/lxc/install.sh`
 * repeats it for the LXC topology, api-gateway's
 * `Service/Readiness/DeploymentIdentity.ts` mirrors it at runtime, and this
 * script has to expect the same token. Nothing is reachable from all of those,
 * so the agreement is pinned here two ways:
 *
 *   - against the api-gateway implementation, which is what the verifier is
 *     actually checking the output of, by direct equality;
 *   - against the prefix and the character count parsed back OUT of each of the
 *     four build scripts.
 *
 * Both pins get controls, because a check that reads a file or compares two
 * functions proves nothing until it has been shown to go red: a planted
 * divergence must make the comparison disagree, and a removed anchor must
 * throw rather than pass vacuously. Every plant is asserted to occur exactly
 * once before it is swapped, and it is planted in the string that was read —
 * never on disk.
 */
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sampleRevision = "fedcba9876543210fedcba9876543210fedcba98";
const dockerfileDerivation =
  /version="([0-9A-Za-z._+-]*)\$\(printf '%s' "\$\{revision\}" \| cut -c1-([0-9]+)\)"/u;
const installerDerivation =
  /SRN_DEPLOY_VERSION="([0-9A-Za-z._+-]*)\$\(printf '%s' "\$\{DEPLOY_COMMIT\}" \| cut -c1-([0-9]+)\)"/u;
const buildScripts = [
  ["server/Dockerfile", dockerfileDerivation],
  ["Dockerfile.single", dockerfileDerivation],
  ["app/Dockerfile", dockerfileDerivation],
  ["deploy/lxc/install.sh", installerDerivation],
];

const readBuildScript = (relativePath) =>
  readFileSync(path.join(repositoryRoot, relativePath), "utf8");

function parseDerivation(source, pattern, label) {
  const found = source.match(pattern);
  if (found === null) {
    throw new Error(
      `${label}: the version derivation was not found; this check is anchored on text that no longer exists`,
    );
  }
  return { prefix: found[1], revisionCharacters: Number(found[2]) };
}

const derivationOf = ({ prefix, revisionCharacters }) =>
  `${prefix}${sampleRevision.slice(0, revisionCharacters)}`;

function plant(source, fragment, replacement) {
  assert.equal(
    source.split(fragment).length - 1,
    1,
    `${fragment} must occur exactly once to be a meaningful plant`,
  );
  return source.split(fragment).join(replacement);
}

test("derives exactly the token the api-gateway runtime publishes", () => {
  const revisions = [
    revision,
    sampleRevision,
    "0".repeat(40),
    "f".repeat(40),
    // Shares its first twelve characters with `revision`, so the derived token
    // is identical and only the revision comparison can separate the two.
    "0123456789abffffffffffffffffffffffffffff",
  ];

  for (const candidate of revisions) {
    assert.equal(
      deriveDeploymentVersion(candidate),
      deriveInApiGateway(candidate),
      candidate,
    );
  }

  // Control: the equality above has to be capable of failing. Each deliberately
  // wrong derivation must disagree with the runtime for every revision.
  for (const [name, wrong] of [
    ["a different prefix", (value) => `rev-${value.slice(0, 12)}`],
    ["a different character count", (value) => `src-${value.slice(0, 10)}`],
    ["the whole revision", (value) => `src-${value}`],
    ["no derivation at all", () => null],
  ]) {
    assert.ok(
      revisions.every(
        (candidate) => wrong(candidate) !== deriveInApiGateway(candidate),
      ),
      name,
    );
  }
});

test("derives the token every build script bakes into the marker", () => {
  for (const [relativePath, pattern] of buildScripts) {
    const parsed = parseDerivation(
      readBuildScript(relativePath),
      pattern,
      relativePath,
    );

    assert.equal(
      deriveDeploymentVersion(sampleRevision),
      derivationOf(parsed),
      relativePath,
    );
  }
});

test("fails when a build script diverges from the derivation used here", () => {
  for (const [relativePath, pattern] of buildScripts) {
    const source = readBuildScript(relativePath);
    for (const [name, fragment, replacement] of [
      ["a different character count", "cut -c1-12", "cut -c1-10"],
      ["a different prefix", '="src-$(printf', '="rev-$(printf'],
    ]) {
      const parsed = parseDerivation(
        plant(source, fragment, replacement),
        pattern,
        relativePath,
      );

      assert.notEqual(
        deriveDeploymentVersion(sampleRevision),
        derivationOf(parsed),
        `${relativePath}: ${name}`,
      );
    }
  }
});

test("fails loudly rather than vacuously when a build script anchor is gone", () => {
  for (const [relativePath, pattern] of buildScripts) {
    const source = readBuildScript(relativePath);
    for (const [fragment, replacement] of [
      ["cut -c1-12", "head -c 12"],
      ['="src-$(printf', '="src-$(command printf'],
    ]) {
      assert.throws(
        () =>
          parseDerivation(
            plant(source, fragment, replacement),
            pattern,
            relativePath,
          ),
        /the version derivation was not found/u,
        `${relativePath}: ${fragment}`,
      );
    }
  }
});

test("rejects and cancels an oversized streaming response without waiting for its stalled tail", async () => {
  let reads = 0;
  let cancellations = 0;
  let timeout;
  const response = {
    ok: true,
    text() {
      throw new Error("response.text() must never be called");
    },
    body: {
      getReader() {
        return {
          read() {
            reads += 1;
            if (reads === 1) {
              return Promise.resolve({
                done: false,
                value: new Uint8Array(8_192),
              });
            }
            if (reads === 2) {
              return Promise.resolve({
                done: false,
                value: new Uint8Array(8_193),
              });
            }
            return new Promise(() => {});
          },
          cancel() {
            cancellations += 1;
            return new Promise(() => {});
          },
          releaseLock() {},
        };
      },
    },
  };

  try {
    await assert.rejects(
      Promise.race([
        fetchJson("https://example.test/identity", async () => response),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("oversized stream rejection timed out")),
            250,
          );
        }),
      ]),
      /oversized response/,
    );
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(reads, 2);
  assert.equal(cancellations, 1);
});
