import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  discoverLiveSourceFiles,
  guardedRuntimeRoots,
  validateRepositoryWideSafeLoggingSources,
  validateSafeLoggingSources,
} from "./validate-safe-logging.mjs";

test("discovers every guarded runtime surface, including exact app roots and nested server executables", async () => {
  assert.deepEqual(guardedRuntimeRoots, [
    "app/packages/api",
    "app/packages/encryption",
    "app/packages/mobile",
    "app/packages/snjs",
    "app/packages/utils",
    "cli",
    "mcp",
    "openclaw",
    "server/packages",
  ]);

  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const discovered = new Set(await discoverLiveSourceFiles(repositoryRoot));
  const representatives = [
    "app/packages/api/src/index.ts",
    "app/packages/encryption/src/index.ts",
    "app/packages/mobile/src/Lib/MobileDevice.ts",
    "app/packages/snjs/lib/index.ts",
    "app/packages/utils/src/index.ts",
    "cli/srn-client/src/index.ts",
    "cli/srn-server/src/index.ts",
    "mcp/src/index.ts",
    "openclaw/src/index.ts",
    "server/packages/api-gateway/bin/server.ts",
    "server/packages/auth/src/Bootstrap/Container.ts",
    "server/packages/domain-events-infra/src/index.ts",
  ];

  for (const file of representatives) {
    assert.ok(discovered.has(file), `expected authored runtime source ${file}`);
  }
  assert.ok(
    [...discovered].every(
      (file) =>
        !file.includes("/node_modules/") &&
        !file.includes("/dist/") &&
        !/(?:^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file),
    ),
    "generated dependencies, build output, and tests must not dilute the authored-runtime gate",
  );
});

