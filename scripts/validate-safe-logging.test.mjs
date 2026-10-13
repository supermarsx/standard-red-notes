import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  davBridgeAllowedLogFields,
  davBridgeMinimumLogCalls,
  davBridgeSecretRevealSites,
  discoverLiveSourceFiles,
  findRepositoryWideFindings,
  guardedRuntimeRoots,
  listTrackedFiles,
  messageForwardingWrappers,
  requiredRules,
  reviewedSafeLoggingAllowlist,
  validateDavBridgeLogging,
  validateRepositoryWideSafeLoggingSources,
  validateSafeLoggingSources,
} from "./validate-safe-logging.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

test("an audited bounded boot refusal may be logged inline", () => {
  // `boundedBootFailureText` reduces a Result error to a constant string or a
  // fixed placeholder, so the inline form is safe. Without it on the reviewed
  // boundary list the only way past the validator was to hoist the call into a
  // local first, which hid the boundary instead of declaring it.
  const safe = validateRepositoryWideSafeLoggingSources(
    {
      "server/packages/home-server/bin/server.ts":
        "console.error('Could not start server.', { cause: boundedBootFailureText(result.getError()) })",
    },
    [],
  );
  assert.deepEqual(safe.failures, []);

  // The boundary is the only thing that makes it safe: the same call without it
  // still leaks the raw Result error.
  const unsafe = validateRepositoryWideSafeLoggingSources(
    {
      "server/packages/home-server/bin/server.ts":
        "console.error('Could not start server.', { cause: result.getError() })",
    },
    [],
  );
  assert.deepEqual(unsafe.failures, [
    "server/packages/home-server/bin/server.ts:1: unreviewed repository-wide finding raw-domain-result-error",
  ]);
});

test("the standalone gateway console boundary contracts point at the file that owns it", async () => {
  // These contracts named `index.ts` long after the boundary moved to
  // `logger.ts`, so they matched nothing: a gate that protects nothing. Run the
  // REAL rule objects against the REAL source rather than a restated copy, so
  // the test fails if either side drifts again.
  const loggerFile = "server/packages/websocket-gateway/src/logger.ts";
  const gatewayBoundaryRules = requiredRules.filter((rule) =>
    rule.id.startsWith("standalone-websocket-"),
  );
  assert.equal(gatewayBoundaryRules.length, 4);
  for (const rule of gatewayBoundaryRules) {
    assert.equal(rule.file, loggerFile);
  }

  const source = await readFile(resolve(repoRoot, loggerFile), "utf8");
  assert.deepEqual(
    validateSafeLoggingSources(
      { [loggerFile]: source },
      { forbiddenRules: [], requiredRules: gatewayBoundaryRules },
    ),
    [],
  );

  // Dropping the redaction spread, or pointing a level at the wrong console
  // method, must each be caught rather than silently accepted.
  for (const [find, replaceWith, id] of [
    [
      "...safeLogArguments(args)",
      "...args",
      "standalone-websocket-redaction-boundary",
    ],
    [
      "write('warn', sink.warn.bind(sink)",
      "write('warn', sink.log.bind(sink)",
      "standalone-websocket-warn-boundary",
    ],
    [
      "write('error', sink.error.bind(sink)",
      "write('error', sink.log.bind(sink)",
      "standalone-websocket-error-boundary",
    ],
  ]) {
    assert.ok(source.includes(find), `logger.ts no longer contains ${find}`);
    assert.deepEqual(
      validateSafeLoggingSources(
        { [loggerFile]: source.replace(find, replaceWith) },
        { forbiddenRules: [], requiredRules: gatewayBoundaryRules },
      ),
      [`${loggerFile}: missing required contract ${id}`],
    );
  }
});

// ---------------------------------------------------------------------------
// The DAV bridge logging contract.

const davRoot = "server/packages/api-gateway/src/Service/DavBridge/";
const davServiceFile = `${davRoot}DavBridgeService.ts`;
const davRelayFile = `${davRoot}DavRelay.ts`;
const davCipherFile = `${davRoot}DavSecretCipher.ts`;
const davSecretFile = `${davRoot}SecretString.ts`;
const davControllerFile =
  "server/packages/api-gateway/src/Controller/v1/DavBridgeController.ts";

