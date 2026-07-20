import assert from "node:assert/strict";
import test from "node:test";

import {
  runDockerHardeningValidation,
  validateComposeHardening,
  validateContainerHardening,
  validateImageHardening,
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
      validateImageHardening("db", { Config: { User: "srn", Healthcheck: healthcheck } }),
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
