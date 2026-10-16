import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertFrontDoorCompatible,
  deployWeb,
  backendServicesForUpdate,
  frontendConfig,
  locationBlocks,
} from "./deploy-web.mjs";

test("socket build checks automatically resolve the stable web facade in every shipped topology", () => {
  const source = (path) =>
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.ok(
    source("docker-compose.yml").includes(
      "WEB_APP_INTERNAL_ORIGIN: ${WEB_APP_INTERNAL_ORIGIN:-http://app:8080}",
    ),
  );
  assert.ok(
    source("server/docker/docker-entrypoint.sh").includes(
      'export API_GATEWAY_WEB_APP_INTERNAL_ORIGIN="${WEB_APP_INTERNAL_ORIGIN:-http://app:8080}"',
    ),
  );
  assert.ok(
    source("docker-compose.single.yml").includes(
      "WEB_APP_INTERNAL_ORIGIN: ${WEB_APP_INTERNAL_ORIGIN:-http://127.0.0.1:8080}",
    ),
  );
  assert.ok(
    source("server/docker/single/entrypoint.sh").includes(
      'put WEB_APP_INTERNAL_ORIGIN "${WEB_APP_INTERNAL_ORIGIN:-http://127.0.0.1:8080}"',
    ),
  );
  assert.ok(
    source("deploy/lxc/install.sh").includes(
      "WEB_APP_INTERNAL_ORIGIN=http://127.0.0.1:${HTTP_PORT}",
    ),
  );
});

test("malformed Compose output cannot leak configuration contents through parser errors", async () => {
  await assert.rejects(
    deployWeb({
      compose: [
        process.execPath,
        "-e",
        'process.stdout.write("not-json: fixture-secret")',
        "--",
      ],
    }),
    (error) =>
      error.message === "Deployment metadata was not valid JSON." &&
      !error.message.includes("fixture-secret"),
  );
});

test("public origin, TLS, bindings and network changes are refused before any deployment work", () => {
  const input = {
    service: {
      environment: {
        PUBLIC_URL: "https://notes.test",
        ENFORCE_HTTPS_FROM_PROXY: "true",
        APP_BIND_ADDRESS: "127.0.0.1",
      },
      ports: [
        {
          host_ip: "127.0.0.1",
          published: "3001",
          target: 8080,
          protocol: "tcp",
        },
      ],
      networks: { local: null, proxy: { aliases: ["notes"] } },
    },
    environment: {
      PUBLIC_URL: "https://notes.test",
      ENFORCE_HTTPS_FROM_PROXY: "true",
      APP_BIND_ADDRESS: "127.0.0.1",
    },
    bindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "3001" }] },
    networks: {
      test_local: { Aliases: ["test-app-1", "app"] },
      npm_default: { Aliases: ["test-app-1", "app", "notes"] },
    },
    networkDefinitions: {
      local: { name: "test_local" },
      proxy: { name: "npm_default" },
    },
    project: "test",
    frontName: "test-app-1",
  };
  assert.doesNotThrow(() => assertFrontDoorCompatible(input));
  for (const mutate of [
    (value) => {
      value.service.environment.PUBLIC_URL = "https://new.test";
    },
    (value) => {
      value.service.ports[0].published = "4001";
    },
    (value) => {
      value.service.networks.proxy.aliases = ["different"];
    },
    (value) => {
      value.service.environment.ENFORCE_HTTPS_FROM_PROXY = "false";
    },
  ]) {
    const changed = structuredClone(input);
    mutate(changed);
    assert.throws(
      () => assertFrontDoorCompatible(changed),
      /conventional full deploy/,
    );
  }
});