async function readDavBridgeSources() {
  const discovered = (await discoverLiveSourceFiles(repoRoot)).filter((file) =>
    file.startsWith("server/packages/api-gateway/"),
  );
  return Object.fromEntries(
    await Promise.all(
      discovered.map(async (file) => [
        file,
        await readFile(join(repoRoot, file), "utf8"),
      ]),
    ),
  );
}

/** A synthetic bridge with enough well-formed lines to satisfy the denominators. */
function syntheticDavBridge(extraLine = "") {
  const lines = [
    "this.logger.debug('dav bridge request relayed', { userId: caller.userUuid, accountId: account.id, method, status })",
    "this.logger.info('dav bridge request refused', { userId: caller.userUuid, tag: error.tag, reason: error.logTag })",
  ];
  for (let index = 0; index < davBridgeMinimumLogCalls; index += 1) {
    lines.push(
      `this.logger.info('dav bridge account created', { userId: caller.userUuid, accountId: created.id })`,
    );
  }
  return {
    [davServiceFile]: `${lines.join("\n")}\n${extraLine}\n`,
    [davRelayFile]:
      "return `Bearer ${target.secret.reveal()}`\nreturn Buffer.from(target.secret.reveal())\n",
    [davCipherFile]: "return this.cipher.encrypt({ secret: secret.reveal() })\n",
  };
}

test("the DAV bridge as written satisfies its logging contract", async () => {
  const sources = await readDavBridgeSources();

  for (const file of [
    davServiceFile,
    davRelayFile,
    davCipherFile,
    davSecretFile,
    davControllerFile,
  ]) {
    assert.ok(sources[file] !== undefined, `expected to read ${file}`);
  }
  assert.deepEqual(validateDavBridgeLogging(sources), []);
});

test("the DAV bridge contract accepts a well-formed synthetic bridge, so its failures below are about the one line changed", () => {
  assert.deepEqual(validateDavBridgeLogging(syntheticDavBridge()), []);
});

test("the DAV bridge contract rejects a request path, a host, a header, a body, a name or error text in a log line", () => {
  for (const [line, expected] of [
    [
      "this.logger.debug('dav bridge request relayed', { userId: caller.userUuid, path: request.path })",
      [
        `${davServiceFile}:11: DAV bridge log field "path" is not on the closed list`,
        `${davServiceFile}:11: DAV bridge log field "path" is built from a path, address, header, body, name, secret or error text`,
      ],
    ],
    [
      "this.logger.info('dav bridge request refused', { reason: error.message })",
      [
        `${davServiceFile}:11: DAV bridge log field "reason" is built from a path, address, header, body, name, secret or error text`,
      ],
    ],
    [
      "this.logger.info('dav bridge request refused', { reason: account.origin })",
      [
        `${davServiceFile}:11: DAV bridge log field "reason" is built from a path, address, header, body, name, secret or error text`,
      ],
    ],
    [
      "this.logger.info('dav bridge request refused', { reason: url.hostname })",
      [
        `${davServiceFile}:11: DAV bridge log field "reason" is built from a path, address, header, body, name, secret or error text`,
      ],
    ],
    [
      "this.logger.info('dav bridge account created', { userId: account.username })",
      [
        `${davServiceFile}:11: DAV bridge log field "userId" is built from a path, address, header, body, name, secret or error text`,
      ],
    ],
    [
      "this.logger.info('dav bridge request refused', { tag: response.headers.get('www-authenticate') })",
      [
        `${davServiceFile}:11: DAV bridge log field "tag" is built from a path, address, header, body, name, secret or error text`,
      ],
    ],
    [
      "this.logger.info('dav bridge request relayed', { status: answer.body.length })",
      [
        `${davServiceFile}:11: DAV bridge log field "status" is built from a path, address, header, body, name, secret or error text`,
      ],
    ],
    [
      "this.logger.info('dav bridge account created', { remote: 1 })",
      [`${davServiceFile}:11: DAV bridge log field "remote" is not on the closed list`],
    ],
  ]) {
    assert.deepEqual(validateDavBridgeLogging(syntheticDavBridge(line)), expected, line);
  }
});

