import assert from "node:assert/strict";
import test from "node:test";

import {
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
