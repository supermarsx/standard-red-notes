import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchJson,
  verifyDeploymentIdentity,
} from "./verify-deployment-identity.mjs";

const revision = "0123456789abcdef0123456789abcdef01234567";
const version = "ci-123.1";
const identity = { revision, version };

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

test("normalizes an optional empty app version to the server's null version", () => {
  assert.deepEqual(
    verifyDeploymentIdentity({
      readiness: { status: "ready", deployment: { revision, version: null } },
      appMarker: { revision, version: "" },
      expectedRevision: revision,
    }),
    { revision, version: null },
  );
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
