#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const revisionPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
const markerPath = "/.well-known/srn-deployment.json";
const readinessPath = "/healthcheck/readiness";
const maximumResponseBytes = 16_384;

function exactIdentity(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "revision,version") {
    throw new Error(`${label} must contain exactly revision and version`);
  }
  const version =
    value.version === "" || value.version === null ? null : value.version;
  if (
    !revisionPattern.test(value.revision ?? "") ||
    (version !== null && !versionPattern.test(version))
  ) {
    throw new Error(`${label} contains null or invalid deployment metadata`);
  }
  return { revision: value.revision, version };
}

export function verifyDeploymentIdentity({
  readiness,
  appMarker,
  expectedRevision,
  expectedVersion,
}) {
  const expected = verifyServerDeploymentIdentity({
    readiness,
    expectedRevision,
    expectedVersion,
  });
  const appIdentity = exactIdentity(appMarker, "app deployment marker");
  if (
    appIdentity.revision !== expected.revision ||
    appIdentity.version !== expected.version
  ) {
    throw new Error(
      "app deployment marker does not match the expected release",
    );
  }
  return expected;
}

export function verifyServerDeploymentIdentity({
  readiness,
  expectedRevision,
  expectedVersion,
}) {
  const normalizedExpectedVersion =
    expectedVersion === "" || expectedVersion === undefined
      ? null
      : expectedVersion;
  if (
    !revisionPattern.test(expectedRevision ?? "") ||
    (normalizedExpectedVersion !== null &&
      !versionPattern.test(normalizedExpectedVersion))
  ) {
    throw new Error("expected deployment identity is invalid");
  }
  if (!readiness || readiness.status !== "ready") {
    throw new Error("aggregate readiness is not ready");
  }

  const serverIdentity = exactIdentity(
    readiness.deployment,
    "server readiness deployment identity",
  );
  const expected = {
    revision: expectedRevision,
    version: normalizedExpectedVersion,
  };
  if (
    serverIdentity.revision !== expected.revision ||
    serverIdentity.version !== expected.version
  ) {
    throw new Error(
      "server readiness deployment identity does not match the expected release",
    );
  }
  return expected;
}

async function readBoundedResponseBody(response, url) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error(`${url} did not return a readable response body`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error(`${url} returned an invalid response stream`);
      }
      byteLength += value.byteLength;
      if (byteLength > maximumResponseBytes) {
        try {
          void Promise.resolve(
            reader.cancel("deployment identity response exceeded 16 KiB"),
          ).catch(() => {});
        } catch {
          // Cancellation is best effort; rejection must remain bounded even if
          // a hostile stream throws or never settles its cancellation promise.
        }
        throw new Error(`${url} returned an oversized response`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

export async function fetchJson(url, fetchImplementation = fetch) {
  const response = await fetchImplementation(url, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  const text = await readBoundedResponseBody(response, url);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (
      ![
        "--app-url",
        "--readiness-url",
        "--expected-revision",
        "--expected-version",
      ].includes(flag)
    ) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === "--app-url") result.appUrl = value;
    if (flag === "--readiness-url") result.readinessUrl = value;
    if (flag === "--expected-revision") result.expectedRevision = value;
    if (flag === "--expected-version") result.expectedVersion = value;
  }
  if (Boolean(result.appUrl) === Boolean(result.readinessUrl)) {
    throw new Error("exactly one of --app-url or --readiness-url is required");
  }
  const target = new URL(result.appUrl ?? result.readinessUrl);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password
  ) {
    throw new Error("deployment URL must be HTTP(S) without credentials");
  }
  return result.appUrl
    ? { ...result, appUrl: target }
    : { ...result, readinessUrl: target };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const readiness = await fetchJson(
      args.readinessUrl ?? new URL(readinessPath, args.appUrl),
    );
    const identity = args.readinessUrl
      ? verifyServerDeploymentIdentity({ ...args, readiness })
      : verifyDeploymentIdentity({
          ...args,
          readiness,
          appMarker: await fetchJson(new URL(markerPath, args.appUrl)),
        });
    console.log(
      `Deployment identity verified: ${identity.revision} (${identity.version ?? "unversioned"})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