test("discovers only the explicitly migrated app package roots", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "safe-log-app-scope-"));
  const migratedPackages = ["api", "encryption", "mobile", "snjs", "utils"];

  try {
    for (const packageName of migratedPackages) {
      const packageRoot = join(fixtureRoot, "app/packages", packageName);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, "safe.ts"),
        "logger.error('Operation failed.')\n",
      );
    }
    await mkdir(join(fixtureRoot, "app/packages/web"), { recursive: true });
    await writeFile(
      join(fixtureRoot, "app/packages/web/unsafe.ts"),
      "logger.error(error)\n",
    );

    assert.deepEqual(
      (await discoverLiveSourceFiles(fixtureRoot)).filter((file) =>
        file.startsWith("app/"),
      ),
      migratedPackages.map(
        (packageName) => `app/packages/${packageName}/safe.ts`,
      ),
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("reports former raw-token, raw-object, and credential-in-path patterns", () => {
  const failures = validateSafeLoggingSources(
    {
      "unsafe.ts": `
        logger.debug(\`Created JWT token for user \${userId}: \${token}\`)
        logger.debug('Response error: %O', error)
        logger.info('setWindow got new sessionKey', this.sessionKey)
        const url = \`\${this.authServerUrl}/subscription-tokens/\${subscriptionToken}/validate\`
        logger.info(\`[ws] connect user=\${userUuid} session=\${sessionUuid}\`)
        logger.warn('[ws] socket error', err instanceof Error ? err.message : err)
        logger.info(\`[push] excludeSession=\${originatingSessionUuid}\`)
        logger.error('WebSocketRedisBridge error: %O', error)
        console.log('Error parsing message from React Native', message, error)
        console.log('onGeneralMessage', JSON.stringify(message))
        console.error('Error decrypting payload', { error: e.message })
        logger.error(\`Internal gRPC error: \${error.message}\`)
        console.log(args)
        this.initializeNotifications().catch(console.error)
        logger.error(\`\${error.stack}\`)
        console.error(startupError.stack)
        SNLog.onError = console.error
        window.ReactNativeWebView.postMessage('[web log] ' + args.join(' '))
        console.error(Error('fixed text still carries a stack'))
      `,
    },
    {
      requiredRules: [],
    },
  );

  assert.deepEqual(failures, [
    "unsafe.ts: forbidden pattern raw-jwt-log",
    "unsafe.ts: forbidden pattern raw-error-object-log",
    "unsafe.ts: forbidden pattern raw-component-session-log",
    "unsafe.ts: forbidden pattern subscription-token-in-internal-path",
    "unsafe.ts: forbidden pattern websocket-session-identifier-log",
    "unsafe.ts: forbidden pattern websocket-raw-error-message",
    "unsafe.ts: forbidden pattern home-websocket-raw-error",
    "unsafe.ts: forbidden pattern mobile-bridge-raw-message",
    "unsafe.ts: forbidden pattern crypto-exception-message-log",
    "unsafe.ts: forbidden pattern interpolated-error-message-log",
    "unsafe.ts: forbidden pattern raw-mobile-console-arguments",
    "unsafe.ts: forbidden pattern raw-error-stack-log",
    "unsafe.ts: forbidden pattern raw-app-snlog-console-binding",
    "unsafe.ts: forbidden pattern raw-mobile-web-log-forwarding",
    "unsafe.ts: forbidden pattern raw-console-error-instance",
  ]);
});

test("accepts allowlisted structured summaries and a fixed credential transport", () => {
  const failures = validateSafeLoggingSources(
    {
      "safe.ts": `
        logger.error('Could not validate subscription token.', {
          endpoint: sanitizeUrlForSafeLog(authServerUrl + '/subscription-tokens/validate'),
          status: 503,
        })
        const headers = { 'x-subscription-token': subscriptionToken }
      `,
    },
    {
      requiredRules: [],
    },
  );

  assert.deepEqual(failures, []);
});

test("requires gateway rate-limit adapters to preserve safe metadata", () => {
  const file = "server/packages/api-gateway/bin/server.ts";
  const requiredRules = [
    {
      id: "gateway-rate-limit-logger-metadata-forwarding",
      file,
      pattern:
        /logger:\s*\{\s*warn:\s*\(message:\s*string,\s*metadata\?:\s*Record<string,\s*unknown>\)\s*=>\s*logger\.warn\(message,\s*metadata\)\s*,?\s*\}/,
    },
  ];

  assert.deepEqual(
    validateSafeLoggingSources(
      {
        [file]: "logger: { warn: (message: string) => logger.warn(message) }",
      },
      { forbiddenRules: [], requiredRules },
    ),
    [
      `${file}: missing required contract gateway-rate-limit-logger-metadata-forwarding`,
    ],
  );

  assert.deepEqual(
    validateSafeLoggingSources(
      {
        [file]:
          "logger: { warn: (message: string, metadata?: Record<string, unknown>) => logger.warn(message, metadata) }",
      },
      { forbiddenRules: [], requiredRules },
    ),
    [],
  );

  const userFile =
    "server/packages/api-gateway/src/Controller/UserRateLimitMiddleware.ts";
  const userRequiredRules = [
    {
      id: "gateway-user-rate-limit-logger-metadata-forwarding",
      file: userFile,
      pattern:
        /warn:\s*\(message:\s*string,\s*metadata\?:\s*Record<string,\s*unknown>\)[^=]*=>\s*\{\s*logger\.warn\(message,\s*metadata\)/,
    },
  ];
  assert.deepEqual(
    validateSafeLoggingSources(
      {
        [userFile]: "warn: (message: string): void => { logger.warn(message) }",
      },
      { forbiddenRules: [], requiredRules: userRequiredRules },
    ),
    [
      `${userFile}: missing required contract gateway-user-rate-limit-logger-metadata-forwarding`,
    ],
  );
});

test("enforces byte-for-byte parity for the shared safe-log kernel", () => {
  const authFile = "server/packages/auth/src/Domain/Logging/SafeLog.ts";
  const gatewayFile =
    "server/packages/api-gateway/src/Service/Logging/SafeLog.ts";
  const appFile = "app/packages/utils/src/Domain/Logger/SafeLog.ts";
  const kernel = `
const Redacted = '[REDACTED]'
const contractValue = 1
// SAFE_LOG_SHARED_KERNEL_END
`;

  assert.deepEqual(
    validateSafeLoggingSources(
      {
        [authFile]: kernel,
        [gatewayFile]: kernel,
        [appFile]: kernel,
      },
      { forbiddenRules: [], requiredRules: [] },
    ),
    [],
  );

  assert.deepEqual(
    validateSafeLoggingSources(
      {
        [authFile]: kernel,
        [gatewayFile]: kernel,
        [appFile]: kernel.replace("contractValue = 1", "contractValue = 2"),
      },
      { forbiddenRules: [], requiredRules: [] },
    ),
    [`${appFile}: safe-log shared kernel differs from ${authFile}`],
  );
});

test("repository-wide detector rejects raw failures, credentials, and PII disguised as an id", () => {
  const result = validateRepositoryWideSafeLoggingSources(
    {
      "server/packages/auth/src/unsafe.ts": `
        promise.catch(console.error)
        logger.error(\`request failed: \${error.message}\`)
        logger.error('request failed', error)
        logger.info(\`signed in with token \${authToken}\`)
        logger.info('subscription event', { userId: event.payload.userEmail })
      `,
    },
    [],
  );

  assert.deepEqual(result.failures, [
    "server/packages/auth/src/unsafe.ts:3: unreviewed repository-wide finding raw-error-detail",
    "server/packages/auth/src/unsafe.ts:4: unreviewed repository-wide finding raw-error-object",
    "server/packages/auth/src/unsafe.ts:5: unreviewed repository-wide finding raw-sensitive-interpolation",
    "server/packages/auth/src/unsafe.ts:6: unreviewed repository-wide finding pii-mislabeled-as-user-id",
    "server/packages/auth/src/unsafe.ts:2: unreviewed repository-wide finding direct-console-callback",
  ]);
});

test("app detector rejects raw error aliases and domain objects only inside migrated package roots", () => {
  const result = validateRepositoryWideSafeLoggingSources(
    {
      "app/packages/snjs/lib/unsafe.ts": `
        console.error('operation failed', e)
        logger.info('domain event', event)
        logger.debug('payload batch', payloads)
        logger.warn('sync options', options)
        logger.error('operation failed', String(e))
        console.error('safe failure', safeErrorLogMetadata(e))
        logger.info('safe event', redactLogValue(event))
      `,
      "app/packages/web/unsafe.ts":
        "console.error('not yet claimed by this gate', e)",
    },
    [],
  );

  assert.deepEqual(result.failures, [
    "app/packages/snjs/lib/unsafe.ts:2: unreviewed repository-wide finding raw-app-error-alias",
    "app/packages/snjs/lib/unsafe.ts:3: unreviewed repository-wide finding raw-app-domain-object",
    "app/packages/snjs/lib/unsafe.ts:4: unreviewed repository-wide finding raw-app-domain-object",
    "app/packages/snjs/lib/unsafe.ts:5: unreviewed repository-wide finding raw-app-domain-object",
    "app/packages/snjs/lib/unsafe.ts:6: unreviewed repository-wide finding raw-app-error-alias",
  ]);
});

test("repository-wide detector protects server bins, CLI and MCP sources, and every server package", () => {
  const result = validateRepositoryWideSafeLoggingSources(
    {
      "server/packages/files/bin/server.ts":
        "logger.error(`files server failed: ${error.message}`)",
      "server/packages/auth/bin/server.ts":
        "fatalLogger.error(`auth server failed: ${error.stack}`)",
      "cli/srn-server/src/main.ts":
        "console.error(`CLI failed: ${error.stack}`)",
      "mcp/src/index.ts": "logger.warn('MCP request failed', error)",
      "server/packages/revisions/src/Worker.ts":
        "logger.error('revision worker failed', exception)",
      "server/packages/domain-events-infra/src/Tracing.ts":
        "span.recordException(error)",
      "server/packages/files/src/Handler.ts": "this.logger.error(message)",
      "server/packages/files/src/HandlerWithContext.ts":
        "this.logger.error(message, { operation: 'upload' })",
      "server/packages/api-gateway/src/SafeAdapter.ts":
        "logger.warn(message, metadata)",
    },
    [],
  );

  assert.deepEqual(result.failures, [
    "server/packages/files/bin/server.ts:1: unreviewed repository-wide finding raw-error-detail",
    "server/packages/auth/bin/server.ts:1: unreviewed repository-wide finding raw-error-detail",
    "cli/srn-server/src/main.ts:1: unreviewed repository-wide finding raw-error-detail",
    "mcp/src/index.ts:1: unreviewed repository-wide finding raw-error-object",
    "server/packages/revisions/src/Worker.ts:1: unreviewed repository-wide finding raw-error-object",
    "server/packages/domain-events-infra/src/Tracing.ts:1: unreviewed repository-wide finding raw-telemetry-exception",
    "server/packages/files/src/Handler.ts:1: unreviewed repository-wide finding dynamic-error-message",
    "server/packages/files/src/HandlerWithContext.ts:1: unreviewed repository-wide finding dynamic-error-message",
  ]);
});

test("repository-wide detector accepts safe summaries and an exact reviewed residual", () => {
  const file = "server/packages/websocket-gateway/src/bridge.ts";
  const reviewedCall =
    "logger.info(`originExcluded=${message.originatingSessionUuid !== undefined}`)";
  const result = validateRepositoryWideSafeLoggingSources(
    {
      [file]: `
        logger.error('request failed', safeErrorLogMetadata(error))
        logger.error('result failed', safeErrorLogMetadata(result.getError()))
        logger.debug('request body shape', requestBodyLogMetadata(request.body))
        console.error('[mcp] request failed', diagnosticMessage(error))
        logger.info(\`originExcluded=\${message.originatingSessionUuid !== undefined}\`)
      `,
    },
    [
      {
        file,
        line: 6,
        rule: "raw-sensitive-interpolation",
        call: reviewedCall,
        reason: "Only a derived boolean is logged.",
      },
    ],
  );

  assert.deepEqual(result.failures, []);
  assert.equal(result.allowedFindings.length, 1);
  assert.equal(
    result.allowedFindings[0].reason,
    "Only a derived boolean is logged.",
  );
});

test("repository-wide reviewed residuals are bound to the exact site and complete parsed call", () => {
  const file = "server/packages/websocket-gateway/src/bridge.ts";
  const result = validateRepositoryWideSafeLoggingSources(
    {
      [file]:
        "logger.info(`originExcluded=${message.originatingSessionUuid !== undefined} origin=${message.originatingSessionUuid}`)",
    },
    [
      {
        file,
        line: 1,
        rule: "raw-sensitive-interpolation",
        call: "logger.info(`originExcluded=${message.originatingSessionUuid !== undefined}`)",
        reason: "Only a derived boolean is logged.",
      },
    ],
  );

  assert.deepEqual(result.failures, [
    `${file}:1: unreviewed repository-wide finding raw-sensitive-interpolation`,
    `${file}:1: stale safe-logging allowlist entry raw-sensitive-interpolation`,
  ]);
});

test("repository-wide detector still rejects a raw error beside a safe boundary", () => {
  const result = validateRepositoryWideSafeLoggingSources(
    {
      "mcp/src/index.ts":
        "console.error('[mcp] request failed', diagnosticMessage(error), error)",
    },
    [],
  );

  assert.deepEqual(result.failures, [
    "mcp/src/index.ts:1: unreviewed repository-wide finding raw-error-object",
  ]);
});

test("repository-wide detector rejects stale reviewed exceptions", () => {
  const result = validateRepositoryWideSafeLoggingSources(
    { "server/packages/auth/src/safe.ts": "logger.info('safe literal')" },
    [
      {
        file: "server/packages/auth/src/safe.ts",
        line: 1,
        rule: "raw-error-detail",
        call: "logger.error(error.message)",
        reason: "Previously reviewed.",
      },
    ],
  );

  assert.deepEqual(result.failures, [
    "server/packages/auth/src/safe.ts:1: stale safe-logging allowlist entry raw-error-detail",
  ]);
});
