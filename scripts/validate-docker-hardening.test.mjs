import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  collectSQLiteMigrationSources,
  runDockerHardeningValidation,
  validateAuthStepUpComposeContract,
  validateAuthStepUpComposeSource,
  validateComposeHardening,
  validateContainerHardening,
  validateDatabaseCredentialGateContract,
  validateFilesStorageDeploymentContract,
  validateImageHardening,
  validatePairingCallbackNginxContract,
  validatePairingComposeContract,
  validatePairingComposeSource,
  validatePairingDockerfileContract,
  validateReadinessAcceptanceContract,
  validateReadinessBootContract,
  validateRuntimeLogLevelBootContract,
  validateRuntimeLogLevelDeploymentContract,
  validateServerDockerfileContract,
  validateSingleHomeServerBindContract,
  validateSingleEntrypointAssistantPropagation,
  validateSingleEntrypointAuthStepUpPropagation,
  validateSingleContainerSQLiteMigrationContract,
} from "./validate-docker-hardening.mjs";

test("pins multi-container files storage to the durable writable uploads volume", () => {
  const valid = {
    multiConfig: {
      services: {
        server: {
          volumes: [
            { source: "server-logs", target: "/var/lib/server/logs" },
            { source: "uploads", target: "/opt/shared/uploads" },
          ],
        },
      },
    },
    multiEntrypointSource: `
      if [ -z "$FILES_SERVER_FILE_UPLOAD_PATH" ]; then
        export FILES_SERVER_FILE_UPLOAD_PATH="/opt/shared/uploads"
      fi
    `,
  };

  assert.deepEqual(validateFilesStorageDeploymentContract(valid), []);
  assert.deepEqual(
    validateFilesStorageDeploymentContract({
      multiConfig: valid.multiConfig,
      multiEntrypointSource: valid.multiEntrypointSource.replace(
        'export FILES_SERVER_FILE_UPLOAD_PATH="/opt/shared/uploads"',
        'export FILES_SERVER_FILE_UPLOAD_PATH="/opt/server/packages/files/uploads"',
      ),
    }),
    [
      "multi entrypoint: files storage must default to the shared uploads volume without overriding operators",
    ],
  );
  assert.deepEqual(
    validateFilesStorageDeploymentContract({
      multiConfig: {
        services: {
          server: {
            volumes: [
              { source: "other", target: "/opt/shared/uploads" },
            ],
          },
        },
      },
      multiEntrypointSource: valid.multiEntrypointSource,
    }),
    ["multi compose: files storage path must use the uploads named volume"],
  );
});

test("requires aggregate readiness as the container acceptance path in both topologies", () => {
  const valid = {
    multiDockerfileSource:
      "HEALTHCHECK CMD curl -fsS http://localhost:3000/healthcheck/readiness >/dev/null || exit 1",
    singleDockerfileSource:
      "HEALTHCHECK CMD curl -fsS http://127.0.0.1:8080/healthcheck/readiness >/dev/null || exit 1",
    multiComposeSource:
      'healthcheck:\n  test: ["CMD-SHELL", "curl -fsS http://localhost:3000/healthcheck/readiness >/dev/null || exit 1"]',
    singleComposeSource:
      'healthcheck:\n  test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:8080/healthcheck/readiness >/dev/null || exit 1"]',
  };

  assert.deepEqual(validateReadinessAcceptanceContract(valid), []);

  const broken = Object.fromEntries(
    Object.entries(valid).map(([key, value]) => [
      key,
      value.replace("/healthcheck/readiness", "/healthcheck"),
    ]),
  );
  assert.deepEqual(validateReadinessAcceptanceContract(broken), [
    "multi Dockerfile: container health must use aggregate /healthcheck/readiness",
    "single Dockerfile: container health must use aggregate /healthcheck/readiness",
    "multi compose: container health must use aggregate /healthcheck/readiness",
    "single compose: container health must use aggregate /healthcheck/readiness",
  ]);
});

test("pins the single-container backend to loopback without changing the standalone default", () => {
  const valid = {
    homeServerSource: `
      const bindAddress = env.get('BIND_ADDRESS', true) || undefined
      const serverInstance = listenHomeServer(app, port, bindAddress)
    `,
    singleEntrypointSource: "put BIND_ADDRESS 127.0.0.1",
  };

  assert.deepEqual(validateSingleHomeServerBindContract(valid), []);

  assert.deepEqual(
    validateSingleHomeServerBindContract({
      homeServerSource: valid.homeServerSource.replace(
        "env.get('BIND_ADDRESS', true)",
        "undefined",
      ),
      singleEntrypointSource: valid.singleEntrypointSource.replace(
        "127.0.0.1",
        "0.0.0.0",
      ),
    }),
    [
      "home-server: BIND_ADDRESS must select listen(host) while preserving the default listener",
      "single entrypoint: home-server backend must be pinned to 127.0.0.1",
    ],
  );
});

