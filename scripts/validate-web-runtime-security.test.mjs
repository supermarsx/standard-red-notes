import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const configs = [
  "app/docker/nginx.conf",
  "app/docker/single/nginx.conf",
  "deploy/lxc/install.sh",
].map((relativePath) => ({ relativePath, source: read(relativePath) }));

const runnerHtml = read("app/packages/web/src/sandbox.html");
const sandboxEditor = read(
  "app/packages/web/src/javascripts/Components/NoteView/SandboxEditor/SandboxEditor.tsx",
);
const sandboxDocument = read(
  "app/packages/web/src/javascripts/Components/NoteView/SandboxEditor/SandboxDocument.ts",
);
const dockerEntrypoint = read("app/docker/docker-entrypoint.sh");
const singleContainerEntrypoint = read("server/docker/single/entrypoint.sh");
const lxcInstaller = read("deploy/lxc/install.sh");
const serviceWorker = read("app/packages/web/src/service-worker.js");
const webWebpack = read("app/packages/web/web.webpack.config.js");
const cryptoWebpack = read("app/packages/sncrypto-web/webpack.config.js");
const webPackage = JSON.parse(read("app/packages/web/package.json"));
const portableBundleAssertion = read(
  "app/packages/web/scripts/AssertPortableBundle.mjs",
);
const composeSources = [
  read("docker-compose.yml"),
  read("docker-compose.single.yml"),
];
const selfHostingGuide = read("docs/self-hosting.md");

function policyForLocation(source, locationPattern) {
  const block = source.match(
    new RegExp(
      `location\\s+${locationPattern}\\s*\\{[\\s\\S]*?add_header Content-Security-Policy "([^"]+)"`,
    ),
  );
  assert.ok(block, `CSP missing for nginx location ${locationPattern}`);
  return block[1];
}

function directive(policy, name) {
  const value = policy
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry === name || entry.startsWith(`${name} `));
  assert.ok(value, `${name} missing from CSP`);
  return value.split(/\s+/).slice(1);
}

function pdfWorkerLocation(source, relativePath) {
  const candidates = [
    "location ~ ^/assets/pdf/[^/]+\\.mjs$ {",
    "location ~ ^/assets/pdf/[^/]+\\.mjs\\$ {",
  ];
  const start = candidates
    .map((candidate) => source.indexOf(candidate))
    .find((index) => index >= 0);
  assert.notEqual(start, undefined, `${relativePath}: PDF worker location missing`);
  const end = source.indexOf("\n  }", start);
  assert.ok(end > start, `${relativePath}: PDF worker location is not bounded`);
  return source.slice(start, end);
}

function sandboxRunnerHash() {
  const runnerScript = runnerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(
    runnerScript,
    "sandbox runner must contain one fixed inline script",
  );
  return `sha256-${createHash("sha256")
    .update(runnerScript[1].replace(/\r\n/g, "\n"), "utf8")
    .digest("base64")}`;
}

test("the app and isolated sandbox use distinct, least-privilege CSPs", () => {
  const runnerScript = runnerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(
    runnerScript,
    "sandbox runner must contain one fixed inline script",
  );
  assert.equal((runnerHtml.match(/<script>/g) ?? []).length, 1);
  const runnerHash = sandboxRunnerHash();
  const runnerMetaPolicy = runnerHtml.match(
    /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  )?.[1];
  assert.ok(
    runnerMetaPolicy,
    "sandbox runner must carry a static-serving meta CSP",
  );
  assert.deepEqual(directive(runnerMetaPolicy, "script-src"), [
    "'unsafe-eval'",
    `'${runnerHash}'`,
  ]);
  assert.deepEqual(directive(runnerMetaPolicy, "worker-src"), ["blob:"]);
  assert.deepEqual(directive(runnerMetaPolicy, "connect-src"), ["'none'"]);
  assert.deepEqual(directive(runnerMetaPolicy, "frame-src"), ["'none'"]);
  assert.deepEqual(directive(runnerMetaPolicy, "object-src"), ["'none'"]);
  assert.doesNotMatch(
    runnerMetaPolicy,
    /frame-ancestors|(?:^|;)\s*sandbox(?:\s|;|$)/,
  );

  for (const { relativePath, source } of configs) {
    const parentPolicy = policyForLocation(source, "/");
    const parentScripts = directive(parentPolicy, "script-src");
    assert.ok(parentScripts.includes("'self'"), relativePath);
    assert.ok(parentScripts.includes("'wasm-unsafe-eval'"), relativePath);
    assert.ok(
      parentScripts.includes("'sha256-__CSP_INLINE_SCRIPT_HASH__'"),
      relativePath,
    );
    assert.ok(!parentScripts.includes("'unsafe-inline'"), relativePath);
    assert.ok(!parentScripts.includes("'unsafe-eval'"), relativePath);

    const parentConnections = directive(parentPolicy, "connect-src");
    for (const allowed of [
      "'self'",
      "https:",
      "http://localhost:*",
      "http://127.0.0.1:*",
      "ws:",
      "wss:",
    ]) {
      assert.ok(
        parentConnections.includes(allowed),
        `${relativePath}: ${allowed}`,
      );
    }
    assert.ok(!parentConnections.includes("http:"), relativePath);

    assert.deepEqual(directive(parentPolicy, "img-src"), [
      "'self'",
      "data:",
      "blob:",
      "https:",
    ]);
    assert.deepEqual(directive(parentPolicy, "frame-src"), [
      "'self'",
      "blob:",
      "https:",
    ]);
    assert.deepEqual(directive(parentPolicy, "object-src"), ["'none'"]);

    const workerLocation = pdfWorkerLocation(source, relativePath);
    assert.match(workerLocation, /default_type application\/javascript;/);
    assert.match(workerLocation, /try_files \\?\$uri =404;/);

    const sandboxPolicy = policyForLocation(source, "=\\s*/sandbox\\.html");
    assert.deepEqual(directive(sandboxPolicy, "script-src"), [
      "'unsafe-eval'",
      `'${runnerHash}'`,
    ]);
    assert.deepEqual(directive(sandboxPolicy, "worker-src"), ["blob:"]);
    assert.deepEqual(directive(sandboxPolicy, "connect-src"), ["'none'"]);
    assert.deepEqual(directive(sandboxPolicy, "frame-src"), ["'none'"]);
    assert.deepEqual(directive(sandboxPolicy, "object-src"), ["'none'"]);
    assert.deepEqual(directive(sandboxPolicy, "sandbox"), ["allow-scripts"]);
    assert.ok(
      !sandboxPolicy.includes("script-src 'unsafe-inline'"),
      relativePath,
    );
  }
});

