import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import {
  extractLxcNginxSite,
  forwardingContractErrors,
  stripNginxComments,
} from "./nginx-route-contract.mjs";

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
  assert.notEqual(
    start,
    undefined,
    `${relativePath}: PDF worker location missing`,
  );
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

    // Realtime dials only the page's own host. wss: covers TLS pages; the
    // plain-http self-host case is spelled out as ws://$http_host on purpose:
    // Chromium and Firefox let 'self' match ws: on an http: page but WebKit's
    // 'self' matcher only widens http -> https, so relying on 'self' alone
    // would silently drop both realtime lanes in Safari. A bare ws: (the old
    // shape) would admit cleartext sockets to ANY host. The LXC installer
    // renders nginx from a heredoc, so its dollar sign is shell-escaped.
    const sameHostWebSocket =
      relativePath === "deploy/lxc/install.sh"
        ? "ws://\\$http_host"
        : "ws://$http_host";
    const parentConnections = directive(parentPolicy, "connect-src");
    for (const allowed of [
      "'self'",
      // An object URL the page minted itself is readable only by that origin, so
      // listing blob: admits no new network destination -- but WITHOUT it every
      // fetch()/XHR against one (the Moments capture path hands its recorded Blob
      // to the uploader that way) fails as a connect-src violation in both Gecko
      // and Blink. `data:` stays OUT on purpose: a blocked data: fetch dumps the
      // entire payload into the violation report, and a data URL needs no fetch
      // at all -- decode it in-process (see fetchBoundedSourceBytes.ts).
      "blob:",
      "https:",
      "http://localhost:*",
      "http://127.0.0.1:*",
      sameHostWebSocket,
      "wss:",
    ]) {
      assert.ok(
        parentConnections.includes(allowed),
        `${relativePath}: ${allowed}`,
      );
    }
    assert.ok(!parentConnections.includes("http:"), relativePath);
    assert.ok(
      !parentConnections.includes("data:"),
      `${relativePath}: a blocked data: fetch reports the whole payload; decode data URLs in-process instead`,
    );
    assert.ok(
      !parentConnections.includes("ws:"),
      `${relativePath}: bare ws: admits cleartext sockets to any host`,
    );
    assert.ok(
      !parentConnections.some(
        (source) => source.startsWith("ws://") && source !== sameHostWebSocket,
      ),
      `${relativePath}: ws:// sources other than the page's own host`,
    );

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
    /location (?:\^~ )?\/sockets \{([\s\S]*?)\n    \}/,
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
    // Derived, not counted. Both forwarding headers were asserted as a
    // hardcoded "five occurrences" here, and 0c466fcc's compliant fifth route
    // (`location ~ ^/dav(/|$)`) turned this test red twice over on nothing but
    // the number. The expectation now comes from the routes the file actually
    // declares -- a `proxy_pass` found by matching braces, not by grepping a
    // word that also appears in three comments -- so a sixth route either
    // passes or is named here with the header it is missing.
    assert.deepEqual(
      forwardingContractErrors(source, {
        label: relativePath,
        forwardedFor: "$srn_forwarded_for",
        forwardedProto: "$srn_forwarded_proto",
        minimumRoutes: 5,
      }),
      [],
    );
    // Over the directives nginx will actually run, not the file: these two
    // denylists are about what the server does, and a commented-out example
    // route carrying the forbidden text turns a file-wide regex red over a
    // configuration that cannot reach the behaviour. A false alarm on a
    // compliant change is the same disease as a counter that goes stale on
    // one. The derivation above already blames the live route by name.
    const live = stripNginxComments(source);
    assert.doesNotMatch(
      live,
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
    assert.doesNotMatch(
      live,
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

  // Same derivation for the site the LXC installer writes, lifted out of its
  // heredoc so the comparison is against the `$remote_addr` nginx will see
  // rather than the `\$remote_addr` the shell holds.
  const lxcSite = extractLxcNginxSite(lxcInstaller);
  assert.ok(lxcSite, "the install.sh nginx heredoc must be locatable");
  assert.deepEqual(
    forwardingContractErrors(lxcSite.site, {
      label: "deploy/lxc/install.sh",
      forwardedFor: "$remote_addr",
      forwardedProto: "$scheme",
      minimumRoutes: 4,
      lineOffset: lxcSite.lineOffset,
    }),
    [],
  );
  assert.doesNotMatch(
    stripNginxComments(lxcSite.site),
    /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/,
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
  assert.equal(
    response.status,
    502,
    "the real upstream failure reaches the page",
  );
  // A cached 502 becomes the offline shell and is then served under the app CSP,
  // whose inline-script hash pins the real index.html — the proxy error page's
  // own inline script would be blocked as a script-src-elem violation.
  assert.deepEqual(
    cachePuts,
    [],
    "an error page must never enter the shell cache",
  );
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

// After a redeploy a page ran the NEW app.js beside the PREVIOUS build's lazy
// chunks: the worker's "network-first" branches were a plain fetch(request),
// which the HTTP cache answered from copies stored before nginx sent
// Cache-Control. Every shell and bundle fetch must make the HTTP cache
// revalidate, and going offline must still serve this build's cached copy.
function serviceWorkerHarness({ online }) {
  const listeners = new Map();
  const fetched = [];
  const cached = new Map([
    ["https://notes.example.test/5632.app.js", "cached chunk"],
    ["https://notes.example.test/app.js", "cached entry"],
    ["https://notes.example.test/", "cached shell"],
  ]);
  const keyOf = (request) =>
    typeof request === "string"
      ? new URL(request, "https://notes.example.test").href
      : request.url;
  const context = {
    URL,
    Request,
    Response,
    Promise,
    fetch: async (input) => {
      fetched.push(input);
      if (!online) {
        throw new TypeError("NetworkError");
      }
      return new Response("network body", { status: 200 });
    },
    caches: {
      open: async () => ({
        put: async () => undefined,
        match: async (request) => {
          const body = cached.get(keyOf(request));
          return body === undefined ? undefined : new Response(body);
        },
      }),
      match: async () => {
        throw new Error("the fallback must stay scoped to this build's cache");
      },
    },
    self: {
      location: { origin: "https://notes.example.test" },
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
  };
  runInNewContext(serviceWorker, context);
  const respond = async (request) => {
    let responsePromise;
    listeners.get("fetch")({
      request,
      respondWith: (value) => {
        responsePromise = Promise.resolve(value);
      },
    });
    assert.ok(responsePromise, `${request.url} must be intercepted`);
    return responsePromise;
  };
  return { fetched, respond };
}

test("the worker makes the HTTP cache revalidate every shell and bundle fetch", async () => {
  const { fetched, respond } = serviceWorkerHarness({ online: true });
  for (const url of [
    "https://notes.example.test/app.js",
    "https://notes.example.test/app.css",
    "https://notes.example.test/5632.app.js",
    "https://notes.example.test/12.0123456789abcdef0123.app.css",
  ]) {
    const response = await respond(new Request(url));
    assert.equal(await response.text(), "network body", url);
  }
  // A navigation-shaped request: a real one cannot be constructed outside a
  // browser, and the worker must not throw on either shape.
  const navigation = new Request("https://notes.example.test/");
  Object.defineProperty(navigation, "mode", { value: "navigate" });
  assert.equal(await (await respond(navigation)).text(), "network body");

  assert.equal(fetched.length, 5);
  for (const request of fetched) {
    assert.ok(request instanceof Request, String(request));
    assert.equal(
      request.cache,
      "no-cache",
      `${request.url} was fetched with cache "${request.cache}"; the HTTP cache may answer it with a previous build's copy`,
    );
  }
});

test("offline, the revalidating worker still serves this build's cached shell and chunks", async () => {
  const { respond } = serviceWorkerHarness({ online: false });
  assert.equal(
    await (
      await respond(new Request("https://notes.example.test/5632.app.js"))
    ).text(),
    "cached chunk",
  );
  assert.equal(
    await (
      await respond(new Request("https://notes.example.test/app.js"))
    ).text(),
    "cached entry",
  );
  const navigation = new Request("https://notes.example.test/");
  Object.defineProperty(navigation, "mode", { value: "navigate" });
  assert.equal(await (await respond(navigation)).text(), "cached shell");
});

test("the app script policy is byte-identical across all three topologies", () => {
  // One security policy, three hand-maintained copies (compose, single container,
  // LXC). The stale script-src-attr hash removed alongside this guard survived
  // precisely BECAUSE it was duplicated and nobody compared the copies, so compare
  // them: the script source lists must agree byte for byte, and a failure must name
  // the file that drifted. Only the script directives are compared here -- the LXC
  // installer renders nginx from a heredoc, so its connect-src carries a
  // shell-escaped dollar sign and legitimately differs in spelling.
  const shared = ["script-src", "script-src-attr"];
  const [reference, ...others] = configs.map(({ relativePath, source }) => {
    const policy = policyForLocation(source, "/");
    return {
      relativePath,
      directives: new Map(
        shared.map((name) => [name, directive(policy, name).join(" ")]),
      ),
    };
  });
  assert.ok(others.length >= 2, "every topology's config must be compared");

  for (const other of others) {
    for (const name of shared) {
      assert.equal(
        other.directives.get(name),
        reference.directives.get(name),
        `${other.relativePath} has drifted from ${reference.relativePath}: ${name}`,
      );
    }
  }
});

test("runtime CSP hashing cannot overwrite the fixed sandbox hash", () => {
  // A negative guard only: the positive guarantee -- that the rewrite cannot
  // escape its own directive -- is asserted BEHAVIOURALLY by the scope test
  // below, because any assertion on the substitution's spelling can be satisfied
  // by a future edit that still reaches the sandbox hash.
  assert.doesNotMatch(
    dockerEntrypoint,
    /sed -i "s\|'sha256-\[A-Za-z0-9\+\/_=\]\*'/,
  );

  // Both topologies must walk EVERY inline script rather than hashing the first
  // one and stopping: an unpinned second inline script is refused by the browser
  // with the build, the bundle assertions and this suite all still green.
  for (const [name, source] of [
    ["app/docker/docker-entrypoint.sh", dockerEntrypoint],
    ["deploy/lxc/install.sh", lxcInstaller],
  ]) {
    assert.match(source, /awk -v want=/, name);
    assert.match(source, /seen\s*==\s*want/, name);
    assert.match(source, /count.*-ge 1|-ge 1/, name);
  }
});

test("the runtime CSP rewrite cannot escape script-src and is a fixed point", () => {
  const temporaryDirectory = mkdtempSync(path.join(root, ".tmp-csp-scope-"));
  const relative = (filePath) =>
    path.relative(root, filePath).split(path.sep).join("/");
  const indexPath = path.join(temporaryDirectory, "index.html");
  const configPath = path.join(temporaryDirectory, "nginx.conf");
  const parentScriptSrc = /script-src 'self' 'wasm-unsafe-eval'[^;]*;/;
  // A well-formed hash source living OUTSIDE the parent script-src. A rewrite
  // that reached past its directive would corrupt this and the sandbox hash, so
  // the property is observable rather than a matter of how the sed is spelled.
  const decoy = `'sha256-${createHash("sha256").update("csp-scope-decoy").digest("base64")}'`;

  try {
    writeFileSync(indexPath, read("app/packages/web/src/index.html"));
    // Swap the real script-src-attr for one carrying the decoy. Split/join rather
    // than a bare .replace, and assert the fragment occurs EXACTLY once first: a
    // single-occurrence .replace silently stops testing its own target the day the
    // fragment appears twice, and this fragment is a directive that also gets
    // discussed in the comments right above it.
    const config = read("app/docker/nginx.conf");
    const attrDirective = /script-src-attr '[^;"]*;/g;
    const attrMatches = config.match(attrDirective) ?? [];
    assert.equal(
      attrMatches.length,
      1,
      `expected exactly one script-src-attr directive, found ${attrMatches.length}`,
    );
    const original = config
      .split(attrMatches[0])
      .join(`script-src-attr 'unsafe-hashes' ${decoy};`);
    assert.ok(original.includes(decoy), "the decoy source must be installed");
    assert.match(original, parentScriptSrc, "the parent script-src must match");
    writeFileSync(configPath, original);

    const run = () =>
      spawnSync("sh", ["app/docker/docker-entrypoint.sh"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          SRN_ENTRYPOINT_INDEX_HTML: relative(indexPath),
          SRN_ENTRYPOINT_NGINX_CONF: relative(configPath),
        },
      });

    const first = run();
    assert.equal(first.status, 0, first.stderr || first.error?.message);
    const afterFirst = readFileSync(configPath, "utf8");

    // THE PROPERTY: every byte outside the parent script-src directive is
    // untouched, so hashing can reach neither the sandbox runner's fixed hash nor
    // any other policy, whatever substitution is used to do the rewrite.
    assert.equal(
      afterFirst.replace(parentScriptSrc, "<parent-script-src>"),
      original.replace(parentScriptSrc, "<parent-script-src>"),
      "the rewrite must not change any byte outside the parent script-src",
    );
    assert.ok(
      afterFirst.includes(decoy),
      "a hash source outside script-src must survive the rewrite",
    );
    assert.ok(
      afterFirst.includes(`script-src 'unsafe-eval' '${sandboxRunnerHash()}`),
      "the fixed sandbox hash must survive the rewrite",
    );
    assert.notEqual(
      afterFirst,
      original,
      "the rewrite must actually have replaced the placeholder",
    );

    // IDEMPOTENT: running the substitution again over its own output changes
    // nothing. An entrypoint that appended instead would grow the header on every
    // container start and look fine for weeks.
    const second = run();
    assert.equal(second.status, 0, second.stderr || second.error?.message);
    assert.equal(
      readFileSync(configPath, "utf8"),
      afterFirst,
      "re-running over its own output must be a fixed point",
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("docker CSP hashing pins EVERY inline script in the served index.html", () => {
  const temporaryDirectory = mkdtempSync(path.join(root, ".tmp-csp-multi-"));
  const relative = (filePath) =>
    path.relative(root, filePath).split(path.sep).join("/");
  const indexPath = path.join(temporaryDirectory, "index.html");
  const configPath = path.join(temporaryDirectory, "nginx.conf");
  const firstBody = "\n  window.first = 1\n";
  const secondBody = "\n  window.second = 2\n";

  try {
    writeFileSync(
      indexPath,
      [
        "<!doctype html><html><head>",
        "<!-- a commented <script>ignored</script> -->",
        `<script>${firstBody}</script>`,
        `<script>${secondBody}</script>`,
        '<script src="./app.js"></script>',
        "</head><body></body></html>",
        "",
      ].join("\n"),
    );
    writeFileSync(configPath, read("app/docker/nginx.conf"));

    const result = spawnSync("sh", ["app/docker/docker-entrypoint.sh"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SRN_ENTRYPOINT_INDEX_HTML: relative(indexPath),
        SRN_ENTRYPOINT_NGINX_CONF: relative(configPath),
      },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);

    const hashFor = (body) =>
      `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`;
    const config = readFileSync(configPath, "utf8");
    const rewritten = config.match(
      /script-src 'self' 'wasm-unsafe-eval'[^;]*;/,
    )?.[0];
    assert.equal(
      rewritten,
      `script-src 'self' 'wasm-unsafe-eval' '${hashFor(firstBody)}' '${hashFor(secondBody)}';`,
      "both inline scripts must be pinned, and the commented and external ones must not be",
    );
    assert.ok(
      config.includes(`script-src 'unsafe-eval' '${sandboxRunnerHash()}`),
      "the fixed sandbox hash must survive a multi-script rewrite",
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

// The pin is only worth anything if the bytes the entrypoint hashes are the bytes
// nginx serves. The fixture above proves the entrypoint finds the right NUMBER of
// scripts; it cannot prove byte-exactness, because its script bodies are plain
// one-liners. Two shapes used to break that equality while the entrypoint still
// exited 0 and started nginx with a pin describing bytes nobody serves -- the
// mechanism's whole purpose, defeated silently, visible only as a
// script-src-elem violation in a user's console:
//
//   * a body containing `<!--` (any JS string that builds markup): a
//     document-wide comment strip deleted that run of bytes before hashing.
//   * `<script data-srcless>`: `src` matched as a bare substring of the opening
//     tag, so a served INLINE script was skipped as external and left unpinned.
//
// Each case asserts the pinned hash equals the sha256 of the exact bytes between
// the opening `>` and `</script>` -- the definition a browser applies.
test("docker CSP hashing pins the exact served bytes, not an approximation of them", () => {
  const cases = [
    {
      label:
        "a body containing an HTML comment opener is script source, not a comment",
      body: '\n  var tpl = "<!-- placeholder -->"\n  window.a = tpl\n',
      openingTag: "<script>",
    },
    {
      label:
        "`src` must be a real attribute, not a substring of the opening tag",
      body: "\n  window.a = 1\n",
      openingTag: '<script data-srcless="1">',
    },
  ];

  for (const { label, body, openingTag } of cases) {
    const temporaryDirectory = mkdtempSync(path.join(root, ".tmp-csp-bytes-"));
    const relative = (filePath) =>
      path.relative(root, filePath).split(path.sep).join("/");
    const indexPath = path.join(temporaryDirectory, "index.html");
    const configPath = path.join(temporaryDirectory, "nginx.conf");

    try {
      writeFileSync(
        indexPath,
        [
          "<!doctype html><html><head>",
          `${openingTag}${body}</script>`,
          '<script src="./app.js"></script>',
          "</head><body></body></html>",
          "",
        ].join("\n"),
      );
      writeFileSync(configPath, read("app/docker/nginx.conf"));

      const result = spawnSync("sh", ["app/docker/docker-entrypoint.sh"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          SRN_ENTRYPOINT_INDEX_HTML: relative(indexPath),
          SRN_ENTRYPOINT_NGINX_CONF: relative(configPath),
        },
      });
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);

      // Re-read the served document and hash the body the way a browser does,
      // rather than trusting the literal above, so the assertion keeps holding
      // if the runtime templating ever rewrites these bytes.
      const served = readFileSync(indexPath, "utf8");
      const start = served.indexOf(">", served.indexOf(openingTag)) + 1;
      const servedBody = served.slice(
        start,
        served.indexOf("</script>", start),
      );
      assert.equal(
        servedBody,
        body,
        `${label}: fixture body is not served verbatim`,
      );

      const expected = `sha256-${createHash("sha256")
        .update(servedBody, "utf8")
        .digest("base64")}`;
      assert.equal(
        readFileSync(configPath, "utf8").match(
          /script-src 'self' 'wasm-unsafe-eval'([^;]*);/,
        )?.[1],
        ` '${expected}'`,
        `${label}: the pin must be the sha256 of the exact served bytes`,
      );
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
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

/**
 * Does this config pin that hash on the app-shell directive?
 *
 * A plain substring test on purpose. These assertions used to build a RegExp
 * straight from the digest, and a base64 sha256 contains `+` and `/` -- regex
 * metacharacters. `'sha256-...JY+EvRx...'` compiles to "one or more Y followed
 * by E", which matches nothing, so the assertion passed only while the digest
 * happened to contain neither character. It broke the first time an edit to
 * index.html produced a hash with a `+` in it.
 */
const pinnedBy = (configSource, hash) =>
  configSource.includes(`wasm-unsafe-eval' '${hash}`);

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
    assert.ok(
      pinnedBy(readFileSync(configPath, "utf8"), firstHash),
      `the config must pin ${firstHash}`,
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
    assert.ok(
      pinnedBy(twiceStartedConfig, secondHash),
      `a restart must pin ${secondHash}`,
    );
    assert.ok(
      !pinnedBy(twiceStartedConfig, firstHash),
      `a restart must not leave ${firstHash} behind`,
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
    assert.ok(
      pinnedBy(failedConfig, secondHash),
      `failed hashing must leave ${secondHash} in place`,
    );
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
      open: async () => ({
        put: async () => undefined,
        match: async () => undefined,
      }),
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

test("lazy chunk names carry exactly the content hash nginx marks immutable", () => {
  // A chunk whose name survives a redeploy while its bytes change lets a tab
  // run the new build's chunk beside its old entry. The names must change with
  // the content, and their shape must be the one the nginx maps make immutable;
  // a longer or shorter hash would silently fall back to no-cache, and an
  // unhashed name marked immutable would be the original bug forever.
  assert.match(
    webWebpack,
    /chunkFilename: '\.\/\[id\]\.\[contenthash:20\]\.app\.js'/,
  );
  assert.match(
    webWebpack,
    /chunkFilename: '\.\/\[id\]\.\[contenthash:20\]\.app\.css'/,
  );
  const immutable =
    /"~\^\/\[\^\/\]\+\\\.\[0-9a-f\]\{20\}\\\.app\\\.\(js\|css\)\\?\$"\s+"public, max-age=31536000, immutable";/;
  for (const { relativePath, source } of configs) {
    assert.match(source, immutable, relativePath);
  }
  // The worker branch still recognises the hashed chunks as bundle files.
  assert.match(
    serviceWorker,
    /url\.pathname\.endsWith\('app\.js'\) \|\| url\.pathname\.endsWith\('app\.css'\)/,
  );
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
  // that shell fails the per-deploy inline-script hash pin. Hashed chunks and
  // the stale-build notice protect the running page; refresh stays a user action.
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
    /if \(!hadControllerAtLoad\)/,
    "the first-visit claim must not be mistaken for an update notice",
  );
  assert.match(
    registration,
    /showAppUpdateToast\(\(\) => window\.location\.reload\(\)\)/,
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

// ---------------------------------------------------------------------------
// Outbound-link hygiene
// ---------------------------------------------------------------------------

function collectComponentFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectComponentFiles(full));
    } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".spec.")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Recover the JSX opening tag that encloses `index`.
 *
 * Walks back to the tag's `<` and forward to the `>` that closes it, tracking
 * brace depth and quote state because a JSX attribute expression and a quoted
 * attribute value can both contain a bare `>`. Returns null when no enclosing
 * tag can be recovered, which the caller treats as a failure rather than a
 * pass — an unparseable tag must not be silently admitted.
 */
function enclosingJsxTag(source, index) {
  const start = source.lastIndexOf("<", index);
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const character = source[i];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    } else if (character === ">" && depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  return null;
}

test("every new-tab link in the web app denies the opener and the referrer", () => {
  // A `target` of the blank keyword in any of its JSX spellings.
  const newTabTarget = /target\s*=\s*(?:"|'|\{\s*['"])_blank/g;
  // Either token severs `window.opener`; `noreferrer` additionally withholds
  // the Referer, which would otherwise disclose this instance's origin to the
  // third party. Requiring only one of the two keeps the existing
  // `rel="noreferrer"` call sites correct, which they are.
  const opensSafely = /\brel\s*=\s*["'][^"']*(?:noopener|noreferrer)/;

  const files = collectComponentFiles(
    path.join(root, "app/packages/web/src/javascripts"),
  );
  assert.ok(
    files.length > 100,
    "the scan must reach the whole component tree, not a stale subdirectory",
  );

  const offenders = [];
  let examined = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    newTabTarget.lastIndex = 0;
    let match = newTabTarget.exec(source);
    while (match !== null) {
      examined += 1;
      const tag = enclosingJsxTag(source, match.index);
      if (tag === null || !opensSafely.test(tag)) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(
          `${path.relative(root, file).split(path.sep).join("/")}:${line}`,
        );
      }
      match = newTabTarget.exec(source);
    }
  }

  // Guards the guard: a scan that found nothing to examine would pass while
  // asserting nothing, which is how this class of check goes quietly inert.
  assert.ok(
    examined >= 10,
    `expected the web app to still contain new-tab links; examined ${examined}`,
  );
  assert.deepEqual(
    offenders,
    [],
    "these new-tab links carry neither noopener nor noreferrer",
  );
});

test("the CSP inline-script pin is verified against the served document, not just substituted", () => {
  // The hole this closes, and why a test is warranted: `apply_csp_inline_hash`
  // ended with `grep -Fq "script-src 'self' 'wasm-unsafe-eval' ${_sources};"`,
  // which asserts that the string the preceding `sed` just wrote is present --
  // true by construction -- and the check before it asserts only that there is
  // exactly one directive to rewrite. Both pass over a hash that does not
  // authorise the script it names, and a browser then silently refuses the
  // bootstrap: `window.defaultSyncServer` is undefined, sync has no host, and
  // the stale-service-worker recovery handler that would have rescued the blank
  // page is itself inside the blocked script.
  //
  // `verify_csp_inline_hash` is a safety net against states the entrypoint
  // cannot itself produce -- another layer editing the served document after
  // the pin, a `sed` that matched a different span, a hash left behind by an
  // earlier start. A full boot always re-derives and therefore self-heals, so
  // the only way to exercise the net is to drive the function directly. That is
  // what this does, with the real code lifted out of the real file.
  const functionSource = (name) => {
    const match = dockerEntrypoint.match(
      new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m"),
    );
    assert.ok(match, `${name} must exist in app/docker/docker-entrypoint.sh`);
    return match[0];
  };
  const extract = functionSource("extract_inline_script");
  const verify = functionSource("verify_csp_inline_hash");
  // The net has to re-derive from the file rather than reuse the values the
  // computation above produced, or it proves nothing.
  assert.match(verify, /extract_inline_script "\$INDEX_HTML"/);
  assert.match(verify, /sha256sum/);

  const temporaryDirectory = mkdtempSync(path.join(root, ".tmp-csp-verify-"));
  const indexPath = path.join(temporaryDirectory, "index.html");
  const configPath = path.join(temporaryDirectory, "nginx.conf");
  const driverPath = path.join(temporaryDirectory, "driver.sh");
  const relative = (filePath) =>
    path.relative(root, filePath).split(path.sep).join("/");

  writeFileSync(
    driverPath,
    [
      'INDEX_HTML="$1"',
      'CONF="$2"',
      extract,
      verify,
      "verify_csp_inline_hash",
      "",
    ].join("\n"),
  );

  const boot = () =>
    spawnSync("sh", ["app/docker/docker-entrypoint.sh"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SRN_ENTRYPOINT_INDEX_HTML: relative(indexPath),
        SRN_ENTRYPOINT_NGINX_CONF: relative(configPath),
      },
    });
  const verifyOnly = () =>
    spawnSync(
      "sh",
      [relative(driverPath), relative(indexPath), relative(configPath)],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
  const reset = () => {
    writeFileSync(indexPath, read("app/packages/web/src/index.html"));
    writeFileSync(configPath, read("app/docker/nginx.conf"));
  };
  /** The source list the config now authorises. */
  const pinned = () =>
    readFileSync(configPath, "utf8").match(
      /script-src 'self' 'wasm-unsafe-eval'([^;]*);/,
    )?.[1];

  try {
    // 1. The healthy case must PASS, or the net is just a broken boot.
    reset();
    const healthy = boot();
    assert.equal(healthy.status, 0, healthy.stderr || healthy.error?.message);
    assert.match(healthy.stdout, /CSP inline-script pin verified/);
    assert.equal(verifyOnly().status, 0);
    // And it must not have tripped on the copy of the placeholder that
    // nginx.conf DOCUMENTS a few lines above the directive using it.
    assert.ok(
      readFileSync(configPath, "utf8").includes("__CSP_INLINE_SCRIPT_HASH__"),
      "the comment mentioning the placeholder is expected to survive",
    );

    // 2. The served document changes after the pin -- the shape that shipped.
    reset();
    assert.equal(boot().status, 0);
    const pinnedBefore = pinned();
    writeFileSync(
      indexPath,
      readFileSync(indexPath, "utf8").replace(
        "window.ocrEnabled = false",
        "window.ocrEnabled = false /* edited by a later layer */",
      ),
    );
    const drifted = verifyOnly();
    assert.notEqual(
      drifted.status,
      0,
      "a pin that no longer matches must fail",
    );
    assert.match(
      drifted.stderr,
      /does not authorise the served inline scripts/,
    );
    // The operator must be handed the hash the document needs, not a white page.
    assert.match(drifted.stderr, /policy:/);
    assert.match(
      drifted.stderr,
      /document:\s+script-src 'self' 'wasm-unsafe-eval' 'sha256-/,
    );
    // The OLD checks pass over this exact state, which is why it shipped.
    const configuration = readFileSync(configPath, "utf8");
    assert.equal(
      (configuration.match(/script-src 'self' 'wasm-unsafe-eval' /g) ?? [])
        .length,
      1,
    );
    assert.ok(
      configuration.includes(
        `script-src 'self' 'wasm-unsafe-eval'${pinnedBefore};`,
      ),
      "the old containment check passes here, which is the point",
    );

    // 3. An unsubstituted placeholder in the live directive authorises nothing.
    reset();
    const unsubstituted = verifyOnly();
    assert.notEqual(unsubstituted.status, 0);
    assert.match(
      unsubstituted.stderr,
      /still carries the __CSP_INLINE_SCRIPT_HASH__ placeholder/,
    );

    // 4. A second inline script appearing after the pin is refused rather than
    //    silently unexecuted.
    reset();
    assert.equal(boot().status, 0);
    writeFileSync(
      indexPath,
      readFileSync(indexPath, "utf8").replace(
        "</head>",
        "  <script>window.secondScript = 1</script>\n  </head>",
      ),
    );
    const unpinned = verifyOnly();
    assert.notEqual(unpinned.status, 0);
    assert.match(
      unpinned.stderr,
      /does not authorise the served inline scripts/,
    );

    // 5. A stale hash left beside the correct one is also a mismatch: set
    //    equality, not containment.
    reset();
    assert.equal(boot().status, 0);
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        "script-src 'self' 'wasm-unsafe-eval' ",
        "script-src 'self' 'wasm-unsafe-eval' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' ",
      ),
    );
    const stale = verifyOnly();
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /does not authorise the served inline scripts/);

    // 6. Booting twice must not accumulate hashes, and must still verify.
    reset();
    assert.equal(boot().status, 0);
    const first = pinned();
    const second = boot();
    assert.equal(second.status, 0, second.stderr || second.error?.message);
    assert.equal(pinned(), first, "a restart must not accumulate pins");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the docker and LXC CSP inline-script extractors are the same implementation", () => {
  // Two implementations of one digest is the defect. deploy/lxc/install.sh used
  // to carry a shorter variant that built a comment-stripped copy of the buffer
  // and cut the script body out of THAT, and it diverged from the docker one on
  // four shapes -- two of them silently wrong rather than failing closed:
  //
  //   - a body containing the characters `<!--` had everything up to the next
  //     `-->` deleted from the hashed bytes (measured: an 83-byte body hashed as
  //     40), so the pin authorised bytes the browser never sees;
  //   - an opening tag merely CONTAINING the letters `src` (`data-srcset`) was
  //     taken for an external script and never pinned at all;
  //   - `</script >` with a space and `<SCRIPT>` in capitals were not found,
  //     which at least fails the install closed.
  //
  // A deployment whose bootstrap is refused comes up with
  // `window.defaultSyncServer` undefined and no sync host, so this is worth a
  // gate rather than a comment.
  const bodyOf = (source, name, where) => {
    const match = source.match(
      new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m"),
    );
    assert.ok(match, `${name} must exist in ${where}`);
    // Compare the implementation, not the name it is bound to.
    return match[0].replace(new RegExp(`^${name}`), "<fn>");
  };

  const dockerBody = bodyOf(
    dockerEntrypoint,
    "extract_inline_script",
    "app/docker/docker-entrypoint.sh",
  );
  const lxcBody = bodyOf(
    lxcInstaller,
    "extract_staged_inline_script",
    "deploy/lxc/install.sh",
  );

  assert.equal(
    lxcBody,
    dockerBody,
    "deploy/lxc/install.sh must carry a byte-for-byte copy of the docker extractor",
  );

  // Guard the guard: an empty or trivial match would compare nothing.
  assert.ok(
    dockerBody.length > 400,
    `the extractor looks too short to be the real one (${dockerBody.length} chars)`,
  );
  // And the properties the weaker variant lacked, named so a rewrite that drops
  // one is caught even if both files are rewritten together.
  assert.match(dockerBody, /tolower\(buf\)/, "match on a lowercase mirror");
  assert.match(
    dockerBody,
    /substr\(buf, bodystart, ce - 1\)/,
    "cut the hashed bytes from the UNTOUCHED buffer",
  );
  assert.match(
    dockerBody,
    /src\[ \\t\\r\\n\]\*=/,
    "require `src` to be a real attribute, not any occurrence of the letters",
  );
  assert.match(dockerBody, /"<\/script"/, "accept `</script >`");

  // Both paths must verify the pin, not merely substitute it.
  assert.match(dockerEntrypoint, /^verify_csp_inline_hash\(\) \{/m);
  assert.match(
    lxcInstaller,
    /the staged CSP does not authorise the inline scripts/,
  );
  for (const [where, source] of [
    ["app/docker/docker-entrypoint.sh", dockerEntrypoint],
    ["deploy/lxc/install.sh", lxcInstaller],
  ]) {
    assert.match(
      source,
      /__CSP_INLINE_SCRIPT_HASH__'; then|__CSP_INLINE_SCRIPT_HASH__'; then|grep -Fq '__CSP_INLINE_SCRIPT_HASH__'/,
      `${where} must refuse a surviving placeholder`,
    );
  }
});

// Exercise the actual worker rather than asserting its policy with source regexes.
function assetWorkerHarness({
  fetcher,
  failRead = false,
  failWrite = false,
} = {}) {
  const listeners = new Map();
  const cached = new Map();
  const fetched = [];
  const lifetime = [];
  const response = (text, status = 200) => {
    const value = new Response(text, { status });
    Object.defineProperty(value, "type", { value: "basic" });
    return value;
  };
  const fetchAsset = async (request) => {
    fetched.push(request.url);
    return fetcher ? fetcher(request) : response("fresh");
  };
  const key = (request) =>
    typeof request === "string" ? request : request.url;
  runInNewContext(serviceWorker, {
    URL,
    Request,
    Response,
    Promise,
    fetch: fetchAsset,
    caches: {
      open: async () => ({
        match: async (request) => {
          if (failRead) throw new Error("Cache unavailable");
          return cached.get(key(request))?.clone();
        },
        put: async (request, value) => {
          if (failWrite) throw new Error("Quota exceeded");
          cached.set(key(request), value);
        },
      }),
    },
    self: {
      location: { origin: "https://notes.example.test" },
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
  });
  const dispatch = async (path) => {
    const request = new Request(new URL(path, "https://notes.example.test"));
    let result;
    listeners.get("fetch")({
      request,
      respondWith: (value) => {
        result = value;
      },
      waitUntil: (value) => {
        lifetime.push(value);
      },
    });
    return {
      intercepted: result !== undefined,
      response: await (result ?? fetchAsset(request)),
    };
  };
  return {
    cached,
    fetched,
    response,
    dispatch,
    settle: () => Promise.all(lifetime),
  };
}

test("health probes bypass even a previously cached healthy response", async () => {
  const h = assetWorkerHarness({
    fetcher: async () => new Response("unavailable", { status: 503 }),
  });
  for (const path of [
    "/health",
    "/healthcheck",
    "/healthcheck/readiness",
    "/healthcheck/liveness",
  ]) {
    h.cached.set(
      `https://notes.example.test${path}`,
      h.response("old healthy"),
    );
    const result = await h.dispatch(path);
    assert.equal(result.intercepted, false, path);
    assert.equal(result.response.status, 503, path);
  }
});

test("a cached content-hashed WASM is reused without a background fetch", async () => {
  const h = assetWorkerHarness();
  const path = "/libsodium-sumo.29dd7daf12daec2afdf7.wasm";
  h.cached.set(`https://notes.example.test${path}`, h.response("cached wasm"));
  for (let i = 0; i < 10; i++) {
    assert.equal(await (await h.dispatch(path)).response.text(), "cached wasm");
  }
  assert.equal(h.fetched.length, 0);
});

test("parallel hashed WASM cache misses share one fetch and have independently readable bodies", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = assetWorkerHarness({
    fetcher: async () => {
      await gate;
      return h.response("wasm bytes");
    },
  });
  const pending = Array.from({ length: 8 }, () =>
    h.dispatch("/libsodium-sumo.29dd7daf12daec2afdf7.wasm"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.fetched.length, 1);
  release();
  for (const result of await Promise.all(pending))
    assert.equal(await result.response.text(), "wasm bytes");
  await h.settle();
  assert.equal(h.cached.size, 1);
});

test("cache storage failure never blocks loading a hashed WASM from the network", async () => {
  for (const options of [{ failRead: true }, { failWrite: true }]) {
    const h = assetWorkerHarness(options);
    const result = await h.dispatch(
      "/libsodium-sumo.29dd7daf12daec2afdf7.wasm",
    );
    assert.equal(await result.response.text(), "fresh");
    await h.settle();
  }
});

test("unhashed assets retain background refresh and failed WASM fetches can retry", async () => {
  const h = assetWorkerHarness();
  h.cached.set("https://notes.example.test/logo.svg", h.response("old logo"));
  assert.equal(
    await (await h.dispatch("/logo.svg")).response.text(),
    "old logo",
  );
  assert.equal(h.fetched.length, 1);
  let attempts = 0;
  const failure = assetWorkerHarness({
    fetcher: async () => {
      if (++attempts === 1) throw new Error("Temporary failure");
      return failure.response("recovered");
    },
  });
  await assert.rejects(failure.dispatch("/sodium.29dd7daf12daec2afdf7.wasm"));
  assert.equal(
    await (
      await failure.dispatch("/sodium.29dd7daf12daec2afdf7.wasm")
    ).response.text(),
    "recovered",
  );
  assert.equal(attempts, 2);
});

test("online static assets and bundles stay readable when cache reads or writes fail", async () => {
  for (const path of ["/logo.svg", "/font.woff2", "/app.js", "/app.css"]) {
    for (const options of [{ failRead: true }, { failWrite: true }]) {
      const h = assetWorkerHarness(options);
      assert.equal(
        await (await h.dispatch(path)).response.text(),
        "fresh",
        path,
      );
      await h.settle();
    }
  }
});