test("locks aggregate readiness to startup lifecycle, service, worker, and storage signals", () => {
  const valid = {
    homeServerSource: `
      app.get('/healthcheck/readiness', handler)
      await server.build()
    `,
    homeServerRuntimeSource: `
      this.scheduler = options.startScheduler()
      options.readinessState.markReady()
      readinessState?.markUnavailable()
      scheduler?.stop()
    `,
    aggregateReadinessSource: `
      const required = ['auth', 'syncing-server', 'files', 'revisions']
      DEFAULT_CONTROLLABLE_PROGRAMS
      this.options.serviceControlService.getProgramStatuses()
      this.options.state.isReady()
    `,
    filesContainerSource:
      "bind(new S3StorageReadiness())\nbind(new FSStorageReadiness())",
    filesHealthControllerSource:
      "@inject(TYPES.Files_StorageReadiness) storage",
  };
  assert.deepEqual(validateReadinessBootContract(valid), []);

  const broken = structuredClone(valid);
  broken.homeServerSource = broken.homeServerSource.replace(
    "app.get('/healthcheck/readiness', handler)",
    "",
  );
  broken.homeServerRuntimeSource = broken.homeServerRuntimeSource.replace(
    "options.readinessState.markReady()",
    "",
  );
  broken.aggregateReadinessSource = broken.aggregateReadinessSource.replace(
    "getProgramStatuses()",
    "isAvailable()",
  );
  broken.filesContainerSource = broken.filesContainerSource.replace(
    "S3StorageReadiness",
    "UnknownStorage",
  );
  broken.filesHealthControllerSource = "class HealthController {}";

  assert.deepEqual(validateReadinessBootContract(broken), [
    "home-server runtime: readiness must open after scheduler startup and close before resource shutdown",
    "home-server: aggregate readiness route must be deterministic before controller discovery",
    "api-gateway readiness: missing aggregate requirement getProgramStatuses()",
    "files readiness: missing S3StorageReadiness binding",
    "files readiness: controller must require the storage probe",
  ]);
});

