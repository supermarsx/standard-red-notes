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
