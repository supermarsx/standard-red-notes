#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const SERVER_ROOT = join(REPOSITORY_ROOT, "server");
const REDIS_IMAGE = "redis:8.8.0-alpine";
const COMPOSE_SERVER_WORKDIR = "/opt/server/packages/api-gateway";
const DEFAULT_REDIS_PORT = 6379;
const STARTUP_TIMEOUT_MS = 30_000;

const argumentsList = process.argv.slice(2);
const workerMode = argumentsList.includes("--worker");
const composeMode = argumentsList.includes("--compose");
const requireDocker = argumentsList.includes("--require-docker") || composeMode;

try {
  if (workerMode) {
    await runWorker(requiredArgument("--redis-url"));
  } else if (composeMode) {
    await runAgainstCompose();
  } else {
    await runAgainstIsolatedRedis();
  }
} catch (error) {
  console.error(
    `Email Redis integration failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

async function runAgainstIsolatedRedis() {
  if (!dockerIsAvailable()) {
    if (requireDocker) {
      throw new Error(
        "Docker is required, but the Docker daemon is unavailable.",
      );
    }
    console.log(
      "SKIP email Redis integration: Docker is unavailable (use --require-docker in required CI).",
    );
    return;
  }

  buildQueuePackages();

  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `srn-email-redis-e2e-${suffix}`;
  const start = run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    `127.0.0.1::${DEFAULT_REDIS_PORT}`,
    REDIS_IMAGE,
    "redis-server",
    "--appendonly",
    "yes",
    "--appendfsync",
    "everysec",
    "--save",
    "",
    "--maxmemory",
    "128mb",
    "--maxmemory-policy",
    "noeviction",
  ]);
  const containerId = start.stdout.trim();
  if (!/^[a-f0-9]{12,64}$/.test(containerId)) {
    throw new Error("Docker returned an invalid Redis container id.");
  }

  try {
    await waitForRedisContainer(containerName);
    const portOutput = run("docker", [
      "port",
      containerName,
      `${DEFAULT_REDIS_PORT}/tcp`,
    ]).stdout;
    const portMatch = portOutput.match(/127\.0\.0\.1:(\d+)\s*$/m);
    if (!portMatch) {
      throw new Error("Could not resolve the isolated Redis host port.");
    }
    runServerNodeWorker(`redis://127.0.0.1:${portMatch[1]}`);
  } finally {
    stopOwnedContainer(containerName, containerId);
  }
}

async function runAgainstCompose() {
  if (!dockerIsAvailable()) {
    throw new Error(
      "Docker is required, but the Docker daemon is unavailable.",
    );
  }

  for (const service of ["server", "cache"]) {
    const result = run(
      "docker",
      ["compose", "ps", "--status", "running", "--quiet", service],
      {
        allowFailure: true,
      },
    );
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error(
        `The Compose ${service} service must be running before this test.`,
      );
    }
  }

  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerScript = `/var/lib/server/logs/.srn-email-redis-e2e-${suffix}.mjs`;
  run("docker", ["compose", "cp", SCRIPT_PATH, `server:${containerScript}`]);
  let workerFailure;
  try {
    const worker = run(
      "docker",
      [
        "compose",
        "exec",
        "--no-tty",
        "--workdir",
        COMPOSE_SERVER_WORKDIR,
        "server",
        "yarn",
        "node",
        containerScript,
        "--worker",
        "--redis-url",
        "redis://cache:6379",
      ],
      { allowFailure: true, stdio: "inherit" },
    );
    if (worker.status !== 0) {
      workerFailure = new Error(
        `The Compose email Redis worker exited with status ${worker.status}.`,
      );
    }
  } finally {
    const cleanup = run(
      "docker",
      ["compose", "exec", "--no-tty", "server", "rm", "-f", containerScript],
      { allowFailure: true },
    );
    if (cleanup.status !== 0) {
      throw new Error(
        "Could not remove the exact temporary email Redis test script from the server container.",
      );
    }
  }
  if (workerFailure) {
    throw workerFailure;
  }
}

