import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import {
  applyEnvironmentOverrides,
  classifyOccupant,
  decideCollisionAction,
  detectDesktopInstances,
  expandTargets,
  formatInspection,
  inspectPort,
  parseArgs,
  parseDeploymentMarker,
  parseDotEnv,
  parseLsofListeners,
  parseNetstatListeners,
  parseTasklistCsv,
  probeConnect,
  probeInstanceIdentity,
  probePortBinding,
  resolveLaunchPort,
  selectDesktopProcesses,
} from "./detect-running-instance.mjs";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withRawListener(run) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("probePortBinding reports an occupied port as unbindable", async () => {
  await withRawListener(async (port) => {
    assert.deepEqual(await probePortBinding({ port }), {
      bindable: false,
      code: "EADDRINUSE",
    });
  });
});

test("probePortBinding reports a free port as bindable", async () => {
  const port = await withRawListener((taken) => taken);
  assert.equal((await probePortBinding({ port })).bindable, true);
});

test("probeConnect distinguishes a live listener from a closed port", async () => {
  const freed = await withRawListener(async (port) => {
    assert.equal(await probeConnect({ port, timeoutMs: 1000 }), true);
    return port;
  });
  assert.equal(await probeConnect({ port: freed, timeoutMs: 1000 }), false);
});

test("parseDeploymentMarker accepts the marker shape and rejects everything else", () => {
  assert.deepEqual(
    parseDeploymentMarker(`{"revision":"${revisionA}","version":"1.2.3"}`),
    { revision: revisionA, version: "1.2.3" },
  );
  assert.deepEqual(parseDeploymentMarker('{"revision":"","version":""}'), {
    revision: "",
    version: "",
  });
  assert.equal(parseDeploymentMarker("<html>not json</html>"), null);
  assert.equal(parseDeploymentMarker('{"revision":1,"version":"x"}'), null);
  assert.equal(parseDeploymentMarker("[]"), null);
});

test("probeInstanceIdentity reads the marker and healthcheck from a live server", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/.well-known/srn-deployment.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`{"revision":"${revisionA}","version":"1.0.0"}`);
        return;
      }
      response.writeHead(request.url === "/healthcheck" ? 200 : 404);
      response.end("");
    },
    async (port) => {
      const identity = await probeInstanceIdentity({ port, timeoutMs: 2000 });
      assert.deepEqual(identity.marker, {
        revision: revisionA,
        version: "1.0.0",
      });
      assert.equal(identity.healthcheckStatus, 200);
      assert.equal(identity.spokeHttp, true);
    },
  );
});

test("probeInstanceIdentity survives an occupant that is not HTTP at all", async () => {
  await withRawListener(async (port) => {
    const identity = await probeInstanceIdentity({ port, timeoutMs: 1000 });
    assert.equal(identity.marker, null);
    assert.equal(identity.healthcheckStatus, null);
    assert.equal(identity.spokeHttp, false);
  });
});

test("classifyOccupant: nothing listening is free", () => {
  const result = classifyOccupant({ reachable: false, identity: null });
  assert.equal(result.kind, "free");
  assert.equal(result.ours, false);
});

test("classifyOccupant: an unrelated server is foreign, not ours", () => {
  const result = classifyOccupant({
    reachable: true,
    identity: { marker: null, healthcheckStatus: 404, spokeHttp: true },
    expectedRevision: revisionA,
  });
  assert.equal(result.kind, "foreign");
  assert.equal(result.ours, false);
  assert.equal(result.severity, "notice");
});

test("classifyOccupant: matching build is ours and reported, not silently accepted", () => {
  const result = classifyOccupant({
    reachable: true,
    identity: {
      marker: { revision: revisionA, version: "1.0.0" },
      healthcheckStatus: 200,
    },
    expectedRevision: revisionA,
  });
  assert.equal(result.kind, "ours-matching");
  assert.equal(result.ours, true);
  assert.equal(result.revision, revisionA);
});

test("classifyOccupant: a different build is critical", () => {
  const result = classifyOccupant({
    reachable: true,
    identity: {
      marker: { revision: revisionB, version: "1.0.0" },
      healthcheckStatus: 200,
    },
    expectedRevision: revisionA,
  });
  assert.equal(result.kind, "ours-different-build");
  assert.equal(result.severity, "critical");
  assert.match(result.summary, /DIFFERENT build/);
});

