import assert from "node:assert/strict";
import test from "node:test";

import {
  runDockerHardeningValidation,
  validateAuthStepUpComposeContract,
  validateAuthStepUpComposeSource,
  validateComposeHardening,
  validateContainerHardening,
  validateImageHardening,
  validatePairingCallbackNginxContract,
  validatePairingComposeContract,
  validatePairingComposeSource,
  validatePairingDockerfileContract,
  validateServerDockerfileContract,
  validateSingleEntrypointAssistantPropagation,
  validateSingleEntrypointAuthStepUpPropagation,
} from "./validate-docker-hardening.mjs";

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
