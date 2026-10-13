import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractLxcNginxSite,
  forwardingContractErrors,
  nginxProxyRoutes,
  parseNginxBlocks,
  staticCacheContractErrors,
  stripNginxComments,
} from "./nginx-route-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const sanitized = {
  forwardedFor: "$srn_forwarded_for",
  forwardedProto: "$srn_forwarded_proto",
};

const route = (location, extra = "") => `
  location ${location} {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header X-Forwarded-For $srn_forwarded_for;
    proxy_set_header X-Forwarded-Proto $srn_forwarded_proto;
${extra}  }
`;

const server = (body) => `server {\n  listen 8080;\n${body}}\n`;

function errorsFor(source, overrides = {}) {
  return forwardingContractErrors(source, {
    label: "fixture",
    minimumRoutes: 1,
    ...sanitized,
    ...overrides,
  });
}

// The whole point of parsing rather than grepping: `grep -c proxy_pass
// app/docker/nginx.conf` answers 8 where five routes exist, because three of
// those eight are prose inside comments. A derivation fooled by a comment is
// WEAKER than the stale counter it replaces, so every way a comment can lie is
// pinned here before the derivation is trusted on a real configuration.
test("comments cannot invent, hide, or satisfy a route", () => {
  // 1. `proxy_pass` named in prose is not a route.
  const prose = server(`
  # Using a literal hostname in proxy_pass makes nginx resolve it eagerly, so
  # a resolver plus a variable in proxy_pass defers resolution per request.
${route("/sockets")}`);
  assert.equal(nginxProxyRoutes(prose).routes.length, 1);
  assert.deepEqual(errorsFor(prose), []);

  // 2. A commented-out route is not a route -- neither counted nor blamed.
  const disabled = server(`
${route("/sockets")}
  # location /legacy/ {
  #   proxy_pass http://127.0.0.1:3000;
  #   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  # }
`);
  assert.deepEqual(
    nginxProxyRoutes(disabled).routes.map((entry) => entry.location),
    ["location /sockets"],
  );
  assert.deepEqual(errorsFor(disabled), []);

  // 3. A commented-out sanitized header does NOT satisfy its live route. This
  //    is the direction that would make the gate weaker than the counter: the
  //    header text is present in the file and absent from the running config.
  const commentedHeader = server(`
  location /sockets {
    proxy_pass http://127.0.0.1:3000;
    # proxy_set_header X-Forwarded-For $srn_forwarded_for;
    proxy_set_header X-Forwarded-Proto $srn_forwarded_proto;
  }
`);
  const commentedErrors = errorsFor(commentedHeader);
  assert.equal(commentedErrors.length, 1, commentedErrors.join("\n"));
  assert.match(commentedErrors[0], /location \/sockets" sets X-Forwarded-For/);

  // 4. A `#` inside a quoted value is data. Blanking from there to the end of
  //    the line would swallow the rest of the directive and could unbalance
  //    every brace that follows it.
  const quotedHash = server(`
  location = /health {
    add_header X-Note "see RFC 7239 #4 for the forwarded syntax";
    return 200 "ok";
  }
${route("/sockets")}`);
  assert.equal(nginxProxyRoutes(quotedHash).routes.length, 1);
  assert.deepEqual(errorsFor(quotedHash), []);
  assert.ok(
    stripNginxComments(quotedHash).includes("#4 for the forwarded syntax"),
  );
});

test("braces and semicolons inside a quoted value are data, not structure", () => {
  const policy = server(`
  location / {
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'sha256-{abc}'; object-src 'none'" always;
    try_files $uri /index.html;
  }
${route("/sockets")}`);
  const { routes, unlocated } = nginxProxyRoutes(policy);
  assert.deepEqual(unlocated, []);
  assert.deepEqual(
    routes.map((entry) => entry.location),
    ["location /sockets"],
  );
  assert.deepEqual(errorsFor(policy), []);
});

test("a route is attributed to the location that encloses its proxy_pass", () => {
  // A proxy_pass nested one block deeper -- in an `if`, or in a nested
  // location -- is still that location's route, and nginx applies the headers
  // of the nearest level that declares any. Reporting it as unlocated, or
  // skipping it, would let a route escape the contract.
  const nested = server(`
  location /files/ {
    proxy_set_header X-Forwarded-For $srn_forwarded_for;
    proxy_set_header X-Forwarded-Proto $srn_forwarded_proto;
    if ($request_method = POST) {
      proxy_pass http://127.0.0.1:3000;
    }
  }
`);
  const { routes, unlocated } = nginxProxyRoutes(nested);
  assert.deepEqual(unlocated, []);
  assert.deepEqual(
    routes.map((entry) => entry.location),
    ["location /files/"],
  );
  assert.deepEqual(errorsFor(nested), []);

  // Headers declared at the nested level win, exactly as nginx resolves them:
  // a nested block that declares ANY proxy_set_header inherits none.
  const overridden = server(`
  location /files/ {
    proxy_set_header X-Forwarded-For $srn_forwarded_for;
    proxy_set_header X-Forwarded-Proto $srn_forwarded_proto;
    location /files/raw/ {
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_pass http://127.0.0.1:3000;
    }
  }
`);
  const overriddenErrors = errorsFor(overridden, { minimumRoutes: 1 });
  assert.equal(overriddenErrors.length, 2, overriddenErrors.join("\n"));
  assert.match(
    overriddenErrors.join("\n"),
    /location \/files\/raw\/" sets X-Forwarded-For to "\$proxy_add_x_forwarded_for"/,
  );
  assert.match(
    overriddenErrors.join("\n"),
    /location \/files\/raw\/" sets X-Forwarded-Proto to nothing/,
  );
});

test("a proxy_pass no location encloses is reported, never ignored", () => {
  const serverScope = `server {
  listen 8080;
  proxy_set_header X-Forwarded-For $srn_forwarded_for;
  proxy_set_header X-Forwarded-Proto $srn_forwarded_proto;
  proxy_pass http://127.0.0.1:3000;
}
`;
  const { routes, unlocated } = nginxProxyRoutes(serverScope);
  assert.deepEqual(routes, []);
  assert.equal(unlocated.length, 1);
  assert.match(
    errorsFor(serverScope).join("\n"),
    /is not inside any location block/,
  );
});

test("the route floor stops the per-route check from passing vacuously", () => {
  // A for-loop over zero routes asserts nothing. A configuration that lost its
  // routes, or a parser that stopped finding them, must be a red and not a
  // silent pass -- that is the one number this contract still carries, and it
  // is a floor, so adding a route never makes it stale.
  assert.match(
    errorsFor(server("  location / { try_files $uri /index.html; }\n"), {
      minimumRoutes: 5,
    }).join("\n"),
    /found 0 proxied backend route\(s\) \(none\) but at least 5 are required/,
  );
  assert.match(
    errorsFor(server(route("/sockets")), { minimumRoutes: 5 }).join("\n"),
    /found 1 proxied backend route\(s\) \(location \/sockets\) but at least 5 are required/,
  );
  assert.deepEqual(
    errorsFor(server(route("/sockets")), { minimumRoutes: 1 }),
    [],
  );
});

test("an unbalanced brace is reported as a contract failure, never thrown", () => {
  // These parsers are handed deliberately mutated fixtures. A thrown exception
  // would fail the calling test for a reason unrelated to the invariant, so a
  // truncated or unbalanced configuration must come back as routes and errors.
  const truncated = `server {\n  listen 8080;\n${route("/sockets")}`;
  assert.equal(nginxProxyRoutes(truncated).routes.length, 1);
  const extraClose = `${server(route("/sockets"))}}\n}\n`;
  assert.equal(nginxProxyRoutes(extraClose).routes.length, 1);
  assert.deepEqual(parseNginxBlocks("}").blocks, []);
});

test("the LXC installer's nginx site is lifted out of its heredoc unescaped", () => {
  const installer = read("deploy/lxc/install.sh");
  const extracted = extractLxcNginxSite(installer);
  assert.ok(extracted, "the install.sh nginx heredoc must be locatable");

  // Unescaping `\$` is what makes the generated file parseable as nginx: the
  // shell writes `$remote_addr`, so a contract comparing against `\$remote_addr`
  // is comparing against text that never reaches nginx.
  assert.ok(extracted.site.includes("proxy_set_header Host $http_host;"));
  assert.doesNotMatch(extracted.site, /\\\$/);

  // The reported line must be openable in install.sh, not in the extract.
  const installerLines = installer
    .split("\n")
    .map((line) => line.replace(/\\([$`\\])/g, "$1"));
  const { routes } = nginxProxyRoutes(extracted.site);
  for (const entry of routes) {
    assert.equal(
      installerLines[entry.line + extracted.lineOffset - 1].trim(),
      `${entry.location} {`,
      `install.sh line ${entry.line + extracted.lineOffset} must be ${entry.location}`,
    );
  }
  assert.equal(extractLxcNginxSite("no heredoc here"), null);
});

test("every shipped nginx configuration satisfies the derived forwarding contract", () => {
  for (const relativePath of [
    "app/docker/nginx.conf",
    "app/docker/single/nginx.conf",
  ]) {
    const source = read(relativePath);
    assert.deepEqual(
      forwardingContractErrors(source, {
        label: relativePath,
        minimumRoutes: 5,
        ...sanitized,
      }),
      [],
    );
  }
  const extracted = extractLxcNginxSite(read("deploy/lxc/install.sh"));
  assert.ok(extracted);
  assert.deepEqual(
    forwardingContractErrors(extracted.site, {
      label: "deploy/lxc/install.sh",
      forwardedFor: "$remote_addr",
      forwardedProto: "$scheme",
      minimumRoutes: 4,
      lineOffset: extracted.lineOffset,
    }),
    [],
  );
});

// After a redeploy on one origin, a page ran the NEW app.js beside the PREVIOUS
// build's lazy chunks: nothing was served with Cache-Control (so the browser
// reused heuristically-fresh copies without asking), and a missing chunk was
// answered 200 with index.html. These pin the policy in all three topologies.
function shippedSites() {
  const extracted = extractLxcNginxSite(read("deploy/lxc/install.sh"));
  assert.ok(extracted, "the install.sh nginx heredoc must be locatable");
  return [
    ["app/docker/nginx.conf", read("app/docker/nginx.conf")],
    ["app/docker/single/nginx.conf", read("app/docker/single/nginx.conf")],
    ["deploy/lxc/install.sh", extracted.site],
  ];
}

test("every shipped nginx configuration revalidates unhashed files and 404s a missing asset", () => {
  const cacheMaps = new Set();
  for (const [label, site] of shippedSites()) {
    assert.deepEqual(staticCacheContractErrors(site, { label }), [], label);
    const maps = [
      /map \$uri \$srn_static_cache_control \{[\s\S]*?\n\}/,
      /map \$uri \$srn_missing_asset \{[\s\S]*?\n\}/,
    ].map((pattern) => site.replace(/\r\n/g, "\n").match(pattern)?.[0]);
    assert.ok(maps.every(Boolean), `${label}: both maps must be present`);
    cacheMaps.add(maps.join("\n"));
  }
  // One policy, three copies: a drifted copy is a topology that caches
  // differently from the others.
  assert.equal(cacheMaps.size, 1, [...cacheMaps].join("\n----\n"));
});

test("the caching contract names each way the policy can be broken", () => {
  const [, multi] = shippedSites()[0];
  const broken = (from, to) => {
    assert.ok(multi.includes(from), `fixture text missing: ${from}`);
    return staticCacheContractErrors(multi.split(from).join(to), {
      label: "fixture",
    }).join("\n");
  };
  assert.match(
    broken(
      'default                                  "no-cache";',
      'default                                  "max-age=3600";',
    ),
    /must default to "no-cache"/,
  );
  // An unhashed chunk name made immutable: the exact staleness this prevents.
  assert.match(
    broken(
      '"~^/[^/]+\\.[0-9a-f]{20}\\.app\\.(js|css)$" "public, max-age=31536000, immutable";',
      '"~^/[^/]+\\.app\\.(js|css)$" "public, max-age=31536000, immutable";',
    ),
    /only an anchored pattern that requires a \[0-9a-f\]\{20\} content hash/,
  );
  assert.match(
    broken(
      "    add_header Cache-Control $srn_static_cache_control always;\n",
      "",
    ),
    /location \/ must send/,
  );
  assert.match(
    broken(
      "try_files $uri $uri/ @srn_spa_fallback;",
      "try_files $uri $uri/ /index.html;",
    ),
    /location \/ must fall back through @srn_spa_fallback/,
  );
  assert.match(
    broken("      return 404;\n", ""),
    /must `return 404` inside `if \(\$srn_missing_asset\)`/,
  );
  assert.match(
    broken('"~*\\.(js|mjs|css|map|wasm)$"  1;', '"~*\\.(js|mjs|css)$"  1;'),
    /must flag \/app\.js\.map[\s\S]*must flag \/libsodium\.wasm/,
  );
  assert.match(
    broken(
      '"~*\\.(js|mjs|css|map|wasm)$"  1;',
      '"~*(js|mjs|css|map|wasm)$"  1;',
    ),
    /flags the client-side route \/tags\/js/,
  );
  // A location that declares its own add_header inherits none, so dropping
  // the sandbox's Cache-Control is a real loss even though `location /` has one.
  assert.match(
    broken(
      '    add_header Strict-Transport-Security $srn_hsts_header always;\n    add_header Cache-Control "no-cache" always;\n    try_files /sandbox.html =404;',
      "    add_header Strict-Transport-Security $srn_hsts_header always;\n    try_files /sandbox.html =404;",
    ),
    /"location = \/sandbox\.html" serves files without a Cache-Control header/,
  );
  // A Cache-Control in a comment is not one nginx sends.
  assert.match(
    broken(
      '    add_header Cache-Control "no-cache" always;\n    add_header Strict-Transport-Security $srn_hsts_header always;\n    try_files $uri =404;',
      '    # add_header Cache-Control "no-cache" always;\n    add_header Strict-Transport-Security $srn_hsts_header always;\n    try_files $uri =404;',
    ),
    /"location ~ \^\/assets\/pdf\/\[\^\/\]\+\\\.mjs\$" serves files without a Cache-Control header/,
  );
});