test("collects every SQLite migration recursively in deterministic order", () => {
  const root = mkdtempSync(join(tmpdir(), "srn-sqlite-migrations-"));
  const packages = join(root, "packages");
  const firstDirectory = join(
    packages,
    "alpha",
    "migrations",
    "sqlite",
    "nested",
  );
  const secondDirectory = join(packages, "zeta", "migrations", "sqlite");
  mkdirSync(firstDirectory, { recursive: true });
  mkdirSync(secondDirectory, { recursive: true });
  writeFileSync(join(firstDirectory, "002-second.ts"), "second");
  writeFileSync(join(firstDirectory, "001-first.ts"), "first");
  writeFileSync(join(secondDirectory, "003-third.ts"), "third");
  writeFileSync(join(secondDirectory, "ignored.js"), "ignored");

  try {
    assert.deepEqual(collectSQLiteMigrationSources(packages, root), [
      {
        relativePath: join(
          "packages",
          "alpha",
          "migrations",
          "sqlite",
          "nested",
          "001-first.ts",
        ),
        source: "first",
      },
      {
        relativePath: join(
          "packages",
          "alpha",
          "migrations",
          "sqlite",
          "nested",
          "002-second.ts",
        ),
        source: "second",
      },
      {
        relativePath: join(
          "packages",
          "zeta",
          "migrations",
          "sqlite",
          "003-third.ts",
        ),
        source: "third",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts source-owned SQLite migrations without runtime rewriting", () => {
  assert.deepEqual(
    validateSingleContainerSQLiteMigrationContract({
      singleDockerfileSource: "COPY server /opt/server",
      singleEntrypointSource: "exec supervisord -c /etc/supervisord.conf",
      sqliteMigrationSources: [
        {
          relativePath: "safe.ts",
          source: `queryRunner.query("UPDATE items SET content_type = 'Note'")`,
        },
      ],
      legacyShimExists: false,
    }),
    [],
  );
});

test("rejects SQLite migration runtime rewrites and double-quoted SQL values", () => {
  assert.deepEqual(
    validateSingleContainerSQLiteMigrationContract({
      singleDockerfileSource:
        "COPY rewrite-migrations.js /usr/local/bin/fix-sqlite-migrations.js",
      singleEntrypointSource:
        "node /usr/local/bin/fix-sqlite-migrations.js /opt/server/packages/dist/migrations/sqlite",
      sqliteMigrationSources: [
        {
          relativePath: "unsafe.ts",
          source:
            'queryRunner.query(\'UPDATE "items" SET "content_type" = "Note"\')',
        },
      ],
      legacyShimExists: true,
    }),
    [
      "single container SQLite: runtime migration rewrite shim must not exist",
      "single container SQLite: runtime must not invoke the legacy migration rewrite shim",
      "single container SQLite: image build and entrypoint must not mutate compiled migrations",
      "single container SQLite: unsafe.ts uses a double-quoted SQL value",
    ],
  );
});

const validRuntimeLogLevelDeployment = {
  multiComposeSource:
    "SERVER_SETTINGS_PATH: ${SERVER_SETTINGS_PATH:-/opt/server/packages/api-gateway/data/server-settings.json}",
  singleComposeSource:
    "SERVER_SETTINGS_PATH: ${SERVER_SETTINGS_PATH:-/data/server-settings.json}",
  multiEntrypointSource: [
    "API_GATEWAY",
    "AUTH_SERVER",
    "SYNCING_SERVER",
    "FILES_SERVER",
    "REVISIONS_SERVER",
  ]
    .flatMap((prefix) => [
      `export ${prefix}_SERVER_SETTINGS_PATH="$SERVER_SETTINGS_PATH"`,
      `export ${prefix}_LOG_LEVEL="\${LOG_LEVEL:-info}"`,
    ])
    .join("\n"),
  singleEntrypointSource:
    'put SERVER_SETTINGS_PATH "${SERVER_SETTINGS_PATH:-${DATA_DIR}/server-settings.json}"',
};

const validRuntimeLogLevelBoot = {
  serviceContainerSources: Object.fromEntries(
    ["api-gateway", "auth", "syncing-server", "files", "revisions"].map(
      (serviceName) => [
        serviceName,
        `${serviceName === "auth" ? "if (this.mode !== 'cli' && " : "if ("}!configuration?.logger) {
          new RuntimeLogLevelApplier(logger, new ServerSettingsLogLevelResolver(path, baseline)).start()
        }`,
      ],
    ),
  ),
  homeServerSource: `
    private loggerNames = ['auth-server', 'syncing-server', 'revisions-server', 'files-server', 'api-gateway', 'home-server']
    this.loggerNames.map((name) => name)
    this.runtimeLogLevelApplier.start()
    this.runtimeLogLevelApplier?.stop()
  `,
  domainCoreIndexSource: "export * from './Runtime/Logging/RuntimeLogLevel'",
  serverSettingsStoreSource:
    "export const PERSISTED_LOG_LEVELS = RUNTIME_LOG_LEVELS",
  authOverlayReaderSource: "class ServerSettingsOverlayReader {}",
  multiSupervisorSource: [
    "syncing-server",
    "syncing-server-worker",
    "auth",
    "auth-worker",
    "files",
    "files-worker",
    "revisions",
    "revisions-worker",
    "api-gateway",
  ]
    .map((name) => `[program:${name}]`)
    .join("\n"),
  singleSupervisorSource: "[program:home-server]\n[program:nginx]",
};

function composeFixture() {
  const hardened = {
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    mem_limit: "268435456",
    pids_limit: 256,
  };
  return {
    services: {
      app: { ...hardened, ports: [{ target: 8080, published: "3001" }] },
      server: {
        ...hardened,
        volumes: [{ type: "volume", source: "uploads", target: "/uploads" }],
      },
      db: { ...hardened },
      cache: { ...hardened },
      floci: { ...hardened },
    },
  };
}

function databaseCredentialGateFixture() {
  const preflightCommand = `
    case "$\${normalized}" in
      ""|changeme123|change-me-random-hex-32) exit 1 ;;
    esac
    if [ "$\${SRN_DB_APP_PASSWORD}" = "$\${SRN_DB_ROOT_PASSWORD}" ]; then
      exit 1
    fi
  `;
  return {
    multiConfig: {
      services: {
        "db-credential-preflight": {
          image: "mariadb:test",
          restart: "no",
          user: "65534:65534",
          read_only: true,
          network_mode: "none",
          cap_drop: ["ALL"],
          security_opt: ["no-new-privileges:true"],
          mem_limit: 33_554_432,
          pids_limit: 32,
          environment: {
            SRN_DB_APP_PASSWORD: "test-app-password",
            SRN_DB_ROOT_PASSWORD: "test-root-password",
          },
          entrypoint: ["/bin/sh", "-ec"],
          command: [preflightCommand],
        },
        db: {
          image: "mariadb:test",
          depends_on: {
            "db-credential-preflight": {
              condition: "service_completed_successfully",
            },
          },
        },
      },
    },
    multiComposeSource: `
      DB_PASSWORD: \${MYSQL_PASSWORD:?required}
      SRN_DB_APP_PASSWORD: \${MYSQL_PASSWORD:?required}
      SRN_DB_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD:?required}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD:?required}
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD:?required}
    `,
    singleComposeSource:
      "services:\n  app:\n    environment:\n      DB_TYPE: sqlite",
  };
}

function containerFixture(user = "srn:srn") {
  return {
    Config: { User: user },
    HostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 268435456,
      PidsLimit: 256,
    },
    State: { Health: { Status: "healthy" } },
  };
}

const assistantEnvironment = Object.fromEntries(
  [
    "ASSISTANT_ANTHROPIC_API_KEY",
    "ASSISTANT_OPENAI_API_KEY",
    "ASSISTANT_OPENAI_BASE_URL",
    "ASSISTANT_OPENAI_MODEL",
    "ASSISTANT_OLLAMA_URL",
    "ASSISTANT_DEFAULT_PROVIDER",
    "ASSISTANT_DEFAULT_MODEL",
    "ASSISTANT_DAILY_REQUEST_LIMIT",
    "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY",
    "ASSISTANT_SUBSCRIPTION_TOKEN_PATH",
    "ASSISTANT_CHATGPT_OAUTH_AUTHORIZE_URL",
    "ASSISTANT_CHATGPT_OAUTH_TOKEN_URL",
    "ASSISTANT_CHATGPT_OAUTH_CLIENT_ID",
    "ASSISTANT_CHATGPT_OAUTH_REDIRECT_URI",
    "ASSISTANT_CHATGPT_OAUTH_SCOPES",
    "ASSISTANT_CHATGPT_OAUTH_ACCOUNT_ID_CLAIM",
    "ASSISTANT_OPENAI_AUTH_MODE",
    "ASSISTANT_OPENAI_SUBSCRIPTION_TOKEN",
    "ASSISTANT_OPENAI_SUBSCRIPTION_BASE_URL",
    "ASSISTANT_OPENAI_ACCOUNT_ID",
    "ASSISTANT_OPENAI_BETA",
    "ASSISTANT_OPENAI_EXTRA_HEADERS",
    "PUBLIC_URL",
  ].map((key) => [key, ""]),
);

function pairingComposeFixture({
  serviceName = "server",
  dataTarget = "/opt/server/packages/api-gateway/data",
  volumeSource = "server-data",
} = {}) {
  return {
    services: {
      [serviceName]: {
        environment: {
          ...assistantEnvironment,
          ASSISTANT_SUBSCRIPTION_TOKEN_PATH: `${dataTarget}/assistant-subscription.json`,
        },
        volumes: [
          {
            type: "volume",
            source: volumeSource,
            target: dataTarget,
          },
        ],
      },
    },
  };
}

test("accepts an installed executable srn-admin wrapper", () => {
  assert.deepEqual(
    validateServerDockerfileContract(`
      FROM node:26-alpine AS build
      RUN chmod +x /usr/local/bin/srn-admin
      FROM node:26-alpine AS runtime
      COPY docker/srn-admin.sh /usr/local/bin/srn-admin
      RUN chmod +x /usr/local/bin/docker-entrypoint.sh \\
        /usr/local/bin/srn-admin
      USER srn:srn
    `),
    [],
  );
  assert.deepEqual(
    validateServerDockerfileContract(`
      FROM node:26-alpine
      COPY --chmod=0755 docker/srn-admin.sh /usr/local/bin/srn-admin
      USER srn:srn
    `),
    [],
  );
});

test("requires one runtime settings path and environment baseline across every deployed server process", () => {
  assert.deepEqual(
    validateRuntimeLogLevelDeploymentContract(validRuntimeLogLevelDeployment),
    [],
  );

  const broken = structuredClone(validRuntimeLogLevelDeployment);
  broken.multiEntrypointSource = broken.multiEntrypointSource
    .replace(
      'export FILES_SERVER_SERVER_SETTINGS_PATH="$SERVER_SETTINGS_PATH"',
      "",
    )
    .replace(
      'export REVISIONS_SERVER_LOG_LEVEL="${LOG_LEVEL:-info}"',
      'export REVISIONS_SERVER_LOG_LEVEL="info"',
    );
  broken.singleEntrypointSource =
    'put SERVER_SETTINGS_PATH "${DATA_DIR}/server-settings.json"';

  assert.deepEqual(validateRuntimeLogLevelDeploymentContract(broken), [
    "multi entrypoint: must write the shared SERVER_SETTINGS_PATH into FILES_SERVER package env",
    "multi entrypoint: REVISIONS_SERVER LOG_LEVEL must fall back to the shared process baseline",
    "single entrypoint: must preserve an explicit SERVER_SETTINGS_PATH and otherwise use DATA_DIR",
  ]);
});

test("locks runtime log-level boot wiring to the actual supervisor topologies", () => {
  assert.deepEqual(
    validateRuntimeLogLevelBootContract(validRuntimeLogLevelBoot),
    [],
  );

  const broken = structuredClone(validRuntimeLogLevelBoot);
  broken.serviceContainerSources.files = "const logger = createLogger()";
  broken.homeServerSource = broken.homeServerSource.replace(
    "this.runtimeLogLevelApplier?.stop()",
    "",
  );
  broken.multiSupervisorSource += "\n[program:websockets]";
  broken.serverSettingsStoreSource =
    "export const PERSISTED_LOG_LEVELS = ['info', 'debug']";
  broken.authOverlayReaderSource = "static VALID_LOG_LEVELS = ['info']";

  assert.deepEqual(validateRuntimeLogLevelBootContract(broken), [
    "multi supervisor: runtime logging contract must track exact deployed programs (got syncing-server, syncing-server-worker, auth, auth-worker, files, files-worker, revisions, revisions-worker, api-gateway, websockets)",
    "files container: must use the shared runtime log-level reader and applier",
    "files container: must defer injected loggers to the home-server poller",
    "home-server: missing runtime poller lifecycle contract this.runtimeLogLevelApplier?.stop()",
    "api-gateway settings: persisted log levels must use the shared runtime list",
    "auth overlay: must not retain a second runtime log-level validation policy",
  ]);
});

test("rejects a missing or non-executable srn-admin wrapper", () => {
  assert.deepEqual(validateServerDockerfileContract("FROM node:26-alpine"), [
    "server Dockerfile: must install docker/srn-admin.sh as /usr/local/bin/srn-admin",
    "server Dockerfile: /usr/local/bin/srn-admin must be executable",
  ]);
  assert.deepEqual(
    validateServerDockerfileContract(`
      COPY docker/srn-admin.sh /usr/local/bin/srn-admin
      RUN chmod +x /usr/local/bin/docker-entrypoint.sh
    `),
    ["server Dockerfile: /usr/local/bin/srn-admin must be executable"],
  );
  assert.deepEqual(
    validateServerDockerfileContract(`
      FROM node:26-alpine
      RUN chmod +x /usr/local/bin/srn-admin
      COPY docker/srn-admin.sh /usr/local/bin/srn-admin
      USER srn:srn
    `),
    ["server Dockerfile: /usr/local/bin/srn-admin must be executable"],
  );
  assert.deepEqual(
    validateServerDockerfileContract(`
      FROM node:26-alpine AS build
      COPY --chmod=0755 docker/srn-admin.sh /usr/local/bin/srn-admin
      FROM node:26-alpine AS runtime
    `),
    [
      "server Dockerfile: must install docker/srn-admin.sh as /usr/local/bin/srn-admin",
      "server Dockerfile: /usr/local/bin/srn-admin must be executable",
    ],
  );
});

test("srn-admin wrapper uses the generated home-server env directory without sourcing it", () => {
  const shellPath = (value) => {
    if (process.platform !== "win32") {
      return value;
    }
    const normalized = value.replaceAll("\\", "/");
    return `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
  };
  const fixtureRoot = mkdtempSync(join(tmpdir(), "srn-admin-wrapper-"));
  const authDir = join(fixtureRoot, "packages", "auth");
  const homeServerDir = join(fixtureRoot, "packages", "home-server");
  const resultDir = join(fixtureRoot, "result");
  const fakeNode = join(fixtureRoot, "fake-node.sh");
  const sentinel = join(fixtureRoot, "env-was-evaluated");
  const wrapper = shellPath(resolve("server/docker/srn-admin.sh"));
  const shellFixtureRoot = shellPath(fixtureRoot);
  const shellAuthDir = shellPath(authDir);
  const shellHomeServerDir = shellPath(homeServerDir);
  const shellFakeNode = shellPath(fakeNode);
  const shellSentinel = shellPath(sentinel);
  const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const runWrapper = (args) =>
    execFileSync(
      "bash",
      [
        "-lc",
        `export SRN_SERVER_ROOT=${shellQuote(shellFixtureRoot)} SRN_ADMIN_NODE_BIN=${shellQuote(shellFakeNode)}; exec ${[wrapper, ...args].map(shellQuote).join(" ")}`,
      ],
      { env: process.env },
    );

  try {
    mkdirSync(join(authDir, "dist", "bin"), { recursive: true });
    mkdirSync(homeServerDir, { recursive: true });
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(fixtureRoot, ".pnp.cjs"), "");
    writeFileSync(join(authDir, "dist", "bin", "srn_admin.js"), "");
    writeFileSync(
      join(homeServerDir, ".env"),
      `UNTRUSTED=\$(touch ${shellSentinel})\n`,
    );
    writeFileSync(
      fakeNode,
      `#!/bin/sh\nprintf '%s' "$PWD" > "${shellPath(join(resultDir, "cwd"))}"\nprintf '%s\\n' "$@" > "${shellPath(join(resultDir, "args"))}"\n`,
    );
    chmodSync(fakeNode, 0o755);

    runWrapper(["roles", "grant", "person@example.com", "ADMIN_USER"]);

    assert.equal(
      readFileSync(join(resultDir, "cwd"), "utf8"),
      shellHomeServerDir,
    );
    assert.deepEqual(
      readFileSync(join(resultDir, "args"), "utf8").trim().split("\n"),
      [
        `${shellFixtureRoot}/.yarn/releases/yarn-4.17.1.cjs`,
        "node",
        `${shellAuthDir}/dist/bin/srn_admin.js`,
        "roles",
        "grant",
        "person@example.com",
        "ADMIN_USER",
      ],
    );
    assert.equal(
      existsSync(sentinel),
      false,
      "the wrapper must never evaluate .env as shell",
    );

    unlinkSync(join(homeServerDir, ".env"));
    runWrapper(["roles", "list"]);
    assert.equal(readFileSync(join(resultDir, "cwd"), "utf8"), shellAuthDir);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("requires the multi image to create and own the persistent gateway data directory", () => {
  const valid = `
    FROM node:26-alpine
    RUN mkdir -p /opt/server/packages/api-gateway/data \\
      && chown -R srn:srn /opt/server
    USER srn:srn
  `;
  assert.deepEqual(validatePairingDockerfileContract(valid), []);
  assert.deepEqual(
    validatePairingDockerfileContract(`
      FROM node:26-alpine
      RUN mkdir -p /opt/server/packages/api-gateway/data
      USER srn:srn
      RUN chown -R srn:srn /opt/server
    `),
    [
      "server Dockerfile: must make /opt/server/packages/api-gateway/data writable by srn before USER",
    ],
  );
  assert.deepEqual(
    validatePairingDockerfileContract("FROM node:26-alpine\nUSER srn:srn"),
    [
      "server Dockerfile: must create /opt/server/packages/api-gateway/data before USER srn",
      "server Dockerfile: must make /opt/server/packages/api-gateway/data writable by srn before USER",
    ],
  );
});

test("accepts the complete multi and single pairing propagation matrix", () => {
  assert.deepEqual(
    validatePairingComposeContract(pairingComposeFixture(), {
      serviceName: "server",
      label: "multi compose",
      dataTarget: "/opt/server/packages/api-gateway/data",
      expectedVolumeSource: "server-data",
    }),
    [],
  );
  assert.deepEqual(
    validatePairingComposeContract(
      pairingComposeFixture({
        serviceName: "app",
        dataTarget: "/data",
        volumeSource: "single-data",
      }),
      {
        serviceName: "app",
        label: "single compose",
        dataTarget: "/data",
        expectedVolumeSource: "single-data",
      },
    ),
    [],
  );
});

test("requires secure auth step-up thresholds in multi and single runtime environments", () => {
  for (const serviceName of ["server", "app"]) {
    const config = {
      services: {
        [serviceName]: {
          environment: {
            APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2: "0.0.0",
            APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3: "0.0.0",
          },
        },
      },
    };

    assert.deepEqual(
      validateAuthStepUpComposeContract(config, {
        serviceName,
        label: `${serviceName} compose`,
      }),
      [],
    );

    delete config.services[serviceName].environment
      .APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3;
    assert.deepEqual(
      validateAuthStepUpComposeContract(config, {
        serviceName,
        label: `${serviceName} compose`,
      }),
      [
        `${serviceName} compose ${serviceName}: must propagate APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3`,
      ],
    );
  }
});

test("requires operator-overridable secure defaults in raw Compose and the single entrypoint", () => {
  const composeSource = `
    APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2: \${APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2:-0.0.0}
    APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3: \${APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3:-0.0.0}
  `;
  const entrypointSource = `
    put APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2 "\${APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2:-0.0.0}"
    put APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3 "\${APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3:-0.0.0}"
  `;

  assert.deepEqual(
    validateAuthStepUpComposeSource(composeSource, {
      label: "single compose",
    }),
    [],
  );
  assert.deepEqual(
    validateSingleEntrypointAuthStepUpPropagation(entrypointSource),
    [],
  );

  assert.match(
    validateAuthStepUpComposeSource(
      composeSource.replace(
        /^.*APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3.*$/m,
        "",
      ),
      { label: "single compose" },
    ).join("\n"),
    /TOKEN_VERSION_3/,
  );
  assert.match(
    validateSingleEntrypointAuthStepUpPropagation(
      entrypointSource.replace(
        /^.*APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2.*$/m,
        "",
      ),
    ).join("\n"),
    /TOKEN_VERSION_2/,
  );
});

test("rejects missing assistant propagation, an ephemeral token path, or the wrong data volume", () => {
  const config = pairingComposeFixture();
  delete config.services.server.environment.ASSISTANT_DEFAULT_MODEL;
  config.services.server.environment.ASSISTANT_SUBSCRIPTION_TOKEN_PATH =
    "/tmp/assistant-subscription.json";
  config.services.server.volumes[0].source = "wrong-volume";

  assert.deepEqual(
    validatePairingComposeContract(config, {
      serviceName: "server",
      label: "multi compose",
      dataTarget: "/opt/server/packages/api-gateway/data",
      expectedVolumeSource: "server-data",
    }),
    [
      "multi compose server: must propagate ASSISTANT_DEFAULT_MODEL",
      "multi compose server: pairing token path must stay inside /opt/server/packages/api-gateway/data",
      "multi compose server: /opt/server/packages/api-gateway/data must use the server-data named volume",
    ],
  );
});

test("rejects traversal and sibling-prefix pairing paths outside the mounted data directory", () => {
  for (const tokenPath of [
    "/data/../../tmp/pairing.json",
    "/data-backup/pairing.json",
  ]) {
    const config = pairingComposeFixture({
      serviceName: "app",
      dataTarget: "/data",
      volumeSource: "single-data",
    });
    config.services.app.environment.ASSISTANT_SUBSCRIPTION_TOKEN_PATH =
      tokenPath;

    assert.deepEqual(
      validatePairingComposeContract(config, {
        serviceName: "app",
        label: "single compose",
        dataTarget: "/data",
        expectedVolumeSource: "single-data",
      }),
      ["single compose app: pairing token path must stay inside /data"],
    );
  }
});

test("requires raw Compose to default PUBLIC_URL empty and pairing state into its named-volume path", () => {
  const valid = `
    PUBLIC_URL: \${PUBLIC_URL:-}
    ASSISTANT_SUBSCRIPTION_TOKEN_PATH: \${ASSISTANT_SUBSCRIPTION_TOKEN_PATH:-/data/assistant-subscription.json}
  `;
  assert.deepEqual(
    validatePairingComposeSource(valid, {
      label: "single compose",
      defaultTokenPath: "/data/assistant-subscription.json",
    }),
    [],
  );
  assert.deepEqual(
    validatePairingComposeSource(
      `
        PUBLIC_URL: \${PUBLIC_URL:-http://localhost:3001}
        ASSISTANT_SUBSCRIPTION_TOKEN_PATH: \${ASSISTANT_SUBSCRIPTION_TOKEN_PATH:-/tmp/pairing.json}
      `,
      {
        label: "single compose",
        defaultTokenPath: "/data/assistant-subscription.json",
      },
    ),
    [
      "single compose: PUBLIC_URL must have an explicit empty default (no localhost fallback)",
      "single compose: pairing token path must default to /data/assistant-subscription.json",
    ],
  );
});

test("requires the single entrypoint to write every Compose assistant variable and persistent token path", () => {
  const source = Object.keys(assistantEnvironment)
    .filter((key) => key.startsWith("ASSISTANT_"))
    .map((key) =>
      key === "ASSISTANT_SUBSCRIPTION_TOKEN_PATH"
        ? 'put ASSISTANT_SUBSCRIPTION_TOKEN_PATH "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH:-${DATA_DIR}/assistant-subscription.json}"'
        : `put_opt ${key} "\${${key}:-}"`,
    )
    .concat('put_opt PUBLIC_URL "${PUBLIC_URL:-}"')
    .join("\n");
  assert.deepEqual(validateSingleEntrypointAssistantPropagation(source), []);
  assert.match(
    validateSingleEntrypointAssistantPropagation(
      source.replace(/^put_opt ASSISTANT_OPENAI_MODEL.*$/m, ""),
    ).join("\n"),
    /ASSISTANT_OPENAI_MODEL/,
  );
});

test("requires an exact OAuth callback proxy location with access logging disabled", () => {
  const block = `
    location = /v1/assistant/subscription/callback {
      access_log off;
      proxy_pass http://127.0.0.1:3000;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Real-IP $remote_addr;
      client_max_body_size 0;
      proxy_request_buffering off;
      proxy_read_timeout 300s;
    }
  `;
  assert.deepEqual(
    validatePairingCallbackNginxContract(block, {
      label: "single nginx",
      proxyPass: "http://127.0.0.1:3000",
    }),
    [],
  );
  assert.deepEqual(
    validatePairingCallbackNginxContract(
      block.replace("access_log off;", "access_log combined;"),
      {
        label: "single nginx",
        proxyPass: "http://127.0.0.1:3000",
      },
    ),
    ["single nginx: callback location must disable access logging"],
  );
});

test("accepts the hardened default Compose shape", () => {
  assert.deepEqual(validateComposeHardening(composeFixture()), []);
});

test("accepts fail-closed MariaDB credential gating without changing SQLite", () => {
  assert.deepEqual(
    validateDatabaseCredentialGateContract(databaseCredentialGateFixture()),
    [],
  );
});

test("rejects missing or fallback MariaDB password interpolation", () => {
  const serverFallback = databaseCredentialGateFixture();
  serverFallback.multiComposeSource = serverFallback.multiComposeSource.replace(
    "DB_PASSWORD: ${MYSQL_PASSWORD:?required}",
    "DB_PASSWORD: ${MYSQL_PASSWORD:-changeme123}",
  );
  assert.match(
    validateDatabaseCredentialGateContract(serverFallback).join("\n"),
    /server DB_PASSWORD must use required, non-empty interpolation/,
  );

  const rootFallback = databaseCredentialGateFixture();
  rootFallback.multiComposeSource = rootFallback.multiComposeSource.replace(
    "MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:?required}",
    "MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-changeme123}",
  );
  assert.match(
    validateDatabaseCredentialGateContract(rootFallback).join("\n"),
    /MariaDB MYSQL_ROOT_PASSWORD must use required, non-empty interpolation/,
  );
});

test("rejects a bypassable or secret-logging database credential preflight", () => {
  const missingPlaceholder = databaseCredentialGateFixture();
  missingPlaceholder.multiConfig.services[
    "db-credential-preflight"
  ].command[0] = missingPlaceholder.multiConfig.services[
    "db-credential-preflight"
  ].command[0].replace("changeme123", "not-the-published-default");
  assert.match(
    validateDatabaseCredentialGateContract(missingPlaceholder).join("\n"),
    /must reject published placeholder changeme123/,
  );

  const logging = databaseCredentialGateFixture();
  logging.multiConfig.services["db-credential-preflight"].command[0] +=
    '\necho "$${SRN_DB_APP_PASSWORD}"';
  assert.match(
    validateDatabaseCredentialGateContract(logging).join("\n"),
    /must not log credential values/,
  );

  const profiled = databaseCredentialGateFixture();
  profiled.multiConfig.services["db-credential-preflight"].profiles = ["prod"];
  assert.match(
    validateDatabaseCredentialGateContract(profiled).join("\n"),
    /must not be hidden behind a profile/,
  );
});

test("rejects a database that can start without successful credential preflight", () => {
  const fixture = databaseCredentialGateFixture();
  fixture.multiConfig.services.db.depends_on[
    "db-credential-preflight"
  ].condition = "service_started";
  assert.deepEqual(validateDatabaseCredentialGateContract(fixture), [
    "multi compose db: must wait for successful database credential preflight",
  ]);
});

test("keeps the single-container SQLite topology independent of MariaDB secrets", () => {
  const fixture = databaseCredentialGateFixture();
  fixture.singleComposeSource +=
    "\nMYSQL_PASSWORD: ${MYSQL_PASSWORD:?required}";
  assert.deepEqual(validateDatabaseCredentialGateContract(fixture), [
    "single compose: SQLite topology must remain independent of MariaDB credentials",
  ]);
});

test("requires a least-privilege, networkless database credential preflight", () => {
  const fixture = databaseCredentialGateFixture();
  const preflight = fixture.multiConfig.services["db-credential-preflight"];
  preflight.image = "busybox:latest";
  preflight.restart = "always";
  preflight.user = "root";
  preflight.read_only = false;
  preflight.network_mode = "default";
  preflight.cap_drop = [];
  preflight.security_opt = [];
  preflight.mem_limit = 0;
  preflight.pids_limit = 0;

  assert.deepEqual(validateDatabaseCredentialGateContract(fixture), [
    "multi compose db-credential-preflight: must reuse the MariaDB image",
    "multi compose db-credential-preflight: restart policy must be no",
    "multi compose db-credential-preflight: root filesystem must be read-only",
    "multi compose db-credential-preflight: must run as the unprivileged numeric user 65534:65534",
    "multi compose db-credential-preflight: network mode must be none",
    "multi compose db-credential-preflight: must drop ALL capabilities",
    "multi compose db-credential-preflight: must set no-new-privileges:true",
    "multi compose db-credential-preflight: must set a positive memory limit",
    "multi compose db-credential-preflight: must set a positive PID limit",
  ]);
});

test("rejects a missing capability drop and resource limits", () => {
  const config = composeFixture();
  config.services.cache.cap_drop = [];
  config.services.cache.mem_limit = 0;
  config.services.cache.pids_limit = 0;
  assert.deepEqual(validateComposeHardening(config), [
    "compose cache: must drop ALL capabilities",
    "compose cache: must set a positive memory limit",
    "compose cache: must set a positive PID limit",
  ]);
});

test("rejects an internal database port and raw server Docker socket", () => {
  const config = composeFixture();
  config.services.db.ports = [{ target: 3306, published: "3306" }];
  config.services.server.volumes.push({
    type: "bind",
    source: "/var/run/docker.sock",
    target: "/var/run/docker.sock",
  });
  assert.deepEqual(validateComposeHardening(config), [
    "compose db: must not publish host ports",
    "compose server: raw Docker socket must not be mounted",
  ]);
});

test("requires non-root application images with healthchecks", () => {
  assert.deepEqual(
    validateImageHardening("app", { Config: { User: "root" } }),
    [
      "image app: runtime user must be non-root",
      "image app: healthcheck is missing",
    ],
  );
  assert.deepEqual(
    validateImageHardening("server", {
      Config: { User: "srn:srn", Healthcheck: { Test: ["CMD", "true"] } },
    }),
    [],
  );
});

test("accepts a healthy, bounded, least-privilege container", () => {
  assert.deepEqual(
    validateContainerHardening("server", containerFixture()),
    [],
  );
});

test("rejects privileged, unhealthy, or root application containers", () => {
  const inspect = containerFixture("0");
  inspect.HostConfig.Privileged = true;
  inspect.HostConfig.SecurityOpt = [];
  inspect.State.Health.Status = "unhealthy";
  assert.deepEqual(validateContainerHardening("app", inspect), [
    "container app: privileged mode must be disabled",
    "container app: must set no-new-privileges:true",
    "container app: expected healthy state, got unhealthy",
    "container app: runtime user must be non-root",
  ]);
});

test("reports a missing required Compose service without cascading checks", () => {
  const config = composeFixture();
  delete config.services.floci;
  assert.deepEqual(validateComposeHardening(config), [
    "compose: missing required floci service",
  ]);
});

test("reports every hardening failure when there are no services at all", () => {
  assert.deepEqual(validateComposeHardening({}), [
    "compose: missing required app service",
    "compose: missing required server service",
    "compose: missing required db service",
    "compose: missing required cache service",
    "compose: missing required floci service",
  ]);
  assert.deepEqual(validateComposeHardening(undefined), [
    "compose: missing required app service",
    "compose: missing required server service",
    "compose: missing required db service",
    "compose: missing required cache service",
    "compose: missing required floci service",
  ]);
});

test("accepts capability and security options in any letter case", () => {
  const config = composeFixture();
  config.services.db.cap_drop = ["all"];
  config.services.db.security_opt = ["No-New-Privileges:TRUE"];
  assert.deepEqual(validateComposeHardening(config), []);
});

test("rejects non-numeric, blank and negative resource limits", () => {
  for (const limit of ["", "   ", "abc", -1, null, undefined, {}]) {
    const config = composeFixture();
    config.services.db.mem_limit = limit;
    assert.deepEqual(validateComposeHardening(config), [
      "compose db: must set a positive memory limit",
    ]);
  }
});

test("rejects non-array capability and security option fields", () => {
  const config = composeFixture();
  config.services.db.cap_drop = "ALL";
  config.services.db.security_opt = "no-new-privileges:true";
  assert.deepEqual(validateComposeHardening(config), [
    "compose db: must drop ALL capabilities",
    "compose db: must set no-new-privileges:true",
  ]);
});

test("detects the raw Docker socket in short-form string volumes", () => {
  const config = composeFixture();
  config.services.server.volumes = [
    "/var/run/docker.sock:/var/run/docker.sock:ro",
  ];
  assert.deepEqual(validateComposeHardening(config), [
    "compose server: raw Docker socket must not be mounted",
  ]);
});

test("allows other bind mounts and volumes with no source", () => {
  const config = composeFixture();
  config.services.server.volumes = ["/srv/data:/data", {}, { source: "logs" }];
  assert.deepEqual(validateComposeHardening(config), []);
});

test("does not require a non-root user for non-application images", () => {
  assert.deepEqual(
    validateImageHardening("db", {
      Config: { User: "root", Healthcheck: { Test: ["CMD", "true"] } },
    }),
    [],
  );
});

test("treats a blank, zero or 0:0 image user as root", () => {
  for (const user of ["", "   ", "0", "root", "ROOT", "0:0"]) {
    assert.deepEqual(
      validateImageHardening("app", {
        Config: { User: user, Healthcheck: { Test: ["CMD", "true"] } },
      }),
      ["image app: runtime user must be non-root"],
    );
  }
});

test("rejects an image whose healthcheck test list is empty or not a list", () => {
  for (const healthcheck of [{ Test: [] }, { Test: "CMD true" }, undefined]) {
    assert.deepEqual(
      validateImageHardening("db", {
        Config: { User: "srn", Healthcheck: healthcheck },
      }),
      ["image db: healthcheck is missing"],
    );
  }
});

test("treats a missing image inspection as fully unhardened", () => {
  assert.deepEqual(validateImageHardening("app", undefined), [
    "image app: runtime user must be non-root",
    "image app: healthcheck is missing",
  ]);
});

test("rejects a container missing capability drops and resource limits", () => {
  const inspect = containerFixture();
  inspect.HostConfig.CapDrop = [];
  inspect.HostConfig.Memory = 0;
  inspect.HostConfig.PidsLimit = 0;
  assert.deepEqual(validateContainerHardening("db", inspect), [
    "container db: must drop ALL capabilities",
    "container db: memory limit is missing",
    "container db: PID limit is missing",
  ]);
});

test("reports a missing health status by name", () => {
  const inspect = containerFixture();
  delete inspect.State.Health;
  assert.deepEqual(validateContainerHardening("db", inspect), [
    "container db: expected healthy state, got missing",
  ]);
});

test("treats a missing container inspection as fully unhardened", () => {
  assert.deepEqual(validateContainerHardening("app", undefined), [
    "container app: privileged mode must be disabled",
    "container app: must drop ALL capabilities",
    "container app: must set no-new-privileges:true",
    "container app: memory limit is missing",
    "container app: PID limit is missing",
    "container app: expected healthy state, got missing",
    "container app: runtime user must be non-root",
  ]);
});

test("does not require a non-root user for non-application containers", () => {
  const inspect = containerFixture("root");
  assert.deepEqual(validateContainerHardening("cache", inspect), []);
});

test("CLI prints usage for --help and -h without invoking Docker", () => {
  const logged = [];
  const originalLog = console.log;
  console.log = (message) => logged.push(message);
  try {
    for (const flag of ["--help", "-h"]) {
      assert.deepEqual(runDockerHardeningValidation([flag]), {
        composeServices: 0,
        images: 0,
        containers: 0,
      });
    }
  } finally {
    console.log = originalLog;
  }
  assert.equal(logged.length, 2);
  assert.match(
    logged[0],
    /^Usage: node scripts\/validate-docker-hardening\.mjs/,
  );
});

test("CLI rejects unknown arguments before touching Docker", () => {
  assert.throws(
    () => runDockerHardeningValidation(["--bogus"]),
    /Unknown argument: --bogus/,
  );
});

test("CLI requires service=target for --image and --container", () => {
  for (const flag of ["--image", "--container"]) {
    assert.throws(
      () => runDockerHardeningValidation([flag]),
      new RegExp(`${flag} requires service=target`),
    );
    for (const value of ["noseparator", "=target", "service="]) {
      assert.throws(
        () => runDockerHardeningValidation([flag, value]),
        new RegExp(`${flag} requires service=target`),
      );
    }
  }
});