function buildQueuePackages() {
  if (!existsSync(join(SERVER_ROOT, ".pnp.cjs"))) {
    throw new Error(
      "Server dependencies are not installed; run `corepack yarn --cwd server install --immutable`.",
    );
  }
  runCorepackYarn(
    ["--cwd", SERVER_ROOT, "workspace", "@standardnotes/domain-core", "build"],
    { stdio: "inherit" },
  );
  runCorepackYarn(
    ["--cwd", SERVER_ROOT, "workspace", "@standardnotes/api-gateway", "build"],
    { stdio: "inherit" },
  );
}

function runServerNodeWorker(redisUrl) {
  runCorepackYarn(
    [
      "--cwd",
      SERVER_ROOT,
      "workspace",
      "@standardnotes/api-gateway",
      "node",
      SCRIPT_PATH,
      "--worker",
      "--redis-url",
      redisUrl,
    ],
    { stdio: "inherit" },
  );
}

async function runWorker(redisUrl) {
  const requireFromApiGateway = createRequire(
    pathToFileURL(join(process.cwd(), "package.json")),
  );
  const RedisModule = requireFromApiGateway("ioredis");
  const Redis = RedisModule.default ?? RedisModule;
  const {
    emailQueueCompatibleKeyPrefix,
    emailQueueWorkerReadinessValue,
    RedisEncryptedEmailQueueProducer,
    emailQueueRedisKeys,
    emailQueueWorkerReadinessKey,
  } = requireFromApiGateway("@standardnotes/domain-core");
  const { RedisEmailDeliveryQueue } = requireFromApiGateway(
    "./dist/src/Service/EmailDelivery/RedisEmailDeliveryQueue.js",
  );

  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const baseKeyPrefix = `srn:email:{delivery-e2e-${suffix}}`;
  const deliveryId = "email-redis-e2e-delivery-v1";
  const preCancelledDeliveryId = "email-redis-e2e-cancelled-before-enqueue-v1";
  const cancelledPendingDeliveryId = "email-redis-e2e-cancelled-pending-v1";
  const stableSecret =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const queueLimits = {
    retentionMs: 30 * 24 * 60 * 60 * 1_000,
    maxAttempts: 5,
    maxJobBytes: 1024 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
  };
  const keyPrefix = emailQueueCompatibleKeyPrefix(
    stableSecret,
    baseKeyPrefix,
    queueLimits,
  );
  const fixedNow = 1_800_000_000_000;
  let consumerNow = fixedNow;
  const message = {
    to: "redis-queue-recipient-7dd426ec@example.invalid",
    subject: "redis-queue-subject-ecc11eea",
    text: "redis-queue-body-plaintext-6e71896af13d",
    html: "<p>redis-queue-html-plaintext-d79de9e2140c</p>",
  };
  const plaintextMarkers = [
    message.to,
    message.subject,
    message.text,
    message.html,
  ];
  const keys = emailQueueRedisKeys(keyPrefix);
  const readinessKey = emailQueueWorkerReadinessKey(keyPrefix);
  const redis = new Redis(redisUrl, {
    connectTimeout: 10_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
  });

  try {
    await redis.connect();
    await redis.ping();
    assertRedisAofConfiguration(
      await redis.call("CONFIG", "GET", "appendonly"),
    );

    const producer = new RedisEncryptedEmailQueueProducer(redis, stableSecret, {
      keyPrefix: baseKeyPrefix,
      clock: () => fixedNow,
      ...queueLimits,
    });
    const consumer = new RedisEmailDeliveryQueue(redis, {
      keyPrefix: baseKeyPrefix,
      encryptionKey: stableSecret,
      clock: () => consumerNow,
      randomId: () => "email-redis-e2e-claim-token",
      leaseMs: 30_000,
      ...queueLimits,
    });

    await redis.set(readinessKey, "V1", "PX", 60_000);
    assert.equal(
      await producer.isReady(),
      false,
      "readiness must reject values other than exact v1",
    );
    const readinessValue = emailQueueWorkerReadinessValue(
      stableSecret,
      queueLimits,
    );
    await redis.set(readinessKey, readinessValue, "PX", 60_000);
    assert.equal(await redis.get(readinessKey), readinessValue);
    assert.equal(await producer.isReady(), true);

    assert.equal(
      await producer.getDeliveryStatus(preCancelledDeliveryId),
      "missing",
    );
    assert.equal(
      await producer.cancelDelivery(preCancelledDeliveryId),
      "cancelled",
      "cancelling before enqueue must create a durable replay fence",
    );
    const cancellationRecord = "d:*";
    const preCancelledFenceBytes =
      Buffer.byteLength(preCancelledDeliveryId) +
      Buffer.byteLength(cancellationRecord) +
      128;
    assert.equal(
      await redis.hget(keys.idempotency, preCancelledDeliveryId),
      cancellationRecord,
    );
    assert.equal(
      Number(
        await redis.zscore(keys.idempotencyExpiry, preCancelledDeliveryId),
      ),
      fixedNow + queueLimits.retentionMs,
    );
    assert.equal(Number(await redis.get(keys.bytes)), preCancelledFenceBytes);
    assert.equal(
      await producer.cancelDelivery(preCancelledDeliveryId),
      "cancelled",
      "repeated cancellation must be idempotent",
    );
    assert.equal(Number(await redis.get(keys.bytes)), preCancelledFenceBytes);
    await assert.rejects(
      producer.enqueue(
        { ...message, subject: "cancelled-replay-subject-9394cd1b" },
        "account",
        preCancelledDeliveryId,
      ),
      /cancelled or superseded and cannot be replayed/,
    );
    assert.equal(Number(await redis.get(keys.bytes)), preCancelledFenceBytes);

    await producer.enqueue(message, "account", cancelledPendingDeliveryId);
    const pendingCancellationRecord = await redis.hget(
      keys.idempotency,
      cancelledPendingDeliveryId,
    );
    assert.match(pendingCancellationRecord ?? "", /^a:[a-f0-9]{64}$/);
    const pendingCancellationBytes =
      Number(await redis.hstrlen(keys.jobs, cancelledPendingDeliveryId)) +
      Buffer.byteLength(cancelledPendingDeliveryId) +
      Buffer.byteLength(pendingCancellationRecord) +
      128;
    assert.equal(
      Number(await redis.get(keys.bytes)),
      preCancelledFenceBytes + pendingCancellationBytes,
    );
    assert.equal(
      await producer.cancelDelivery(cancelledPendingDeliveryId),
      "cancelled",
      "cancelling a pending delivery must remove its payload and retain a fence",
    );
    const cancelledPendingFenceBytes =
      Buffer.byteLength(cancelledPendingDeliveryId) +
      Buffer.byteLength(cancellationRecord) +
      128;
    const cancellationFenceBytes =
      preCancelledFenceBytes + cancelledPendingFenceBytes;
    assert.equal(
      await producer.getDeliveryStatus(cancelledPendingDeliveryId),
      "discarded",
    );
    assert.equal(
      await redis.hget(keys.idempotency, cancelledPendingDeliveryId),
      cancellationRecord,
    );
    assert.equal(Number(await redis.get(keys.bytes)), cancellationFenceBytes);
    assert.equal(await redis.hlen(keys.jobs), 0);
    assert.equal(await redis.zcard(keys.ready), 0);
    assert.equal(await redis.zcard(keys.leased), 0);
    assert.equal(await redis.zcard(keys.dead), 0);
    assert.equal(await redis.zcard(keys.expiry), 0);
    assert.equal(await redis.hlen(keys.claims), 0);
    assert.equal(
      await consumer.claim(),
      null,
      "cancelled jobs must never become claimable",
    );

    const enqueued = await producer.enqueue(message, "account", deliveryId);
    assert.equal(enqueued.id, deliveryId);
    const persisted = normalizeWaitAofResult(
      await redis.call("WAITAOF", 1, 0, 5_000),
    );
    assert.ok(
      persisted.local >= 1,
      "WAITAOF must confirm at least one local AOF",
    );

    const bytesAfterFirstEnqueue = Number(await redis.get(keys.bytes));
    assert.ok(bytesAfterFirstEnqueue > cancellationFenceBytes);
    assert.equal(await redis.hlen(keys.jobs), 1);
    assert.equal(await redis.zcard(keys.ready), 1);

    await producer.enqueue(message, "account", deliveryId);
    assert.equal(
      await redis.hlen(keys.jobs),
      1,
      "idempotent retry must not duplicate the job",
    );
    assert.equal(
      await redis.zcard(keys.ready),
      1,
      "idempotent retry must not duplicate the ready member",
    );
    assert.equal(Number(await redis.get(keys.bytes)), bytesAfterFirstEnqueue);

    await assert.rejects(
      producer.enqueue(
        { ...message, subject: "conflicting-subject-5a40a16a" },
        "account",
        deliveryId,
      ),
      /already bound to a different message/,
    );
    assert.equal(await redis.hlen(keys.jobs), 1);
    assert.equal(Number(await redis.get(keys.bytes)), bytesAfterFirstEnqueue);

    await assertNoPlaintextAtRest(
      redis,
      keyPrefix,
      keys.jobs,
      deliveryId,
      plaintextMarkers,
    );

    const claim = await consumer.claim();
    assert.ok(claim, "consumer must claim the producer job");
    assert.deepEqual(
      claim.job,
      enqueued,
      "consumer must decrypt the exact producer payload",
    );
    assert.equal(claim.token, "email-redis-e2e-claim-token");
    const bytesBeforeInFlightCancellation = Number(await redis.get(keys.bytes));
    assert.equal(
      await producer.cancelDelivery(deliveryId),
      "in-flight",
      "a leased delivery cannot be cancelled as if it were still pending",
    );
    assert.equal(
      Number(await redis.get(keys.bytes)),
      bytesBeforeInFlightCancellation,
    );
    assert.notEqual(await redis.zscore(keys.leased, deliveryId), null);
    assert.notEqual(await redis.hget(keys.jobs, deliveryId), null);

    consumerNow += 1_000;
    assert.equal(await consumer.renewLease(claim), true);
    assert.equal(claim.leaseExpiresAt, consumerNow + 30_000);
    assert.equal(await consumer.acknowledge(claim), "settled");
    const settledPersistence = normalizeWaitAofResult(
      await redis.call("WAITAOF", 1, 0, 5_000),
    );
    assert.ok(
      settledPersistence.local >= 1,
      "acknowledgement must reach local AOF",
    );

    assert.equal(await redis.hlen(keys.jobs), 0);
    assert.equal(await redis.zcard(keys.ready), 0);
    assert.equal(await redis.zcard(keys.leased), 0);
    assert.equal(await redis.hlen(keys.claims), 0);
    const settledRecord = await redis.hget(keys.idempotency, deliveryId);
    assert.match(settledRecord ?? "", /^s:[a-f0-9]{64}$/);
    const settledTombstoneBytes =
      Buffer.byteLength(deliveryId) + Buffer.byteLength(settledRecord) + 128;
    assert.equal(
      Number((await redis.get(keys.bytes)) ?? 0),
      cancellationFenceBytes + settledTombstoneBytes,
      "queue byte accounting must retain exactly the cancellation fences and settled tombstone",
    );
    assert.notEqual(
      await redis.zscore(keys.idempotencyExpiry, deliveryId),
      null,
    );
    assert.equal(
      await producer.cancelDelivery(deliveryId),
      "provider-accepted",
      "provider acceptance must win over a late cancellation",
    );
    assert.equal(await redis.hget(keys.idempotency, deliveryId), settledRecord);
    assert.equal(
      Number((await redis.get(keys.bytes)) ?? 0),
      cancellationFenceBytes + settledTombstoneBytes,
    );

    console.log(
      `Email Redis integration passed: Redis ${await redis.call("INFO", "server").then(redisVersion)}, encrypted producer/consumer interoperability, durable cancellation fencing, exact readiness, AOF durability, idempotency, lease renewal, and bounded tombstone accounting.`,
    );
  } finally {
    const ownedKeys = await scanOwnedKeys(redis, keyPrefix).catch(() => []);
    if (ownedKeys.length > 0) {
      assert.ok(ownedKeys.every((key) => key.startsWith(`${keyPrefix}:`)));
      await redis.del(...ownedKeys);
    }
    await redis.quit().catch(() => redis.disconnect());
  }
}