test("the DAV bridge contract rejects metadata it cannot read field by field", () => {
  for (const [line, expected] of [
    [
      "this.logger.info('dav bridge account created', { ...account })",
      `${davServiceFile}:11: DAV bridge log metadata must not spread an object`,
    ],
    [
      "this.logger.info('dav bridge account created', account)",
      `${davServiceFile}:11: DAV bridge log metadata must be an object literal written at the call`,
    ],
    [
      "this.logger.info('dav bridge account created', { [key]: 1 })",
      `${davServiceFile}:11: DAV bridge log metadata has a key that is not a plain name`,
    ],
    [
      "this.logger.info(`dav bridge account ${account.id}`, { userId: caller.userUuid })",
      `${davServiceFile}:11: a DAV bridge log message must be a fixed single-quoted literal`,
    ],
    [
      "this.logger.info(message, { userId: caller.userUuid })",
      `${davServiceFile}:11: a DAV bridge log message must be a fixed single-quoted literal`,
    ],
    [
      "this.logger.info('dav bridge account created', { userId: caller.userUuid }, account)",
      `${davServiceFile}:11: a DAV bridge log call takes a message and one metadata object`,
    ],
    [
      "console.log('dav bridge account created', { userId: caller.userUuid })",
      `${davServiceFile}:11: the DAV bridge must not log through console`,
    ],
  ]) {
    assert.deepEqual(validateDavBridgeLogging(syntheticDavBridge(line)), [expected], line);
  }
});

test("the DAV bridge contract sees a call made through optional chaining", () => {
  // The repository-wide extractor does not match `logger?.info(`; a contract
  // that shared that blind spot would wave this line through.
  for (const line of [
    "logger?.error('dav bridge request failed', { reason: error.message })",
    "this.logger?.info('admin dav-bridge settings updated', { reason: error.message })",
  ]) {
    assert.deepEqual(validateDavBridgeLogging(syntheticDavBridge(line)), [
      `${davServiceFile}:11: DAV bridge log field "reason" is built from a path, address, header, body, name, secret or error text`,
    ]);
  }
  assert.deepEqual(
    validateRepositoryWideSafeLoggingSources(
      { [davServiceFile]: "logger?.error('x', { reason: error.message })\n" },
      [],
    ).failures,
    [`${davServiceFile}:1: unreviewed repository-wide finding raw-error-detail`],
  );
});

test("the repository-wide extractor sees every optional-chaining form of a log call", () => {
  // Until the extractor allowed the `?`, each of these lines was invisible to
  // every repository-wide rule, and this repository writes `this.logger?.` in
  // every use case whose logger is optional.
  const file = "server/packages/auth/src/Domain/UseCase/Unsafe.ts";
  const lines = [
    "logger?.error(`failed: ${error.message}`)",
    "this.logger?.error(`failed: ${error.message}`)",
    "deps?.logger.warn(`failed: ${error.message}`)",
    "this.deps?.routingLogger?.info(`failed: ${error.message}`)",
    "logger.error?.(`failed: ${error.message}`)",
  ];
  // The last form, `logger.error?.(`, is a call the pattern does not claim to
  // see; it is listed so that a change to that is a decision, not an accident.
  const result = validateRepositoryWideSafeLoggingSources(
    { [file]: lines.join("\n") },
    [],
  );
  assert.deepEqual(result.failures, [
    `${file}:1: unreviewed repository-wide finding raw-error-detail`,
    `${file}:2: unreviewed repository-wide finding raw-error-detail`,
    `${file}:3: unreviewed repository-wide finding raw-error-detail`,
    `${file}:4: unreviewed repository-wide finding raw-error-detail`,
  ]);

  // The same calls with the error projected through the shared boundary pass.
  assert.deepEqual(
    validateRepositoryWideSafeLoggingSources(
      {
        [file]: [
          "logger?.error('failed', safeErrorLogMetadata(error))",
          "this.logger?.error('failed', { userId, ...safeErrorLogMetadata(error) })",
        ].join("\n"),
      },
      [],
    ).failures,
    [],
  );
});