test("rolling web updates exclude the app and do not activate optional service profiles", () => {
  const services = {
    app: {},
    server: { depends_on: { db: {} } },
    db: {},
    mcp: { profiles: ["mcp"] },
    n8n: { profiles: ["n8n"] },
  };
  assert.deepEqual(backendServicesForUpdate(services), ["server", "db"]);
  assert.deepEqual(backendServicesForUpdate(services, "mcp"), [
    "server",
    "db",
    "mcp",
  ]);
  assert.deepEqual(backendServicesForUpdate(services, "*"), [
    "server",
    "db",
    "mcp",
    "n8n",
  ]);
  assert.throws(
    () =>
      backendServicesForUpdate({
        app: {},
        server: { depends_on: { helper: {} } },
        helper: { depends_on: { app: {} } },
      }),
    /public app/,
  );
});

const source = readFileSync(
  new URL("../app/docker/nginx.conf", import.meta.url),
  "utf8",
);
const locations = (value) =>
  new Map(
    locationBlocks(value).map((block) => [
      block.selector,
      value.slice(block.start, block.end),
    ]),
  );

test("frontend handover leaves every backend and websocket route byte-for-byte unchanged", () => {
  const before = locations(source),
    after = locations(frontendConfig(source, "web-new", "web-previous"));
  for (const selector of [
    "/sockets",
    "= /v1/assistant/subscription/callback",
    "~ ^/dav(/|$)",
    "~ ^/(v1|v2|auth|subscription|healthcheck)(/|$)",
    "/files/",
    "= /health",
  ]) {
    assert.equal(after.get(selector), before.get(selector), selector);
  }
});

test("shell, build marker, component assets, PDF workers and sandbox all follow the same healthy release", () => {
  const result = frontendConfig(source, "web-new", "web-previous");
  const after = locations(result);
  for (const selector of [
    "/",
    "= /.well-known/srn-deployment.json",
    "/components/",
    "~ ^/assets/pdf/[^/]+\\.mjs$",
    "= /sandbox.html",
  ]) {
    assert.match(after.get(selector), /set \$srn_rollout_active web-new:8080;/);
    assert.doesNotMatch(
      after.get(selector),
      /add_header Content-Security-Policy/,
    );
  }
  assert.match(
    after.get("@srn_rollout_bootstrap"),
    /sha256-__CSP_INLINE_SCRIPT_HASH__/,
  );
});

test("only immutable lazy assets can fall back to the previous release, never HTML or API writes", () => {
  const after = locations(frontendConfig(source, "web-new", "web-previous"));
  assert.match(after.get("/"), /error_page 404 = @srn_rollout_previous/);
  assert.match(after.get("@srn_rollout_previous"), /if \(\$uri !~/);
  assert.match(after.get("@srn_rollout_previous"), /return 404/);
  assert.match(after.get("@srn_rollout_previous"), /web-previous:8080/);
  assert.doesNotMatch(
    after.get("~ ^/(v1|v2|auth|subscription|healthcheck)(/|$)"),
    /rollout_previous/,
  );
  assert.match(
    locations(frontendConfig(source, "web-first")).get("@srn_rollout_previous"),
    /try_files \$uri =404/,
  );
});

test("configuration parser ignores braces inside quoted values and comments", () => {
  const input =
    'server {\n  location / { # ignored } {\n    add_header Test "a } { value";\n    if ($uri) { return 200; }\n  }\n}';
  const blocks = locationBlocks(input);
  assert.equal(blocks.length, 1);
  assert.equal(
    input.slice(blocks[0].start, blocks[0].end).trimEnd().endsWith("  }"),
    true,
  );
});

test("unexpected nginx layouts and unsafe container names fail before installation", () => {
  assert.throws(() => frontendConfig(source, "web;inject"), /Invalid release/);
  assert.throws(
    () => frontendConfig(source, "web-new", "../other"),
    /Invalid release/,
  );
  assert.throws(
    () =>
      frontendConfig(
        source.replace("location /components/", "location /custom/"),
        "web-new",
      ),
    /layout changed/,
  );
  assert.throws(
    () => frontendConfig(frontendConfig(source, "web-old"), "web-new"),
    /original bundled/,
  );
  assert.throws(() => locationBlocks("  location / {\n"), /Unbalanced/);
});