async function assertNoPlaintextAtRest(
  redis,
  keyPrefix,
  jobsKey,
  deliveryId,
  markers,
) {
  const rawEnvelope = await redis.hget(jobsKey, deliveryId);
  assert.ok(rawEnvelope);
  const envelope = JSON.parse(rawEnvelope);
  assert.deepEqual(Object.keys(envelope).sort(), [
    "alg",
    "ciphertext",
    "iv",
    "tag",
    "v",
  ]);
  assert.equal(envelope.v, 1);
  assert.equal(envelope.alg, "A256GCM");

  const ownedKeys = await scanOwnedKeys(redis, keyPrefix);
  assert.ok(ownedKeys.length >= 5);
  for (const marker of markers) {
    assert.equal(
      rawEnvelope.includes(marker),
      false,
      `encrypted envelope leaked marker: ${marker}`,
    );
    assert.equal(
      ownedKeys.some((key) => key.includes(marker)),
      false,
      `Redis key leaked marker: ${marker}`,
    );
  }

  for (const key of ownedKeys) {
    const dumped = await redis.callBuffer("DUMP", key);
    if (!dumped) {
      continue;
    }
    for (const marker of markers) {
      assert.equal(
        dumped.includes(Buffer.from(marker, "utf8")),
        false,
        `Redis value leaked marker: ${marker}`,
      );
    }
  }
}

