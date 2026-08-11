import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const dockerEntrypoint = read("app/docker/docker-entrypoint.sh");
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

    const sandboxPolicy = policyForLocation(source, "=\\s*/sandbox\\.html");
    assert.deepEqual(directive(sandboxPolicy, "script-src"), [
      "'unsafe-eval'",
      `'${runnerHash}'`,
    ]);
    assert.deepEqual(directive(sandboxPolicy, "connect-src"), ["'none'"]);
    assert.deepEqual(directive(sandboxPolicy, "frame-src"), ["'none'"]);
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
  assert.ok(documentedSocketProxy, "documented outer websocket location missing");
  for (const header of [
    "Host              $host",
    "X-Real-IP         $remote_addr",
    "X-Forwarded-For   $proxy_add_x_forwarded_for",
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
    (sandboxEditor.match(/src=\{`\/sandbox\.html#\$\{runNonce\}`\}/g) ?? [])
      .length,
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
    /claimSandboxRunDelivery\(deliveredRunNonce, runNonce\)/,
  );
  assert.match(runnerHtml, /event\.source !== parent/);
  assert.match(runnerHtml, /event\.data\.channel !== runChannel/);
  assert.match(runnerHtml, /event\.data\.nonce !== runNonce/);
  assert.match(runnerHtml, /didRun \|\|/);
  assert.match(serviceWorker, /SANDBOX_PATH\s*=\s*['"]\/sandbox\.html['"]/);
  assert.match(serviceWorker, /CORE_SHELL[^\n]+SANDBOX_PATH/);
  assert.match(webWebpack, /from: ['"]src\/sandbox\.html['"]/);
});

test("sandbox console transport bounds message size and frequency before crossing the frame", () => {
  const runnerScript = runnerHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(runnerScript, "sandbox runner script missing");

  const messages = [];
  const listeners = new Map();
  const parent = {
    postMessage: (message) => messages.push(message),
  };
  const noop = () => undefined;
  const context = {
    console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
    document: {
      getElementById: (id) =>
        id === "sandbox-style" ? { textContent: "" } : { innerHTML: "" },
    },
    location: { hash: "#bounded-run" },
    parent,
    window: {
      addEventListener: (type, listener) => {
        const registered = listeners.get(type) ?? [];
        registered.push(listener);
        listeners.set(type, registered);
      },
    },
  };

  runInNewContext(runnerScript, context);
  const receiveRun = listeners.get("message")?.[0];
  assert.ok(receiveRun, "sandbox run listener missing");
  receiveRun({
    source: parent,
    data: {
      channel: "__SN_SANDBOX_RUN__",
      nonce: "bounded-run",
      captureConsole: true,
      document: {
        html: "",
        css: "",
        js: "for (var i = 0; i < 250; i += 1) console.log(i + ':' + 'x'.repeat(17000))",
      },
    },
  });

  assert.equal(messages.length, 200);
  assert.equal(messages[0].message.length, 16384);
  assert.match(messages[0].message, /\.\.\. \[truncated\]$/);
  assert.ok(messages.every((message) => message.message.length <= 16384));
  assert.equal(messages.at(-1).channel, "__SN_SANDBOX_CONSOLE__");
  assert.equal(messages.at(-1).level, "warn");
  assert.equal(
    messages.at(-1).message,
    "Console output limit reached; further messages were dropped.",
  );
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
      match: async (request) => {
        cacheLookups.push(request);
        if (request === "/index.html") {
          return new Response("<!doctype html><title>app shell</title>", {
            headers: { "Content-Type": "text/html" },
          });
        }
        return undefined;
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

test("docker CSP hashing rotates the parent hash across consecutive starts without changing the sandbox hash", () => {
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
    assert.match(
      twiceStartedConfig,
      new RegExp(`script-src 'unsafe-eval' '${sandboxRunnerHash()}`),
    );

    writeFileSync(indexPath, "<!doctype html><title>missing bootstrap</title>");
    const failedHashing = run("true");
    assert.equal(
      failedHashing.status,
      0,
      failedHashing.stderr || failedHashing.error?.message,
    );
    const fallbackConfig = readFileSync(configPath, "utf8");
    assert.match(
      fallbackConfig,
      /script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'/,
    );
    assert.match(
      fallbackConfig,
      new RegExp(`script-src 'unsafe-eval' '${sandboxRunnerHash()}`),
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
  assert.match(webPackage.scripts.build, /AssertPortableBundle\.mjs/);
  assert.match(portableBundleAssertion, /allowedFileUrls/);
  assert.match(portableBundleAssertion, /encodedSchemePattern/);
  assert.match(
    portableBundleAssertion,
    /path\.extname\(file\)[\s\S]*import\\\.meta/,
  );
});

test("portable-output assertion permits only the inert SheetJS literal and mjs import.meta", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(root, ".tmp-portable-bundle-"),
  );
  const assertionPath = path.join(
    root,
    "app/packages/web/scripts/AssertPortableBundle.mjs",
  );
  const classicPath = path.join(temporaryDirectory, "classic.js");
  const run = () =>
    spawnSync(process.execPath, [assertionPath, temporaryDirectory], {
      cwd: root,
      encoding: "utf8",
    });

  try {
    writeFileSync(classicPath, 'const fallback = "file:///C:/SheetJS/";');
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
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
