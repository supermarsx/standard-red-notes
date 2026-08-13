#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const SERVER_ROOT = join(REPOSITORY_ROOT, "server");
const REDIS_IMAGE = "redis:8.8.0-alpine";
const REDIS_PORT = 6379;
const STARTUP_TIMEOUT_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 15_000;
const COMPOSE_SERVER_WORKDIR = "/opt/server/packages/api-gateway";

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
    `Email delivery end-to-end verification failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

async function runAgainstIsolatedRedis() {
  if (!dockerIsAvailable()) {
    if (requireDocker) {
      throw new Error("Docker is required, but the Docker daemon is unavailable.");
    }
    console.log(
      "SKIP email delivery end-to-end verification: Docker is unavailable (use --require-docker in required CI).",
    );
    return;
  }

  buildEmailPackages();

  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `srn-email-delivery-e2e-${suffix}`;
  const start = run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    `127.0.0.1::${REDIS_PORT}`,
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
      `${REDIS_PORT}/tcp`,
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
    throw new Error("Docker is required, but the Docker daemon is unavailable.");
  }

  for (const service of ["server", "cache"]) {
    const result = run(
      "docker",
      ["compose", "ps", "--status", "running", "--quiet", service],
      { allowFailure: true },
    );
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error(`The Compose ${service} service must be running before this test.`);
    }
  }

  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerScript = `/var/lib/server/logs/.srn-email-delivery-e2e-${suffix}.mjs`;
  run("docker", ["compose", "cp", SCRIPT_PATH, `server:${containerScript}`]);
  let workerFailure;
  try {
    const worker = run(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "--workdir",
        COMPOSE_SERVER_WORKDIR,
        "server",
        "yarn",
        "node",
        containerScript,
        "--worker",
        "--redis-url",
        "redis://cache:6379",
        "--verify-compose-environment",
      ],
      { allowFailure: true, stdio: "inherit" },
    );
    if (worker.status !== 0) {
      workerFailure = new Error(
        `The Compose email delivery worker exited with status ${worker.status}.`,
      );
    }
  } finally {
    const cleanup = run(
      "docker",
      ["compose", "exec", "-T", "server", "rm", "-f", containerScript],
      { allowFailure: true },
    );
    if (cleanup.status !== 0) {
      throw new Error(
        "Could not remove the exact temporary email delivery test script from the server container.",
      );
    }
  }
  if (workerFailure) {
    throw workerFailure;
  }
}

function buildEmailPackages() {
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
  if (argumentsList.includes("--verify-compose-environment")) {
    await assertComposeEmailEnvironment();
  }

  const requireFromGateway = createRequire(
    pathToFileURL(join(process.cwd(), "package.json")),
  );
  const RedisModule = requireFromGateway("ioredis");
  const Redis = RedisModule.default ?? RedisModule;
  const {
    RedisEncryptedEmailQueueProducer,
    confirmEmailQueueAofPersistence,
    emailQueueCompatibleKeyPrefix,
    emailQueueRedisKeys,
    emailQueueWorkerReadinessKey,
    emailQueueWorkerReadinessValue,
  } = requireFromGateway("@standardnotes/domain-core");
  const {
    DefaultAdminEmailDeliveryService,
    DefaultEmailRelayFactory,
    EmailDeliveryRuntime,
    EmailDeliveryService,
    EmailDeliveryWorker,
    RedisEmailAttemptLog,
    RedisEmailDeliveryQueue,
    RedisEmailProfileRateLimiter,
    orderedEnabledRelays,
  } = requireFromGateway(
    "./dist/src/Service/EmailDelivery/index.js",
  );
  const { ServerSettingsStore } = requireFromGateway(
    "./dist/src/Service/ServerSettings/ServerSettingsStore.js",
  );
  const { ServerSettingsResolver } = requireFromGateway(
    "./dist/src/Service/ServerSettings/ServerSettingsResolver.js",
  );

  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const stableSecret = randomBytes(32).toString("hex");
  const queueLimits = {
    retentionMs: 60 * 60 * 1_000,
    maxAttempts: 3,
    maxJobBytes: 1024 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
  };
  const keyPrefix = emailQueueCompatibleKeyPrefix(
    stableSecret,
    undefined,
    queueLimits,
  );
  const queueKeys = emailQueueRedisKeys(keyPrefix);
  const readinessKey = emailQueueWorkerReadinessKey(keyPrefix);
  const relayId = `smtp-e2e-${suffix}`;
  const deliveryId = `email-e2e-${suffix}`;
  const sender = `sender-${suffix}@example.invalid`;
  const recipient = `recipient-${suffix}@example.invalid`;
  const subject = `SRN email delivery E2E ${suffix}`;
  const body = `srn-email-delivery-e2e-body-${suffix}`;
  const smtpUsername = `smtp-user-${suffix}`;
  const smtpPassword = `smtp-password-${suffix}`;
  const plaintextMarkers = [
    sender,
    recipient,
    subject,
    body,
    smtpUsername,
    smtpPassword,
  ];
  const redis = new Redis(redisUrl, {
    connectTimeout: 10_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
  });
  const smtpSink = createSmtpSink({
    username: smtpUsername,
    password: smtpPassword,
  });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "srn-email-delivery-e2e-"));
  const settingsPath = join(temporaryRoot, "server-settings.json");
  const runtimeEvents = [];
  let runtime;

  try {
    await redis.connect();
    await redis.ping();
    assertRedisAofConfiguration(
      await redis.call("CONFIG", "GET", "appendonly"),
    );
    const smtpPort = await smtpSink.start();

    const settingsStore = new ServerSettingsStore(settingsPath, stableSecret);
    const settingsResolver = new ServerSettingsResolver(settingsStore, {
      assistant: {},
    });
    const queue = new RedisEmailDeliveryQueue(redis, {
      encryptionKey: stableSecret,
      leaseMs: 30_000,
      retentionMs: queueLimits.retentionMs,
      maxAttempts: queueLimits.maxAttempts,
      deadLetterRetentionMs: queueLimits.retentionMs,
      maxJobBytes: queueLimits.maxJobBytes,
      maxTotalBytes: queueLimits.maxTotalBytes,
    });
    const attemptLogs = new RedisEmailAttemptLog(redis, {
      keyPrefix,
      retentionMs: queueLimits.retentionMs,
      maximumEntries: 100,
    });
    const rateLimiter = new RedisEmailProfileRateLimiter(
      redis,
      `${keyPrefix}:profile-limit`,
    );
    const delivery = new EmailDeliveryService(
      queue,
      attemptLogs,
      rateLimiter,
      new DefaultEmailRelayFactory(),
      () => settingsResolver.resolveEmailRelayConfiguration(),
      {
        maxAttempts: queueLimits.maxAttempts,
        retryBaseMs: 1_000,
        retryMaxMs: 5_000,
        jitterRatio: 0,
        leaseHeartbeatMs: 1_000,
      },
    );
    const admin = new DefaultAdminEmailDeliveryService(
      settingsResolver,
      delivery,
    );
    const saved = await admin.putRelays({
      relays: [
        {
          id: relayId,
          name: "Disposable authenticated SMTP sink",
          kind: "smtp",
          enabled: true,
          priority: 0,
          from: sender,
          rateLimit: { max: 5, windowSeconds: 60 },
          host: "127.0.0.1",
          port: smtpPort,
          username: smtpUsername,
          password: smtpPassword,
          tlsMode: "insecure",
        },
      ],
      fallbackPolicy: { mode: "none" },
    });

    assert.equal(saved.configured, true);
    assert.equal(saved.relays.length, 1);
    assert.equal(saved.relays[0].id, relayId);
    assert.equal(saved.relays[0].credentialsConfigured, true);
    assert.equal("password" in saved.relays[0], false);

    const persistedSettings = await readFile(settingsPath, "utf8");
    assert.match(persistedSettings, /relayConfigurationEncrypted/);
    for (const [markerIndex, marker] of [
      relayId,
      sender,
      smtpUsername,
      smtpPassword,
    ].entries()) {
      assert.equal(
        persistedSettings.includes(marker),
        false,
        `server settings leaked synthetic relay marker ${markerIndex + 1}`,
      );
    }

    const restartedSettings = new ServerSettingsResolver(
      new ServerSettingsStore(settingsPath, stableSecret),
      { assistant: {} },
    );
    const restoredConfig =
      await restartedSettings.resolveEmailRelayConfiguration();
    assert.deepEqual(restoredConfig, {
      relays: [
        {
          id: relayId,
          name: "Disposable authenticated SMTP sink",
          kind: "smtp",
          enabled: true,
          priority: 0,
          from: sender,
          rateLimit: { max: 5, windowSeconds: 60 },
          host: "127.0.0.1",
          port: smtpPort,
          username: smtpUsername,
          password: smtpPassword,
          tlsMode: "insecure",
        },
      ],
      fallbackPolicy: { mode: "none" },
    });

    const worker = new EmailDeliveryWorker(
      delivery,
      runtimeLogger(runtimeEvents),
      { intervalMs: 60_000, batchSize: 5 },
    );
    runtime = new EmailDeliveryRuntime(
      redis,
      worker,
      async () =>
        orderedEnabledRelays(
          await settingsResolver.resolveEmailRelayConfiguration(),
        ).length > 0,
      queueLimits,
      stableSecret,
      runtimeLogger(runtimeEvents),
    );
    assert.equal(await runtime.start(), true);
    assert.equal(runtime.isAcceptingEmails(), true);
    assert.equal(
      await redis.get(readinessKey),
      emailQueueWorkerReadinessValue(stableSecret, queueLimits),
    );

    const producer = new RedisEncryptedEmailQueueProducer(
      redis,
      stableSecret,
      queueLimits,
    );
    assert.equal(await producer.isReady(), true);
    const message = { to: recipient, subject, text: body };
    await producer.enqueue(message, "test", deliveryId);

    const queued = await admin.listQueue({ state: "ready", limit: 10 });
    assert.equal(queued.items.length, 1);
    assert.equal(queued.items[0].id, deliveryId);
    assert.equal(queued.items[0].source, "test");
    assertRedacted(queued, plaintextMarkers, "admin queue response");

    const encryptedJob = await redis.hget(queueKeys.jobs, deliveryId);
    assert.ok(encryptedJob, "the producer must persist an encrypted queue job");
    assertRedacted(encryptedJob, plaintextMarkers, "Redis queue envelope");

    await worker.tick();
    let received;
    try {
      received = await smtpSink.waitForMessage(DELIVERY_TIMEOUT_MS);
    } catch (error) {
      const queueStates = {};
      for (const state of ["ready", "leased", "dead"]) {
        queueStates[state] = (await admin.listQueue({ state, limit: 10 })).items.map(
          (item) => ({
            id: item.id,
            attempt: item.attempt,
            lastFailureClass: item.lastFailureClass,
          }),
        );
      }
      const attemptOutcomes = (await admin.listLogs({ limit: 10 })).items.map(
        (entry) => ({
          relayId: entry.relayId,
          outcome: entry.outcome,
          failureClass: entry.failureClass,
          providerCode: entry.providerCode,
        }),
      );
      throw new Error(
        `${error instanceof Error ? error.message : "SMTP delivery timed out"}; redacted diagnostic=${JSON.stringify({ queueStates, attemptOutcomes, runtimeEvents })}`,
      );
    }
    assert.equal(received.authenticatedUsername, smtpUsername);
    assert.equal(received.authenticatedPassword, smtpPassword);
    assert.equal(received.mailFrom, sender);
    assert.deepEqual(received.recipients, [recipient]);
    const mime = parseMimeMessage(received.data);
    assert.equal(mime.headers.get("from"), sender);
    assert.equal(mime.headers.get("to"), recipient);
    assert.equal(mime.headers.get("subject"), subject);
    assert.equal(normalizeBody(mime.body), body);

    for (const state of ["ready", "leased", "dead"]) {
      const page = await admin.listQueue({ state, limit: 10 });
      assert.deepEqual(page.items, [], `the ${state} queue must be empty after ACK`);
    }
    assert.equal(await redis.hlen(queueKeys.jobs), 0);
    assert.equal(await redis.zcard(queueKeys.ready), 0);
    assert.equal(await redis.zcard(queueKeys.leased), 0);
    assert.equal(await redis.zcard(queueKeys.dead), 0);
    await confirmEmailQueueAofPersistence(redis);

    const logs = await admin.listLogs({ limit: 10 });
    assert.equal(logs.items.length, 1);
    assert.deepEqual(logs.items[0], {
      id: logs.items[0].id,
      jobId: deliveryId,
      relayId,
      relayKind: "smtp",
      attempt: 1,
      outcome: "sent",
      providerCode: "SMTP_ACCEPTED",
      durationMs: logs.items[0].durationMs,
      createdAt: logs.items[0].createdAt,
    });
    assertRedacted(logs, plaintextMarkers, "admin delivery logs");
    const rawLogEntries = await redis.hvals(`${keyPrefix}:log-entries`);
    assert.equal(rawLogEntries.length, 1);
    assertRedacted(rawLogEntries, plaintextMarkers, "Redis delivery logs");

    await producer.enqueue(message, "test", deliveryId);
    assert.equal(await redis.zcard(queueKeys.ready), 0);
    await worker.tick();
    assert.equal(
      smtpSink.receivedCount(),
      1,
      "an idempotent producer replay after durable ACK must not redeliver",
    );

    assertRedacted(runtimeEvents, plaintextMarkers, "runtime logging");
    console.log(
      "Email delivery end-to-end verification passed: encrypted admin persistence, authenticated SMTP dispatch, runtime readiness, Redis 8 AOF enqueue/ACK, idempotent replay, queue drain, and redacted logs.",
    );
  } finally {
    await runtime?.stop().catch(() => undefined);
    await smtpSink.close().catch(() => undefined);
    const ownedKeys = await scanOwnedKeys(redis, keyPrefix).catch(() => []);
    if (ownedKeys.length > 0) {
      assert.ok(ownedKeys.every((key) => key.startsWith(`${keyPrefix}:`)));
      await redis.del(...ownedKeys);
    }
    await redis.quit().catch(() => redis.disconnect());
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function assertComposeEmailEnvironment() {
  const authPath = "/opt/server/packages/auth/.env";
  const gatewayPath = "/opt/server/packages/api-gateway/.env";
  const [authSource, gatewaySource, authMetadata, gatewayMetadata] =
    await Promise.all([
      readFile(authPath, "utf8"),
      readFile(gatewayPath, "utf8"),
      stat(authPath),
      stat(gatewayPath),
    ]);

  for (const [label, metadata] of [
    ["auth", authMetadata],
    ["api-gateway", gatewayMetadata],
  ]) {
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error(`The generated ${label} dotenv must have mode 0600.`);
    }
  }

  const auth = parseGeneratedEnvironment(authSource, "auth");
  const gateway = parseGeneratedEnvironment(gatewaySource, "api-gateway");
  const shared = [
    "SERVER_SETTINGS_PATH",
    "EMAIL_DELIVERY_ENCRYPTION_KEY",
    "EMAIL_QUEUE_MAX_ATTEMPTS",
    "EMAIL_QUEUE_RETENTION_MS",
    "EMAIL_QUEUE_MAX_JOB_BYTES",
    "EMAIL_QUEUE_MAX_TOTAL_BYTES",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_FROM",
    "SMTP_SECURE",
    "SMTP_ALLOW_INSECURE",
  ];
  for (const key of shared) {
    if (!auth.has(key) || !gateway.has(key)) {
      throw new Error(`The Compose email environment is missing shared ${key}.`);
    }
    if (auth.get(key) !== gateway.get(key)) {
      throw new Error(`The Compose auth and api-gateway values differ for ${key}.`);
    }
  }

  for (const key of [
    "SERVER_SETTINGS_PATH",
    "EMAIL_DELIVERY_ENCRYPTION_KEY",
    "EMAIL_QUEUE_MAX_ATTEMPTS",
    "EMAIL_QUEUE_RETENTION_MS",
    "EMAIL_QUEUE_MAX_JOB_BYTES",
    "EMAIL_QUEUE_MAX_TOTAL_BYTES",
  ]) {
    if (!auth.get(key)) {
      throw new Error(`The Compose shared email value ${key} must not be empty.`);
    }
  }
  if (
    !auth.has("ENCRYPTION_SERVER_KEY") ||
    auth.get("EMAIL_DELIVERY_ENCRYPTION_KEY") !==
      auth.get("ENCRYPTION_SERVER_KEY")
  ) {
    throw new Error(
      "The email queue key must match the bundled auth server encryption key.",
    );
  }

  for (const key of [
    "EMAIL_QUEUE_LEASE_MS",
    "EMAIL_QUEUE_DEAD_RETENTION_MS",
    "EMAIL_DELIVERY_WORKER_INTERVAL_MS",
    "EMAIL_DELIVERY_WORKER_BATCH_SIZE",
    "EMAIL_DELIVERY_RETRY_BASE_MS",
    "EMAIL_DELIVERY_RETRY_MAX_MS",
    "EMAIL_DELIVERY_LOG_RETENTION_MS",
    "EMAIL_DELIVERY_LOG_MAX_ENTRIES",
  ]) {
    if (!gateway.get(key)) {
      throw new Error(`The Compose api-gateway email value ${key} is missing.`);
    }
  }
  for (const key of [
    "EMAIL_BACKUPS_ENABLED",
    "EMAIL_ATTACHMENT_MAX_BYTE_SIZE",
  ]) {
    if (!auth.get(key)) {
      throw new Error(`The Compose auth email value ${key} is missing.`);
    }
  }
}

function parseGeneratedEnvironment(source, label) {
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator) : "";
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || values.has(key)) {
      throw new Error(`The generated ${label} dotenv is malformed.`);
    }
    values.set(key, line.slice(separator + 1));
  }
  return values;
}

function createSmtpSink(credentials) {
  const messages = [];
  const waiters = [];
  const sockets = new Set();
  let listening = false;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(DELIVERY_TIMEOUT_MS, () => socket.destroy());
    let buffer = "";
    let dataMode = false;
    let authContinuation = false;
    let authenticatedUsername;
    let authenticatedPassword;
    let mailFrom;
    let recipients = [];
    let dataLines = [];

    socket.write("220 srn-email-e2e ESMTP ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        if (dataMode) {
          if (line === ".") {
            dataMode = false;
            const message = {
              authenticatedUsername,
              authenticatedPassword,
              mailFrom,
              recipients: [...recipients],
              data: dataLines.join("\r\n"),
            };
            messages.push(message);
            while (waiters.length > 0) {
              waiters.shift()(message);
            }
            mailFrom = undefined;
            recipients = [];
            dataLines = [];
            socket.write("250 2.0.0 queued as srn-email-e2e\r\n");
          } else {
            dataLines.push(line.startsWith("..") ? line.slice(1) : line);
          }
          continue;
        }

        if (authContinuation) {
          authContinuation = false;
          ({ username: authenticatedUsername, password: authenticatedPassword } =
            decodePlainAuthentication(line));
          socket.write(
            authenticatedUsername === credentials.username &&
              authenticatedPassword === credentials.password
              ? "235 2.7.0 authentication successful\r\n"
              : "535 5.7.8 authentication failed\r\n",
          );
          continue;
        }

        const [command = "", ...parameters] = line.split(" ");
        const upperCommand = command.toUpperCase();
        const parameter = parameters.join(" ");
        if (upperCommand === "EHLO" || upperCommand === "HELO") {
          socket.write(
            "250-srn-email-e2e\r\n250-8BITMIME\r\n250-AUTH PLAIN\r\n250 PIPELINING\r\n",
          );
        } else if (upperCommand === "AUTH" && /^PLAIN(?:\s|$)/i.test(parameter)) {
          const initialResponse = parameter.replace(/^PLAIN\s*/i, "");
          if (!initialResponse) {
            authContinuation = true;
            socket.write("334 \r\n");
          } else {
            ({ username: authenticatedUsername, password: authenticatedPassword } =
              decodePlainAuthentication(initialResponse));
            socket.write(
              authenticatedUsername === credentials.username &&
                authenticatedPassword === credentials.password
                ? "235 2.7.0 authentication successful\r\n"
                : "535 5.7.8 authentication failed\r\n",
            );
          }
        } else if (upperCommand === "MAIL") {
          if (
            authenticatedUsername !== credentials.username ||
            authenticatedPassword !== credentials.password
          ) {
            socket.write("530 5.7.0 authentication required\r\n");
          } else {
            mailFrom = smtpPath(parameter, "FROM");
            socket.write(
              mailFrom
                ? "250 2.1.0 sender accepted\r\n"
                : "501 5.5.4 invalid sender\r\n",
            );
          }
        } else if (upperCommand === "RCPT") {
          const recipient = smtpPath(parameter, "TO");
          if (recipient) {
            recipients.push(recipient);
            socket.write("250 2.1.5 recipient accepted\r\n");
          } else {
            socket.write("501 5.5.4 invalid recipient\r\n");
          }
        } else if (upperCommand === "DATA") {
          if (!mailFrom || recipients.length === 0) {
            socket.write("503 5.5.1 sender and recipient required\r\n");
          } else {
            dataMode = true;
            dataLines = [];
            socket.write("354 end data with <CR><LF>.<CR><LF>\r\n");
          }
        } else if (upperCommand === "RSET") {
          mailFrom = undefined;
          recipients = [];
          dataLines = [];
          socket.write("250 2.0.0 reset\r\n");
        } else if (upperCommand === "NOOP") {
          socket.write("250 2.0.0 ok\r\n");
        } else if (upperCommand === "QUIT") {
          socket.end("221 2.0.0 bye\r\n");
        } else {
          socket.write("502 5.5.2 command not implemented\r\n");
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  return {
    async start() {
      await new Promise((resolvePromise, rejectPromise) => {
        const onError = (error) => rejectPromise(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", onError);
          listening = true;
          resolvePromise();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string" || address.port < 1) {
        throw new Error("The disposable SMTP sink did not expose a TCP port.");
      }
      return address.port;
    },
    waitForMessage(timeoutMs) {
      if (messages.length > 0) {
        return Promise.resolve(messages[0]);
      }
      return new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(onMessage);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          rejectPromise(new Error("The disposable SMTP sink received no message."));
        }, timeoutMs);
        const onMessage = (message) => {
          clearTimeout(timeout);
          resolvePromise(message);
        };
        waiters.push(onMessage);
      });
    },
    receivedCount() {
      return messages.length;
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (!listening) {
        return;
      }
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) =>
          error ? rejectPromise(error) : resolvePromise(),
        );
      });
      listening = false;
    },
  };
}

function decodePlainAuthentication(value) {
  let decoded;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return { username: undefined, password: undefined };
  }
  const parts = decoded.split("\0");
  if (parts.length !== 3) {
    return { username: undefined, password: undefined };
  }
  return { username: parts[1], password: parts[2] };
}

function smtpPath(value, keyword) {
  const match = value.match(new RegExp(`^${keyword}:\\s*<([^<>]+)>`, "i"));
  return match?.[1];
}

function parseMimeMessage(value) {
  const separator = value.indexOf("\r\n\r\n");
  assert.ok(separator > 0, "the SMTP payload must contain MIME headers");
  const unfolded = value
    .slice(0, separator)
    .replace(/\r\n[\t ]+/g, " ");
  const headers = new Map();
  for (const line of unfolded.split("\r\n")) {
    const colon = line.indexOf(":");
    assert.ok(colon > 0, `invalid MIME header: ${line}`);
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body: value.slice(separator + 4) };
}

function normalizeBody(value) {
  return value.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

function assertRedacted(value, markers, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const [markerIndex, marker] of markers.entries()) {
    assert.equal(
      serialized.includes(marker),
      false,
      `${label} leaked synthetic plaintext marker ${markerIndex + 1}`,
    );
  }
}

function runtimeLogger(events) {
  const record = (level) => (message, metadata) =>
    events.push({ level, message, ...(metadata ? { metadata } : {}) });
  return {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
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