async function scanOwnedKeys(redis, keyPrefix) {
  const keys = [];
  let cursor = "0";
  do {
    const result = await redis.scan(
      cursor,
      "MATCH",
      `${keyPrefix}:*`,
      "COUNT",
      100,
    );
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== "0");
  return [...new Set(keys)];
}

function assertRedisAofConfiguration(value) {
  const flattened = Array.isArray(value)
    ? value.flat(Infinity).map(String)
    : [String(value)];
  const appendOnlyIndex = flattened.indexOf("appendonly");
  assert.ok(
    appendOnlyIndex >= 0 && flattened[appendOnlyIndex + 1] === "yes",
    "Redis appendonly must be enabled",
  );
}

function normalizeWaitAofResult(value) {
  assert.ok(
    Array.isArray(value) && value.length >= 2,
    "WAITAOF returned an invalid response",
  );
  const local = Number(value[0]);
  const replicas = Number(value[1]);
  assert.ok(Number.isSafeInteger(local) && local >= 0);
  assert.ok(Number.isSafeInteger(replicas) && replicas >= 0);
  return { local, replicas };
}

function redisVersion(info) {
  const match = String(info).match(/^redis_version:([^\r\n]+)/m);
  return match ? match[1] : "unknown";
}

async function waitForRedisContainer(containerName) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = run("docker", ["exec", containerName, "redis-cli", "ping"], {
      allowFailure: true,
    });
    if (result.status === 0 && result.stdout.trim() === "PONG") {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("The isolated Redis container did not become ready in time.");
}