test("errorName is a reviewed boundary only while its implementation is the pinned one", async () => {
  const runtimeFile =
    "server/packages/api-gateway/src/Service/EmailDelivery/EmailDeliveryRuntime.ts";
  assert.deepEqual(
    validateRepositoryWideSafeLoggingSources(
      {
        "server/packages/api-gateway/src/Service/Mail.ts":
          "this.logger?.error('relay failed', { errorType: errorName(error) })",
      },
      [],
    ).failures,
    [],
  );

  const rule = requiredRules.find(
    (candidate) => candidate.id === "email-delivery-error-name-projection",
  );
  assert.ok(rule);
  const source = await readFile(resolve(repoRoot, runtimeFile), "utf8");
  const pinned = { forbiddenRules: [], requiredRules: [rule] };
  assert.deepEqual(validateSafeLoggingSources({ [runtimeFile]: source }, pinned), []);

  // An errorName that returned the message would make every call above a leak.
  const projection = source.match(rule.pattern)?.[0];
  assert.ok(projection, "EmailDeliveryRuntime.ts no longer contains the pinned errorName");
  assert.deepEqual(
    validateSafeLoggingSources(
      {
        [runtimeFile]: source.replace(
          projection,
          "function errorName(error: unknown): string {\n  return error instanceof Error ? error.message : 'UnknownError'\n}",
        ),
      },
      pinned,
    ),
    [`${runtimeFile}: missing required contract email-delivery-error-name-projection`],
  );
});