test("classifyOccupant: an unstamped build is ours with an unknowable commit", () => {
  const result = classifyOccupant({
    reachable: true,
    identity: {
      marker: { revision: "", version: "unstamped" },
      healthcheckStatus: 200,
    },
    expectedRevision: revisionA,
  });
  assert.equal(result.kind, "ours-unidentified");
  assert.equal(result.severity, "critical");
  assert.equal(result.ours, true);
});

test("classifyOccupant: empty marker strings from a pre-marker build stay critical", () => {
  const result = classifyOccupant({
    reachable: true,
    identity: {
      marker: { revision: "", version: "" },
      healthcheckStatus: 200,
    },
    expectedRevision: revisionA,
  });
  assert.equal(result.kind, "ours-unidentified");
  assert.equal(result.severity, "critical");
});

test("classifyOccupant: healthcheck without a marker is the legacy-instance case", () => {
  const result = classifyOccupant({
    reachable: true,
    identity: { marker: null, healthcheckStatus: 200, spokeHttp: true },
    expectedRevision: revisionA,
  });
  assert.equal(result.kind, "ours-legacy");
  assert.equal(result.severity, "critical");
  assert.equal(result.ours, true);
});

test("classifyOccupant: a known build with no expected revision cannot be compared", () => {
  const result = classifyOccupant({
    reachable: true,
    identity: {
      marker: { revision: revisionA, version: "1.0.0" },
      healthcheckStatus: 200,
    },
    expectedRevision: null,
  });
  assert.equal(result.kind, "ours-known-build");
  assert.equal(result.severity, "warning");
});

test("decideCollisionAction never moves off a port our own app holds", () => {
  for (const kind of [
    "ours-matching",
    "ours-different-build",
    "ours-unidentified",
    "ours-legacy",
    "ours-known-build",
  ]) {
    const decision = decideCollisionAction({
      classification: { kind, ours: true },
      adjustable: true,
    });
    assert.equal(decision.action, "stop", `${kind} must stop`);
  }
});

test("decideCollisionAction adjusts only past unrelated occupants", () => {
  assert.equal(
    decideCollisionAction({
      classification: { kind: "foreign", ours: false },
      adjustable: true,
    }).action,
    "adjust",
  );
  assert.equal(
    decideCollisionAction({
      classification: { kind: "foreign", ours: false },
      adjustable: false,
    }).action,
    "stop",
  );
  assert.equal(
    decideCollisionAction({
      classification: { kind: "free", ours: false },
      adjustable: false,
    }).action,
    "proceed",
  );
});

test("inspectPort identifies our app on a live port", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/.well-known/srn-deployment.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`{"revision":"${revisionB}","version":"dev"}`);
        return;
      }
      response.writeHead(200);
      response.end("");
    },
    async (port) => {
      const inspection = await inspectPort({
        port,
        expectedRevision: revisionA,
        timeoutMs: 2000,
        identifyProcess: false,
      });
      assert.equal(inspection.bindable, false);
      assert.equal(inspection.reachable, true);
      assert.equal(inspection.classification.kind, "ours-different-build");
      assert.match(
        formatInspection(inspection, { expectedRevision: revisionA }),
        /launching: revision a{40}/,
      );
    },
  );
});

test("resolveLaunchPort steps past a foreign occupant and reports the move", async () => {
  await withRawListener(async (port) => {
    const resolved = await resolveLaunchPort({
      port,
      adjustable: true,
      attempts: 5,
      timeoutMs: 500,
      identifyProcess: false,
    });
    assert.equal(resolved.adjusted, true);
    assert.ok(resolved.port > port);
    assert.equal(resolved.decision.action, "proceed");
  });
});

test("resolveLaunchPort refuses to step past our own app", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/.well-known/srn-deployment.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`{"revision":"${revisionB}","version":"dev"}`);
        return;
      }
      response.writeHead(200);
      response.end("");
    },
    async (port) => {
      const resolved = await resolveLaunchPort({
        port,
        expectedRevision: revisionA,
        adjustable: true,
        attempts: 5,
        timeoutMs: 2000,
        identifyProcess: false,
      });
      assert.equal(resolved.port, null);
      assert.equal(resolved.decision.action, "stop");
      assert.equal(resolved.inspections.length, 1);
    },
  );
});