function stopOwnedContainer(containerName, expectedId) {
  const inspection = run(
    "docker",
    ["inspect", "--format", "{{.Id}}", containerName],
    { allowFailure: true },
  );
  if (inspection.status !== 0) {
    return;
  }
  if (inspection.stdout.trim() !== expectedId) {
    throw new Error(
      "Refusing to stop a Redis container whose id no longer matches the one started by this test.",
    );
  }
  run("docker", ["stop", "--time", "10", containerName]);
}

function dockerIsAvailable() {
  const result = run("docker", ["version", "--format", "{{.Server.Version}}"], {
    allowFailure: true,
  });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function requiredArgument(name) {
  const index = argumentsList.indexOf(name);
  const value = index >= 0 ? argumentsList[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} is required in worker mode.`);
  }
  return value;
}

function runCorepackYarn(args, options) {
  if (process.platform === "win32") {
    const corepackEntrypoint = join(
      dirname(process.execPath),
      "node_modules",
      "corepack",
      "dist",
      "corepack.js",
    );
    if (!existsSync(corepackEntrypoint)) {
      throw new Error(
        "The Corepack entrypoint could not be located next to Node.js.",
      );
    }
    return run(
      process.execPath,
      [corepackEntrypoint, "yarn", ...args],
      options,
    );
  }
  return run("corepack", ["yarn", ...args], options);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
  });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`,
    );
  }
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