test("trusted proxy transport is opt-in, exact-value only, and HSTS is HTTPS-only", () => {
  assert.match(
    selfHostingGuide,
    /return 308 https:\/\/notes\.example\.com\$request_uri;/,
  );
  assert.match(
    selfHostingGuide,
    /add_header Strict-Transport-Security "max-age=31536000" always;/,
  );
  const documentedSocketProxy = selfHostingGuide.match(
    /location \/sockets \{([\s\S]*?)\n    \}/,
  )?.[1];
  assert.ok(
    documentedSocketProxy,
    "documented outer websocket location missing",
  );
  for (const header of [
    "Host              $host",
    "X-Real-IP         $remote_addr",
    "X-Forwarded-For   $remote_addr",
    "X-Forwarded-Proto https",
    "X-Forwarded-Host  $host",
    "Upgrade    $http_upgrade",
    "Connection $connection_upgrade",
  ]) {
    assert.ok(
      documentedSocketProxy.includes(`proxy_set_header ${header};`),
      `documented websocket proxy must set ${header}`,
    );
  }
  for (const source of composeSources) {
    assert.match(
      source,
      /APP_BIND_ADDRESS: \$\{APP_BIND_ADDRESS:-0\.0\.0\.0\}/,
    );
    assert.match(
      source,
      /"\$\{APP_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{APP_PORT:-3001\}:8080"/,
    );
  }
  for (const relativePath of [
    "app/docker/nginx.conf",
    "app/docker/single/nginx.conf",
  ]) {
    const source = read(relativePath);
    assert.match(
      source,
      /map "disabled" \$srn_proxy_https_mode \{ default disabled; \}/,
      relativePath,
    );
    assert.match(
      source,
      /map "https:\/\/invalid\.invalid" \$srn_https_public_origin \{ default "https:\/\/invalid\.invalid"; \}/,
      relativePath,
    );

    const transportMap = source.match(
      /map "\$srn_proxy_https_mode:\$http_x_forwarded_proto" \$srn_proxy_transport \{([\s\S]*?)\n\}/,
    )?.[1];
    assert.ok(transportMap, `${relativePath}: transport map missing`);
    assert.match(
      source,
      /map \$srn_proxy_https_mode \$srn_forwarded_for \{[\s\S]*?default\s+\$remote_addr;[\s\S]*?enabled\s+\$proxy_add_x_forwarded_for;/,
      `${relativePath}: direct mode must discard a client-supplied forwarding chain`,
    );
    assert.equal(
      (
        source.match(
          /proxy_set_header X-Forwarded-For \$srn_forwarded_for;/g,
        ) ?? []
      ).length,
      4,
      `${relativePath}: every backend route must use the sanitized forwarding value`,
    );
    assert.doesNotMatch(
      source,
      /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/,
      `${relativePath}: backend routes must not append raw client input directly`,
    );
    const rules = [...transportMap.matchAll(/~\^([^$]+)\$\s+(\w+)\s*;/g)].map(
      ([, pattern, result]) => [new RegExp(`^${pattern}$`), result],
    );
    const resolve = (mode, header = "") =>
      rules.find(([pattern]) => pattern.test(`${mode}:${header}`))?.[1] ??
      "direct";
    assert.equal(resolve("enabled", "http"), "forwarded_http", relativePath);
    assert.equal(resolve("enabled", "https"), "forwarded_https", relativePath);
    for (const [mode, header] of [
      ["disabled", "http"],
      ["disabled", "https"],
      ["enabled", ""],
      ["enabled", "HTTP"],
      ["enabled", "https,http"],
      ["enabled", "ftp"],
    ]) {
      assert.equal(
        resolve(mode, header),
        "direct",
        `${relativePath}: ${mode}/${header}`,
      );
    }

    assert.match(
      source,
      /map "\$srn_proxy_transport:\$uri" \$srn_redirect_to_https \{[\s\S]*~\^forwarded_http:\/health\$\s+0;[\s\S]*~\^forwarded_http:\/healthcheck\(\/\|\$\)\s+0;[\s\S]*~\^forwarded_http:\s+1;/,
      relativePath,
    );
    assert.match(
      source,
      /return 308 \$srn_https_public_origin\$request_uri;/,
      relativePath,
    );
    assert.equal(
      (
        source.match(
          /proxy_set_header X-Forwarded-Proto \$srn_forwarded_proto;/g,
        ) ?? []
      ).length,
      4,
      relativePath,
    );
    assert.doesNotMatch(
      source,
      /proxy_set_header X-Forwarded-Proto \$(?:http_x_forwarded_proto|scheme);/,
      relativePath,
    );
    assert.match(
      source,
      /map \$srn_proxy_transport \$srn_hsts_header \{[\s\S]*forwarded_https\s+"max-age=31536000";/,
      relativePath,
    );
    assert.match(
      source,
      /gzip_types[^\n]+;[\s\S]{0,300}?add_header Strict-Transport-Security \$srn_hsts_header always;/,
      `${relativePath}: proxied API responses must inherit conditional HSTS`,
    );
    assert.match(
      source,
      /location = \/health \{[\s\S]*?add_header Strict-Transport-Security \$srn_hsts_header always;[\s\S]*?return 200 "ok\\n";/,
      `${relativePath}: health must retain HSTS when reached through trusted HTTPS`,
    );
    assert.ok(
      (
        source.match(
          /add_header Strict-Transport-Security \$srn_hsts_header always;/g,
        ) ?? []
      ).length >= 4,
      `${relativePath}: server, health, SPA and sandbox HSTS coverage is required`,
    );
    assert.doesNotMatch(source, /includeSubDomains|\bpreload\b/, relativePath);
  }

  assert.equal(
    (
      lxcInstaller.match(
        /proxy_set_header X-Forwarded-For \\\$remote_addr;/g,
      ) ?? []
    ).length,
    3,
    "LXC public nginx must overwrite X-Forwarded-For on every backend route",
  );
  assert.doesNotMatch(
    lxcInstaller,
    /proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;/,
  );
});

test("runtime proxy transport templating is idempotent and rejects unsafe public origins", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(root, ".tmp-proxy-transport-"),
  );
  const relative = (filePath) =>
    path.relative(root, filePath).split(path.sep).join("/");
  const indexPath = path.join(temporaryDirectory, "index.html");
  const configPath = path.join(temporaryDirectory, "nginx.conf");

  const run = (enforce, publicUrl, bindAddress = "127.0.0.1") =>
    spawnSync("sh", ["app/docker/docker-entrypoint.sh"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ENFORCE_HTTPS_FROM_PROXY: enforce,
        PUBLIC_URL: publicUrl,
        APP_BIND_ADDRESS: bindAddress,
        SRN_ENTRYPOINT_INDEX_HTML: relative(indexPath),
        SRN_ENTRYPOINT_NGINX_CONF: relative(configPath),
      },
    });

  try {
    writeFileSync(indexPath, read("app/packages/web/src/index.html"));
    writeFileSync(configPath, read("app/docker/nginx.conf"));

    const enabled = run("true", "https://notes.example.test:8443");
    assert.equal(enabled.status, 0, enabled.stderr || enabled.error?.message);
    assert.match(enabled.stdout, /trusted proxy HTTPS mode: enabled/);
    let configured = readFileSync(configPath, "utf8");
    assert.match(
      configured,
      /map "enabled" \$srn_proxy_https_mode \{ default enabled; \}/,
    );
    assert.match(
      configured,
      /map "https:\/\/notes\.example\.test:8443" \$srn_https_public_origin \{ default "https:\/\/notes\.example\.test:8443"; \}/,
    );

    const disabledAgain = run("false", "https://ignored.example.test");
    assert.equal(
      disabledAgain.status,
      0,
      disabledAgain.stderr || disabledAgain.error?.message,
    );
    configured = readFileSync(configPath, "utf8");
    assert.match(
      configured,
      /map "disabled" \$srn_proxy_https_mode \{ default disabled; \}/,
    );
    assert.match(
      configured,
      /map "https:\/\/invalid\.invalid" \$srn_https_public_origin/,
    );
    assert.doesNotMatch(
      configured,
      /notes\.example\.test|ignored\.example\.test/,
    );

    for (const publicUrl of [
      "",
      "http://notes.example.test",
      "https://",
      "https://.example.test",
      "https://example..test",
      "https://user@example.test",
      "https://notes.example.test/path",
      "https://notes.example.test?query=1",
      "https://notes.example.test#fragment",
      "https://notes.example.test:0",
      "https://notes.example.test:65536",
      "https://notes.example.test\r\nX-Injected: yes",
    ]) {
      writeFileSync(configPath, read("app/docker/nginx.conf"));
      const rejected = run("true", publicUrl);
      assert.notEqual(
        rejected.status,
        0,
        `unexpectedly accepted ${JSON.stringify(publicUrl)}`,
      );
      assert.match(
        rejected.stderr,
        /requires PUBLIC_URL to be one canonical HTTPS origin/,
      );
    }

    writeFileSync(configPath, read("app/docker/nginx.conf"));
    const invalidMode = run("TRUE", "https://notes.example.test");
    assert.notEqual(invalidMode.status, 0);
    assert.match(invalidMode.stderr, /must be exactly true or false/);

    for (const bindAddress of ["0.0.0.0", "192.0.2.10", ""]) {
      writeFileSync(configPath, read("app/docker/nginx.conf"));
      const unsafeBind = run("true", "https://notes.example.test", bindAddress);
      assert.notEqual(unsafeBind.status, 0);
      assert.match(unsafeBind.stderr, /requires APP_BIND_ADDRESS=127\.0\.0\.1/);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("sandbox code stays data inside an opaque-origin, offline-capable runner", () => {
  assert.equal(
    (
      sandboxEditor.match(
        /src=\{`\/sandbox\.html#\$\{runSession\.nonce\}`\}/g,
      ) ?? []
    ).length,
    2,
  );
  assert.equal(
    (sandboxEditor.match(/sandbox="allow-scripts"/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(
    sandboxEditor,
    /allow-same-origin|allow-top-navigation|allow-popups/,
  );
  assert.doesNotMatch(sandboxEditor, /srcDoc=/);
  assert.match(
    sandboxEditor,
    /claimSandboxRunDelivery\(deliveredRunNonce, runSession\.nonce\)/,
  );
  assert.doesNotMatch(sandboxEditor, /AUTO_RUN_DEBOUNCE_MS|autoRunTimer/);
  assert.match(sandboxEditor, /Press Run to render this sandbox/);
  assert.match(runnerHtml, /event\.source !== parent/);
  assert.match(runnerHtml, /event\.data\.channel !== runChannel/);
  assert.match(runnerHtml, /event\.data\.nonce !== runNonce/);
  assert.match(runnerHtml, /didRun \|\|/);
  assert.match(runnerHtml, /new Worker\(workerUrl\)/);
  assert.match(runnerHtml, /executionTimeoutMs = 2000/);
  assert.match(runnerHtml, /activeWorker\.terminate\(\)/);
  assert.match(runnerHtml, /runPayloadMaxBytes = 1048576/);
  assert.match(
    runnerHtml,
    /if \(!isRunPayloadWithinLimit\(html, css, script\)\)/,
  );
  assert.match(sandboxDocument, /SANDBOX_RUN_MAX_PAYLOAD_BYTES = 1024 \* 1024/);
  assert.match(sandboxEditor, /isSandboxRunPayloadWithinLimit\(document\)/);
  assert.match(
    sandboxEditor,
    /isSandboxRunPayloadWithinLimit\(runSession\.document\)/,
  );
  assert.match(sandboxEditor, /title="Stop and reset sandbox"/);
  assert.match(sandboxEditor, /setRunSession\(undefined\)/);
  assert.match(runnerHtml, /worker-src blob:/);
  assert.match(serviceWorker, /SANDBOX_PATH\s*=\s*['"]\/sandbox\.html['"]/);
  assert.match(serviceWorker, /CORE_SHELL[^\n]+SANDBOX_PATH/);
  assert.match(webWebpack, /from: ['"]src\/sandbox\.html['"]/);
});

test("sandbox worker bounds console transport before crossing the frame", () => {
  assert.equal(
    (runnerHtml.match(/consoleMessageMaxLength = 16384/g) ?? []).length,
    2,
  );
  assert.equal(
    (runnerHtml.match(/consoleEntryMaxCount = 200/g) ?? []).length,
    2,
  );
  assert.equal(
    (
      runnerHtml.match(
        /Console output limit reached; further messages were dropped\./g,
      ) ?? []
    ).length,
    2,
  );
  assert.match(runnerHtml, /message \+= consoleTruncationSuffix/);
  assert.match(runnerHtml, /entriesSent >= consoleEntryMaxCount/);
  assert.match(runnerHtml, /consoleEntriesSent >= consoleEntryMaxCount/);
  assert.match(runnerHtml, /Object\.defineProperty\(self, 'postMessage'/);
  assert.match(runnerHtml, /Object\.defineProperty\(self, names\[index\]/);
  assert.match(
    sandboxEditor,
    /normalizeSandboxConsoleEntry\(data, consoleMessagesThisRun\.current\)/,
  );
  assert.match(sandboxEditor, /prev\.length < SANDBOX_CONSOLE_MAX_ENTRIES/);
});

test("an offline sandbox cache miss returns inert text instead of the app shell", async () => {
  const listeners = new Map();
  const cacheLookups = [];
  const context = {
    URL,
    Request,
    Response,
    Promise,
    fetch: async () => {
      throw new Error("offline");
    },
    caches: {
      // The offline fallback is scoped to THIS build's cache via caches.open,
      // not the origin-wide caches.match, so the stub has to model the same
      // shape or the worker throws instead of failing closed.
      open: async () => ({
        put: async () => undefined,
        match: async (request) => {
          cacheLookups.push(request);
          if (request === "/index.html") {
            return new Response("<!doctype html><title>app shell</title>", {
              headers: { "Content-Type": "text/html" },
            });
          }
          return undefined;
        },
      }),
      match: async () => {
        throw new Error(
          "the offline fallback must not search every cache in the origin",
        );
      },
    },
    self: {
      location: { origin: "https://notes.example.test" },
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
  };
  runInNewContext(serviceWorker, context);

  let responsePromise;
  const request = {
    method: "GET",
    url: "https://notes.example.test/sandbox.html",
    mode: "navigate",
    destination: "document",
  };
  listeners.get("fetch")({
    request,
    respondWith: (value) => {
      responsePromise = Promise.resolve(value);
    },
  });

  assert.ok(responsePromise, "sandbox navigation must be intercepted");
  const response = await responsePromise;
  assert.equal(response.status, 503);
  assert.equal(
    response.headers.get("Content-Type"),
    "text/plain; charset=utf-8",
  );
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(
    response.headers.get("Content-Security-Policy"),
    /default-src 'none'/,
  );
  assert.match(await response.text(), /unavailable while offline/i);
  assert.deepEqual(
    cacheLookups,
    [request],
    "the app-shell fallback must not be consulted",
  );
});

test("a failing-upstream navigation is passed through but never cached as the app shell", async () => {
  const listeners = new Map();
  const cachePuts = [];
  const context = {
    URL,
    Request,
    Response,
    Promise,
    fetch: async () =>
      new Response("<html><script>window.x=1</script></html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
    caches: {
      open: async () => ({
        put: async (request, response) => {
          cachePuts.push([request, response]);
        },
      }),
      match: async () => undefined,
    },
    self: {
      location: { origin: "https://notes.example.test" },
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
  };
  runInNewContext(serviceWorker, context);

  let responsePromise;
  listeners.get("fetch")({
    request: {
      method: "GET",
      url: "https://notes.example.test/",
      mode: "navigate",
      destination: "document",
    },
    respondWith: (value) => {
      responsePromise = Promise.resolve(value);
    },
  });

  const response = await responsePromise;
  assert.equal(response.status, 502, "the real upstream failure reaches the page");
  // A cached 502 becomes the offline shell and is then served under the app CSP,
  // whose inline-script hash pins the real index.html — the proxy error page's
  // own inline script would be blocked as a script-src-elem violation.
  assert.deepEqual(cachePuts, [], "an error page must never enter the shell cache");
});

test("deployment marker requests bypass the service worker and every cache", () => {
  const listeners = new Map();
  let respondWithCalls = 0;
  let fetchCalls = 0;
  let cacheCalls = 0;
  const context = {
    URL,
    Request,
    Response,
    Promise,
    fetch: () => {
      fetchCalls += 1;
      throw new Error("service worker must not fetch the deployment marker");
    },
    caches: {
      open: () => {
        cacheCalls += 1;
        throw new Error(
          "service worker must not open a cache for the deployment marker",
        );
      },
      match: () => {
        cacheCalls += 1;
        throw new Error(
          "service worker must not read a cache for the deployment marker",
        );
      },
    },
    self: {
      location: { origin: "https://notes.example.test" },
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
  };
  runInNewContext(serviceWorker, context);

  listeners.get("fetch")({
    request: {
      method: "GET",
      url: "https://notes.example.test/.well-known/srn-deployment.json",
      mode: "cors",
      destination: "",
    },
    respondWith: () => {
      respondWithCalls += 1;
    },
  });

  assert.equal(respondWithCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(cacheCalls, 0);
});

test("runtime CSP hashing cannot overwrite the fixed sandbox hash", () => {
  assert.match(
    dockerEntrypoint,
    /script-src 'self' 'wasm-unsafe-eval' '\[\^'\]\*'[\s\S]*sha256-\$\{_b64\}/,
  );
  assert.doesNotMatch(
    dockerEntrypoint,
    /sed -i "s\|'sha256-\[A-Za-z0-9\+\/_=\]\*'/,
  );
  assert.match(
    lxcInstaller,
    /sed -i "s\|__CSP_INLINE_SCRIPT_HASH__\|\$\{b64\}\|g"/,
  );
});

test("single-container startup requires successful CSP runtime configuration before supervisord", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(root, ".tmp-single-csp-gate-"),
  );
  const relative = (filePath) =>
    path.relative(root, filePath).split(path.sep).join("/");
  const helperPath = path.join(temporaryDirectory, "csp-runtime-config.sh");
  const harnessPath = path.join(temporaryDirectory, "entrypoint-tail.sh");
  const supervisorMarkerPath = path.join(
    temporaryDirectory,
    "supervisord-reached",
  );

  try {
    const tailMarker =
      "# --- 4. App runtime-config templating + CSP inline-script self-heal";
    const tailStart = singleContainerEntrypoint.indexOf(tailMarker);
    assert.notEqual(tailStart, -1, "single-container CSP gate is missing");

    const runtimeTail = singleContainerEntrypoint
      .slice(tailStart)
      .replace(
        "CSP_RUNTIME_CONFIG_HELPER=/usr/local/bin/csp-runtime-config.sh",
        `CSP_RUNTIME_CONFIG_HELPER="${relative(helperPath)}"`,
      )
      .replace(
        "exec supervisord -c /etc/supervisord.conf",
        `printf 'reached\\n' > "${relative(supervisorMarkerPath)}"`,
      );
    assert.notEqual(
      runtimeTail,
      singleContainerEntrypoint.slice(tailStart),
      "test harness must substitute the production paths",
    );
    assert.doesNotMatch(
      runtimeTail,
      /\/usr\/local\/bin\/csp-runtime-config\.sh/,
    );
    assert.doesNotMatch(runtimeTail, /exec supervisord/);
    writeFileSync(harnessPath, `set -eu\n${runtimeTail}`);

    const run = () =>
      spawnSync("sh", [relative(harnessPath)], {
        cwd: root,
        encoding: "utf8",
      });

    const missingHelper = run();
    assert.notEqual(missingHelper.status, 0);
    assert.match(
      missingHelper.stderr,
      /required CSP\/runtime-config helper is missing/,
    );
    assert.equal(existsSync(supervisorMarkerPath), false);

    writeFileSync(helperPath, "exit 42\n");
    const failedHelper = run();
    assert.notEqual(failedHelper.status, 0);
    assert.match(
      failedHelper.stderr,
      /CSP\/runtime-config templating failed; refusing to start supervisord/,
    );
    assert.equal(existsSync(supervisorMarkerPath), false);

    writeFileSync(helperPath, "exit 0\n");
    const successfulHelper = run();
    assert.equal(successfulHelper.status, 0, successfulHelper.stderr);
    assert.equal(existsSync(supervisorMarkerPath), true);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("docker CSP hashing rotates the parent hash and fails closed without changing the sandbox hash", () => {
  const temporaryDirectory = mkdtempSync(path.join(root, ".tmp-csp-restart-"));
  const relative = (filePath) =>
    path.relative(root, filePath).split(path.sep).join("/");
  const indexPath = path.join(temporaryDirectory, "index.html");
  const configPath = path.join(temporaryDirectory, "nginx.conf");

  try {
    writeFileSync(indexPath, read("app/packages/web/src/index.html"));
    writeFileSync(configPath, read("app/docker/nginx.conf"));

    const run = (ocrEnabled) =>
      spawnSync("sh", ["app/docker/docker-entrypoint.sh"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          OCR_ENABLED: ocrEnabled,
          SRN_ENTRYPOINT_INDEX_HTML: relative(indexPath),
          SRN_ENTRYPOINT_NGINX_CONF: relative(configPath),
        },
      });

    const first = run("false");
    assert.equal(first.status, 0, first.stderr || first.error?.message);
    const firstHash = first.stdout.match(
      /CSP inline-script hash: (sha256-[A-Za-z0-9+/=]+)/,
    )?.[1];
    assert.ok(firstHash, first.stdout);
    assert.match(
      readFileSync(configPath, "utf8"),
      new RegExp(`wasm-unsafe-eval' '${firstHash}`),
    );

    const second = run("true");
    assert.equal(second.status, 0, second.stderr || second.error?.message);
    const secondHash = second.stdout.match(
      /CSP inline-script hash: (sha256-[A-Za-z0-9+/=]+)/,
    )?.[1];
    assert.ok(secondHash, second.stdout);
    assert.notEqual(
      secondHash,
      firstHash,
      "runtime templating must produce a new parent hash",
    );

    const twiceStartedConfig = readFileSync(configPath, "utf8");
    assert.match(
      twiceStartedConfig,
      new RegExp(`wasm-unsafe-eval' '${secondHash}`),
    );
    assert.doesNotMatch(
      twiceStartedConfig,
      new RegExp(`wasm-unsafe-eval' '${firstHash}`),
    );
    assert.ok(
      twiceStartedConfig.includes(
        `script-src 'unsafe-eval' '${sandboxRunnerHash()}`,
      ),
      "the fixed sandbox hash must survive consecutive parent CSP rewrites",
    );

    writeFileSync(indexPath, "<!doctype html><title>missing bootstrap</title>");
    const failedHashing = run("true");
    assert.notEqual(
      failedHashing.status,
      0,
      "a missing bootstrap must abort container startup",
    );
    assert.match(
      failedHashing.stderr,
      /ERROR: failed to compute and install the CSP inline-script hash; refusing to start nginx/,
    );
    const failedConfig = readFileSync(configPath, "utf8");
    assert.equal(
      failedConfig,
      twiceStartedConfig,
      "failed hashing must not mutate the last restrictive configuration",
    );
    assert.doesNotMatch(
      failedConfig,
      /script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'/,
      "failed hashing must never weaken the parent script policy",
    );
    assert.match(failedConfig, new RegExp(`wasm-unsafe-eval' '${secondHash}`));
    assert.ok(
      failedConfig.includes(`script-src 'unsafe-eval' '${sandboxRunnerHash()}`),
      "a failed parent hash refresh must leave the fixed sandbox hash intact",
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("production webpack resolves libsodium and invokes the portable-output assertion", () => {
  for (const config of [webWebpack, cryptoWebpack]) {
    assert.match(
      config,
      /libsodium-wrappers-sumo\/dist\/modules-sumo\/libsodium-wrappers\.js/,
    );
    assert.match(
      config,
      /libsodium-sumo\/dist\/modules-sumo\/libsodium-sumo\.js/,
    );
    assert.match(config, /NormalModuleReplacementPlugin\(\/\^node:fs\$\//);
    assert.match(config, /resource\.request\s*=\s*['"]fs['"]/);
    assert.doesNotMatch(config, /modules-sumo-esm/);
  }
  assert.match(webWebpack, /importMeta:\s*false/);
  assert.match(webWebpack, /url:\s*['"]relative['"]/);
  assert.match(webWebpack, /importMetaName:[\s\S]*globalThis\.location\.href/);
  assert.match(webWebpack, /sassOptions:\s*\{[\s\S]*?charset:\s*false/);
  assert.match(webPackage.scripts.build, /AssertPortableBundle\.mjs/);
  assert.match(portableBundleAssertion, /allowedFileUrls/);
  assert.match(portableBundleAssertion, /encodedSchemePattern/);
  assert.match(
    portableBundleAssertion,
    /path\.extname\(file\)[\s\S]*import\\\.meta/,
  );
});

test("portable-output assertion validates script portability and Standard Red CSS", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(root, ".tmp-portable-bundle-"),
  );
  const assertionPath = path.join(
    root,
    "app/packages/web/scripts/AssertPortableBundle.mjs",
  );
  const classicPath = path.join(temporaryDirectory, "classic.js");
  const stylesheetPath = path.join(temporaryDirectory, "app.css");
  const standardRedStylesheet = `:root {
    --sn-stylekit-theme-name: sn-standard-red;
    --sn-stylekit-theme-type: dark;
    --sn-stylekit-background-color: #16090f;
    --sn-stylekit-foreground-color: #eadde0;
    --sn-stylekit-info-color: #e85f6d;
  }`;
  const run = () =>
    spawnSync(process.execPath, [assertionPath, temporaryDirectory], {
      cwd: root,
      encoding: "utf8",
    });

  try {
    writeFileSync(classicPath, 'const fallback = "file:///C:/SheetJS/";');
    writeFileSync(stylesheetPath, standardRedStylesheet);
    writeFileSync(
      path.join(temporaryDirectory, "worker.mjs"),
      "export const workerUrl = import.meta.url;",
    );
    const allowed = run();
    assert.equal(allowed.status, 0, allowed.stderr || allowed.error?.message);

    writeFileSync(classicPath, "const broken = import.meta.url;");
    const classicImportMeta = run();
    assert.notEqual(classicImportMeta.status, 0);
    assert.match(classicImportMeta.stderr, /raw import\.meta/);

    writeFileSync(
      classicPath,
      'const leaked = "file:///opt/app/dist/crypto.mjs";',
    );
    const rawFileUrl = run();
    assert.notEqual(rawFileUrl.status, 0);
    assert.match(rawFileUrl.stderr, /forbidden file URL/);

    writeFileSync(
      classicPath,
      'const encoded = "file%3A%2F%2F%2FC%3A%2FSheetJS%2F";',
    );
    const encodedFileUrl = run();
    assert.notEqual(encodedFileUrl.status, 0);
    assert.match(encodedFileUrl.stderr, /percent-encoded file URL/);

    writeFileSync(classicPath, 'const fallback = "file:///C:/SheetJS/";');
    writeFileSync(stylesheetPath, `body {}\uFEFF${standardRedStylesheet}`);
    const midStylesheetBom = run();
    assert.notEqual(midStylesheetBom.status, 0);
    assert.match(
      midStylesheetBom.stderr,
      /app\.css: UTF-8 BOM in the middle of the stylesheet at byte 7/,
    );

    writeFileSync(
      stylesheetPath,
      standardRedStylesheet.replace(
        "--sn-stylekit-background-color: #16090f;",
        "",
      ),
    );
    const missingRootToken = run();
    assert.notEqual(missingRootToken.status, 0);
    assert.match(
      missingRootToken.stderr,
      /Standard Red root token --sn-stylekit-background-color must be #16090f, found missing/,
    );

    writeFileSync(
      stylesheetPath,
      `:root {
        /*
        --sn-stylekit-theme-name: sn-standard-red;
        --sn-stylekit-theme-type: dark;
        --sn-stylekit-background-color: #16090f;
        --sn-stylekit-foreground-color: #eadde0;
        --sn-stylekit-info-color: #e85f6d;
        */
      }`,
    );
    const commentedRootTokens = run();
    assert.notEqual(commentedRootTokens.status, 0);
    assert.match(
      commentedRootTokens.stderr,
      /app\.css: missing a valid Standard Red :root rule/,
    );

    writeFileSync(
      stylesheetPath,
      standardRedStylesheet.replace(
        "--sn-stylekit-background-color: #16090f;",
        "--sn-stylekit-background-color: #ffffff;",
      ),
    );
    const lightRootPalette = run();
    assert.notEqual(lightRootPalette.status, 0);
    assert.match(
      lightRootPalette.stderr,
      /Standard Red root token --sn-stylekit-background-color must be #16090f, found #ffffff/,
    );

    writeFileSync(
      stylesheetPath,
      `${standardRedStylesheet}
      :root { --sn-stylekit-background-color: #ffffff; }`,
    );
    const overriddenRootPalette = run();
    assert.notEqual(overriddenRootPalette.status, 0);
    assert.match(
      overriddenRootPalette.stderr,
      /effective root token --sn-stylekit-background-color must remain #16090f, found #ffffff/,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Stale-shell eviction (t97). Commit 095d6d7f stopped NEW poisoning of the
// shell cache; these pin the other half — that an already-poisoned or simply
// outdated cache is actually evicted, automatically on update and on demand
// from settings — without ever reaching into user-data storage.
// ---------------------------------------------------------------------------

const appCacheReset = read(
  "app/packages/web/src/javascripts/Utils/AppCacheReset.ts",
);
const generalPane = read(
  "app/packages/web/src/javascripts/Components/Preferences/Panes/General/General.tsx",
);
const reloadAppControl = read(
  "app/packages/web/src/javascripts/Components/Preferences/Panes/General/ReloadApp.tsx",
);

test("activating a new build evicts every previous shell cache and nothing else", async () => {
  const listeners = new Map();
  const deleted = [];
  let claimed = 0;
  const existingCaches = [
    "srn-shell-3.201.28-1785432284632",
    "srn-shell-3.201.28-1786376589647",
    "srn-shell-__SW_VERSION__",
    "some-third-party-cache",
    "workbox-precache-v2",
  ];
  const context = {
    URL,
    Request,
    Response,
    Promise,
    fetch: async () => {
      throw new Error("activate must not fetch");
    },
    caches: {
      keys: async () => [...existingCaches],
      delete: async (key) => {
        deleted.push(key);
        return true;
      },
      open: async () => ({ put: async () => undefined, match: async () => undefined }),
    },
    self: {
      location: { origin: "https://notes.example.test" },
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => undefined,
      clients: {
        claim: async () => {
          claimed += 1;
        },
      },
    },
  };
  runInNewContext(serviceWorker, context);

  let activation;
  listeners.get("activate")({
    waitUntil: (value) => {
      activation = value;
    },
  });
  await activation;

  // Older shells go. The current build's cache survives (it is what the page is
  // about to be served from), and caches this app did not write are untouched —
  // an indiscriminate purge would destroy storage we cannot reason about.
  assert.deepEqual(deleted, [
    "srn-shell-3.201.28-1785432284632",
    "srn-shell-3.201.28-1786376589647",
  ]);
  assert.equal(claimed, 1, "the fresh worker must claim open clients");
});

test("the shell cache name is stamped from the build, never a hand-bumped constant", () => {
  // A human-maintained version constant gets forgotten and the stale-shell bug
  // returns silently, so the token must be substituted at build time.
  assert.match(serviceWorker, /const SW_VERSION = '__SW_VERSION__'/);
  assert.match(serviceWorker, /const CACHE_NAME = 'srn-shell-' \+ SW_VERSION/);
  assert.doesNotMatch(
    serviceWorker,
    /const SW_VERSION = '\d/,
    "the checked-in worker must not carry a literal version",
  );

  // The webpack copy transform is the only place the value is produced. Every
  // source in its precedence chain is machine-supplied: an explicit build id,
  // the deploy revision already stamped into the image and the deployment
  // marker, or the build time. None of them is a constant a human must bump.
  assert.match(webWebpack, /__SW_VERSION__/);
  assert.match(
    webWebpack,
    /process\.env\.SW_BUILD_ID \|\| process\.env\.SRN_DEPLOY_REVISION \|\| String\(Date\.now\(\)\)/,
  );
  assert.match(webWebpack, /\$\{version\}-\$\{buildId\}/);
});

test("a new worker takes over promptly instead of waiting behind the old one", () => {
  // skipWaiting on install + claim on activate is deliberate here: the previous
  // worker can serve a shell from a DIFFERENT release (or a poisoned one), and
  // that shell fails the per-deploy inline-script hash pin. The asset swap risk
  // is covered because registerServiceWorker reloads the page once on
  // controllerchange rather than leaving it running against swapped assets.
  assert.match(serviceWorker, /self\.skipWaiting\(\)/);
  assert.match(serviceWorker, /self\.clients\.claim\(\)/);
  assert.match(serviceWorker, /'SKIP_WAITING'/);

  const registration = read(
    "app/packages/web/src/javascripts/registerServiceWorker.ts",
  );
  assert.match(registration, /controllerchange/);
  assert.match(registration, /window\.location\.reload\(\)/);
  assert.match(
    registration,
    /hasReloaded \|\| !hadControllerAtLoad/,
    "the first-visit claim must not be mistaken for an update reload",
  );
});

test("the settings cache reset touches shell caches only, never user-data storage", () => {
  // Notes, files, keys, the session and the unsynced sync outbox all live in
  // IndexedDB/localStorage. A reset that reached them would destroy unsynced
  // work and sign the user out — far worse than the stale asset it fixes. The
  // module must therefore not reference those APIs at all.
  // Comments name those APIs deliberately (they document the boundary), so
  // strip comments before asserting the EXECUTABLE code never mentions them.
  const executableAppCacheReset = appCacheReset
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const forbidden of ["indexedDB", "localStorage", "sessionStorage"]) {
    assert.doesNotMatch(
      executableAppCacheReset,
      new RegExp(`\\b${forbidden}\\b`),
      `AppCacheReset must never reference ${forbidden} in executable code`,
    );
  }

  assert.match(appCacheReset, /export const SHELL_CACHE_PREFIX = 'srn-shell-'/);
  // Deletion is reachable only after the shell-prefix guard: the loop `continue`s
  // for anything else, so an unprefixed cache can never reach the delete call.
  assert.match(
    executableAppCacheReset,
    /if \(!key\.startsWith\(SHELL_CACHE_PREFIX\)\) \{[\s\S]{0,200}?continue\n\s*\}[\s\S]{0,200}?delete\(key\)/,
    "deletion must stay behind the shell-prefix filter",
  );
  // The prefix the worker writes and the prefix the reset deletes must agree.
  assert.ok(serviceWorker.includes("'srn-shell-'"));
});

test("the reload control is mounted in the General preferences pane", () => {
  assert.match(generalPane, /import ReloadApp from '\.\/ReloadApp'/);
  assert.match(
    generalPane,
    /<Updates \/>\s*\n\s*<ReloadApp \/>/,
    "the control must sit in the default General subtab, unconditionally",
  );
  // Honest copy: users must not fear this deletes their notes.
  assert.match(reloadAppControl, /Your notes and account are not affected/);
  assert.match(reloadAppControl, /You will not be signed out/);
  // Offline is warned about rather than silently destructive.
  assert.match(reloadAppControl, /You appear to be offline/);
  assert.match(reloadAppControl, /alerts\.confirm\(/);
});