test("a declared message-forwarding wrapper is checked through its callers", () => {
  const wrapperFile = "server/packages/websocket-gateway/src/refusals.ts";
  const callerFile = "server/packages/websocket-gateway/src/caller.ts";
  const wrapper = {
    file: wrapperFile,
    forwards: "logger.warn(message, { cause })",
    invocations: [{ file: callerFile, pattern: /\blogRefusal\(/g }],
  };
  const wrapperSource =
    "const logRefusal = (message, cause) => logger.warn(message, { cause })\n";
  const findings = (callerSource, sources = {}) =>
    findRepositoryWideFindings(
      { [wrapperFile]: wrapperSource, [callerFile]: callerSource, ...sources },
      [wrapper],
    ).map(({ file, line, rule }) => `${file}:${line}:${rule}`);

  // The wrapper's own `logger.warn(message, …)` is not a dynamic message while
  // every caller passes a literal, or a choice between two literals.
  assert.deepEqual(
    findings(
      [
        "logRefusal('[ws] connection rejected: unknown path', 'unknown-path')",
        "logRefusal(",
        "  secret",
        "    ? '[token] mint refused: bad token'",
        "    : '[token] mint refused: no secret configured',",
        "  'mint',",
        ")",
      ].join("\n"),
    ),
    [],
  );

  // A caller that builds the message is the dynamic message, wherever it is.
  assert.deepEqual(findings("logRefusal(`refused: ${req.url}`, 'x')"), [
    `${callerFile}:1:forwarded-message-not-literal`,
  ]);
  assert.deepEqual(findings("logRefusal(reason ? reason : 'fallback', 'x')"), [
    `${callerFile}:1:forwarded-message-not-literal`,
  ]);
  // Callers are held to the content rules a log call is held to.
  assert.deepEqual(
    findings("logRefusal('refused', `${error.message}`)"),
    [`${callerFile}:1:raw-error-detail`],
  );

  // A declaration that no longer matches the code is stale, and one that is
  // never invoked protects nothing.
  assert.deepEqual(
    findRepositoryWideFindings(
      {
        [wrapperFile]: "const logRefusal = (message) => logger.warn(message)\n",
        [callerFile]: "logRefusal('refused', 'x')",
      },
      [wrapper],
    ).map(({ rule }) => rule),
    ["dynamic-error-message", "stale-forwarding-wrapper"],
  );
  assert.deepEqual(findings("nothing()"), [
    `${wrapperFile}:1:forwarding-wrapper-never-invoked`,
  ]);
  assert.deepEqual(
    findRepositoryWideFindings({ [wrapperFile]: wrapperSource }, [wrapper]).map(
      ({ file, rule }) => `${file}:${rule}`,
    ),
    [
      `${callerFile}:forwarding-wrapper-caller-not-checked`,
      `${wrapperFile}:forwarding-wrapper-never-invoked`,
    ],
  );
});

test("the declared forwarding wrappers and reviewed residuals match the repository as written", async () => {
  const files = new Set([
    ...messageForwardingWrappers.flatMap((wrapper) => [
      wrapper.file,
      ...wrapper.invocations.map((invocation) => invocation.file),
    ]),
    ...reviewedSafeLoggingAllowlist.map((entry) => entry.file),
  ]);
  const sources = Object.fromEntries(
    await Promise.all(
      [...files].map(async (file) => [
        file,
        await readFile(join(repoRoot, file), "utf8"),
      ]),
    ),
  );
  const result = validateRepositoryWideSafeLoggingSources(sources);
  assert.deepEqual(result.failures, []);
  assert.equal(result.allowedFindings.length, reviewedSafeLoggingAllowlist.length);
  for (const entry of reviewedSafeLoggingAllowlist) {
    assert.ok(entry.reason.length > 40, `${entry.file}:${entry.line} needs a reason`);
  }
});

test("only files git tracks are checked from a work tree, and every discovered file outside one", async () => {
  const tracked = await listTrackedFiles(repoRoot);
  assert.ok(tracked instanceof Set);
  assert.ok(tracked.has("server/packages/websocket-gateway/src/gateway.ts"));
  assert.ok(![...tracked].some((file) => file.includes("\\")));

  const outside = await mkdtemp(join(tmpdir(), "safe-log-untracked-"));
  try {
    assert.equal(await listTrackedFiles(outside), undefined);
  } finally {
    await rm(outside, { force: true, recursive: true });
  }
});

test("the DAV bridge contract holds the controller to the same rules as the service", () => {
  const sources = {
    ...syntheticDavBridge(),
    [davControllerFile]:
      "logger.error('dav bridge request failed', { reason: 'internal', errorType: error.message })\n",
  };

  assert.deepEqual(validateDavBridgeLogging(sources), [
    `${davControllerFile}:1: DAV bridge log field "errorType" is built from a path, address, header, body, name, secret or error text`,
  ]);
});

test("the DAV bridge contract counts where the stored secret is revealed", () => {
  const base = syntheticDavBridge();

  assert.deepEqual(davBridgeSecretRevealSites, {
    [davRelayFile]: 2,
    [davCipherFile]: 1,
  });

  // A new reveal anywhere else in the api-gateway.
  assert.deepEqual(
    validateDavBridgeLogging({
      ...base,
      "server/packages/api-gateway/src/Controller/v1/AdminController.ts":
        "const password = account.secret.reveal()\n",
    }),
    [
      "server/packages/api-gateway/src/Controller/v1/AdminController.ts: the stored DAV account secret is revealed 1 time(s) here; the audited number for this file is 0",
    ],
  );
  // A third reveal inside an audited file.
  assert.deepEqual(
    validateDavBridgeLogging({
      ...base,
      [davRelayFile]: `${base[davRelayFile]}logger.debug(target.secret.reveal())\n`,
    }).filter((failure) => failure.includes("revealed")),
    [
      `${davRelayFile}: the stored DAV account secret is revealed 3 time(s) here; the audited number for this file is 2`,
    ],
  );
  // A reveal in the service itself.
  assert.deepEqual(
    validateDavBridgeLogging(syntheticDavBridge("const leaked = secret.reveal()")),
    [
      `${davServiceFile}: the stored DAV account secret is revealed 1 time(s) here; the audited number for this file is 0`,
    ],
  );
  // An audited site that was not checked at all is reported, not assumed fine.
  const withoutCipher = { ...base };
  delete withoutCipher[davCipherFile];
  assert.deepEqual(validateDavBridgeLogging(withoutCipher), [
    `${davCipherFile}: an audited secret-reveal site was not among the sources checked`,
  ]);
});

test("the DAV bridge contract fails when it is looking at nothing", () => {
  assert.deepEqual(
    validateDavBridgeLogging({
      ...syntheticDavBridge(),
      [davServiceFile]: "// every log call was moved or renamed\n",
    }),
    [
      `DAV bridge logging contract found 0 log call(s); at least ${davBridgeMinimumLogCalls} are expected, so the contract is not looking at the code it describes`,
      'DAV bridge logging contract did not find the "dav bridge request relayed" line',
      'DAV bridge logging contract did not find the "dav bridge request refused" line',
    ],
  );
  // Sources that contain no bridge file at all say nothing about the bridge.
  assert.deepEqual(
    validateDavBridgeLogging({ "server/packages/auth/src/index.ts": "export {}\n" }),
    [],
  );
});

test("the DAV bridge contract catches each deliberate fault in the real sources", async () => {
  const sources = await readDavBridgeSources();
  assert.deepEqual(validateDavBridgeLogging(sources), []);

  for (const [file, find, replaceWith, expected] of [
    [
      davServiceFile,
      "        method,\n        status,\n",
      "        method,\n        status,\n        path: outcome.answer.path,\n",
      /DAV bridge log field "path" is not on the closed list/,
    ],
    [
      davServiceFile,
      "reason: error.logTag,",
      "reason: error.message,",
      /DAV bridge log field "reason" is built from a path, address, header, body, name, secret or error text/,
    ],
    [
      davControllerFile,
      "errorType: error instanceof Error ? error.constructor.name : typeof error,",
      "errorType: error instanceof Error ? error.message : typeof error,",
      /DAV bridge log field "errorType" is built from/,
    ],
    [
      davServiceFile,
      "this.logger.info('dav bridge account created', { userId: caller.userUuid, accountId: created.id })",
      "this.logger.info('dav bridge account created', { userId: caller.userUuid, accountId: created.id, origin: created.origin })",
      /DAV bridge log field "origin" is not on the closed list/,
    ],
  ]) {
    assert.ok(sources[file].includes(find), `${file} no longer contains: ${find}`);
    const failures = validateDavBridgeLogging({
      ...sources,
      [file]: sources[file].replace(find, replaceWith),
    });
    assert.ok(
      failures.some((failure) => expected.test(failure)),
      `expected ${expected} after changing ${find} in ${file}; got ${JSON.stringify(failures)}`,
    );
  }
});

test("the SecretString redactions are pinned as required contracts", async () => {
  const source = await readFile(join(repoRoot, davSecretFile), "utf8");
  const secretRules = requiredRules.filter((rule) => rule.file === davSecretFile);

  assert.deepEqual(
    secretRules.map((rule) => rule.id),
    [
      "dav-secret-held-in-private-field",
      "dav-secret-redacted-to-string",
      "dav-secret-redacted-to-json",
      "dav-secret-redacted-on-inspect",
    ],
  );
  assert.deepEqual(
    validateSafeLoggingSources(
      { [davSecretFile]: source },
      { forbiddenRules: [], requiredRules: secretRules },
    ),
    [],
  );

  for (const [find, replaceWith, id] of [
    ["readonly #value: string", "readonly value: string", "dav-secret-held-in-private-field"],
    [
      "toString(): string {\n    return REDACTED",
      "toString(): string {\n    return this.#value",
      "dav-secret-redacted-to-string",
    ],
    [
      "toJSON(): string {\n    return REDACTED",
      "toJSON(): string {\n    return this.#value",
      "dav-secret-redacted-to-json",
    ],
    [
      "[Symbol.for('nodejs.util.inspect.custom')](): string {\n    return REDACTED",
      "[Symbol.for('nodejs.util.inspect.custom')](): string {\n    return this.#value",
      "dav-secret-redacted-on-inspect",
    ],
  ]) {
    assert.ok(source.includes(find), `SecretString.ts no longer contains ${find}`);
    assert.deepEqual(
      validateSafeLoggingSources(
        { [davSecretFile]: source.replace(find, replaceWith) },
        { forbiddenRules: [], requiredRules: secretRules },
      ),
      [`${davSecretFile}: missing required contract ${id}`],
    );
  }
});

test("the closed list of DAV bridge log fields has no field that could carry content", () => {
  assert.deepEqual([...davBridgeAllowedLogFields].sort(), [
    "accountId",
    "accounts",
    "adminUuid",
    "audit",
    "changedSettings",
    "durationMs",
    "errorType",
    "ignored",
    "method",
    "purgedAccounts",
    "purgedUsers",
    "reason",
    "requestBytes",
    "responseBytes",
    "scope",
    "status",
    "tag",
    "userId",
  ]);
});