test("parseNetstatListeners extracts listening pids for the requested port only", () => {
  const stdout = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       21840",
    "  TCP    [::]:3001              [::]:0                 LISTENING       21840",
    "  TCP    127.0.0.1:3002         0.0.0.0:0              LISTENING       991",
    "  TCP    127.0.0.1:3001         127.0.0.1:55123        ESTABLISHED     4242",
  ].join("\r\n");
  assert.deepEqual(parseNetstatListeners(stdout, 3001), [21840]);
  assert.deepEqual(parseNetstatListeners(stdout, 3002), [991]);
  assert.deepEqual(parseNetstatListeners(stdout, 9999), []);
});

test("parseTasklistCsv maps image names to pids", () => {
  const stdout = [
    '"node.exe","21840","Console","1","210,144 K"',
    '"electron.exe","4242","Console","1","510,144 K"',
    "",
  ].join("\r\n");
  assert.deepEqual(parseTasklistCsv(stdout), [
    { pid: 21840, name: "node.exe" },
    { pid: 4242, name: "electron.exe" },
  ]);
});

test("parseLsofListeners skips the header and de-duplicates pids", () => {
  const stdout = [
    "COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "node    21840 mariana   23u  IPv4 123456      0t0  TCP 127.0.0.1:3001 (LISTEN)",
    "node    21840 mariana   24u  IPv6 123457      0t0  TCP [::1]:3001 (LISTEN)",
  ].join("\n");
  assert.deepEqual(parseLsofListeners(stdout), [{ pid: 21840, name: "node" }]);
});

test("selectDesktopProcesses matches the app and electron binaries only", () => {
  assert.deepEqual(
    selectDesktopProcesses([
      { pid: 1, name: "electron.exe" },
      { pid: 2, name: "standard-red-notes.exe" },
      { pid: 3, name: "chrome.exe" },
      { pid: 4, name: "node.exe" },
    ]),
    [
      { pid: 1, name: "electron.exe" },
      { pid: 2, name: "standard-red-notes.exe" },
    ],
  );
});

test("detectDesktopInstances returns an array on this platform without throwing", () => {
  assert.ok(Array.isArray(detectDesktopInstances()));
});

test("parseDotEnv reads the keys docker compose interpolates", () => {
  const parsed = parseDotEnv(
    ['# comment', 'APP_PORT=8085', 'APP_BIND_ADDRESS="127.0.0.1"', "export OTHER='x y'", "malformed line"].join("\n"),
  );
  assert.equal(parsed.APP_PORT, "8085");
  assert.equal(parsed.APP_BIND_ADDRESS, "127.0.0.1");
  assert.equal(parsed.OTHER, "x y");
  assert.equal(Object.hasOwn(parsed, "malformed line"), false);
});

test("applyEnvironmentOverrides retargets the docker app port and ignores junk", () => {
  const base = { app: { port: 3001, host: "127.0.0.1" }, gateway: { port: 3000 } };
  assert.deepEqual(applyEnvironmentOverrides(base, { APP_PORT: "8085" }).app, {
    port: 8085,
    host: "127.0.0.1",
  });
  assert.deepEqual(applyEnvironmentOverrides(base, { APP_PORT: "nope" }).app, base.app);
  assert.deepEqual(applyEnvironmentOverrides(base, { APP_PORT: "70000" }).app, base.app);
  // 0.0.0.0 is a bind address, not somewhere to send a probe.
  assert.equal(applyEnvironmentOverrides(base, { APP_BIND_ADDRESS: "0.0.0.0" }).app.host, "127.0.0.1");
  assert.equal(applyEnvironmentOverrides(base, { APP_BIND_ADDRESS: "10.0.0.5" }).app.host, "10.0.0.5");
  assert.deepEqual(applyEnvironmentOverrides(base, {}).gateway, base.gateway);
});

test("expandTargets resolves groups and rejects unknown names", () => {
  assert.deepEqual(expandTargets(["docker"]), ["app", "gateway"]);
  assert.deepEqual(expandTargets(["web-dev", "web"]), ["web-dev"]);
  assert.throws(() => expandTargets(["nope"]), /unknown target/);
});

test("parseArgs defaults to every target and validates flags", () => {
  assert.deepEqual(parseArgs([]).targets, ["all"]);
  assert.equal(parseArgs(["--target", "web"]).targets[0], "web");
  assert.equal(parseArgs(["--port", "3001"]).ports[0], 3001);
  assert.equal(parseArgs(["--report-only"]).reportOnly, true);
  assert.equal(parseArgs(["--no-adjust"]).adjust, false);
  assert.throws(() => parseArgs(["--port", "0"]), /--port must be/);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["--target"]), /requires a value/);
});
