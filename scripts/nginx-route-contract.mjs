// A small, quote-aware reader for the nginx configurations this repository
// ships, used by the proxy-forwarding contracts in
// scripts/validate-web-runtime-security.test.mjs and
// scripts/validate-lxc-deploy.test.mjs.
//
// Why this exists. Those contracts used to assert a hardcoded number of
// occurrences of each sanitized forwarding header -- "five
// `X-Forwarded-For $srn_forwarded_for`" and so on. 0c466fcc added a fifth
// backend route (`location ~ ^/dav(/|$)`), sanitized it correctly, and still
// turned three contract tests red, because the numbers had to be bumped by
// hand. A counter that goes stale on a compliant change is a gate that cries
// wolf, and the temptation on a red like that is to bump the number without
// re-checking the invariant.
//
// The durable form is to DERIVE the expectation from the routes actually
// present: every `proxy_pass` must sit in a location that overwrites the
// forwarding headers with the sanitized values, so adding a sixth route either
// passes or names the route that is missing one.
//
// The naive version of that derivation is weaker than the counter it replaces,
// which is why this file is a parser rather than a regex. `grep -c proxy_pass
// app/docker/nginx.conf` answers 8, not 5: three of those are prose inside
// comments. A derivation fooled by a comment can be fooled by a commented-out
// route, and a derivation that accepts a commented-out `proxy_set_header`
// scores a route as sanitized when it is not. So comments are stripped with a
// state machine that knows about quoting, braces are matched so each
// `proxy_pass` is attributed to the location that actually encloses it, and a
// `proxy_pass` that no location encloses is reported rather than ignored.
//
// Line numbers survive comment stripping (comment bytes are blanked, not
// removed) so a diagnostic can point at the offending route.

/**
 * Blank every comment byte, preserving length and newlines. An nginx comment
 * runs from an unquoted `#` to the end of the line; a `#` inside a quoted
 * value (a CSP, say) is data, not a comment.
 */
export function stripNginxComments(source) {
  const characters = source.split("");
  let quote = null;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote !== null) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") {
      while (index < characters.length && characters[index] !== "\n") {
        characters[index] = " ";
        index += 1;
      }
    }
  }
  return characters.join("");
}

/**
 * Parse a comment-stripped configuration into a block tree. Quoted runs are
 * copied verbatim into the pending token so a `{`, `}` or `;` inside a value
 * is never mistaken for structure. An unmatched `}` closes nothing rather than
 * throwing: these parsers are also handed deliberately mutated fixtures, and a
 * thrown exception would be indistinguishable from a real contract failure.
 */
export function parseNginxBlocks(source) {
  const text = stripNginxComments(source);
  const root = {
    header: "",
    headerOffset: 0,
    directives: [],
    blocks: [],
  };
  const stack = [root];
  let pending = "";
  let pendingOffset = 0;

  const append = (chunk, offset) => {
    if (pending === "") {
      pendingOffset = offset;
    }
    pending += chunk;
  };
  const token = () => {
    const text = pending.trim().replace(/\s+/g, " ");
    pending = "";
    return text;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'") {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === character) {
          break;
        }
        end += 1;
      }
      append(text.slice(index, Math.min(end + 1, text.length)), index);
      index = Math.min(end, text.length - 1);
      continue;
    }
    if (character === "{") {
      const headerOffset = pending.trim() === "" ? index : pendingOffset;
      const block = {
        header: token(),
        headerOffset,
        directives: [],
        blocks: [],
      };
      stack[stack.length - 1].blocks.push(block);
      stack.push(block);
      continue;
    }
    if (character === "}") {
      token();
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }
    if (character === ";") {
      const offset = pendingOffset;
      const directive = token();
      if (directive !== "") {
        stack[stack.length - 1].directives.push({ text: directive, offset });
      }
      continue;
    }
    if (pending === "" && /\s/.test(character)) {
      continue;
    }
    append(character, index);
  }
  return root;
}

function lineCounter(source) {
  const stripped = stripNginxComments(source);
  return (offset) => stripped.slice(0, offset).split("\n").length;
}

function headerName(directive) {
  const match = directive.match(/^proxy_set_header\s+(\S+)\s*(.*)$/);
  return match === null ? null : { name: match[1], value: match[2].trim() };
}

/**
 * Every `proxy_pass` in the configuration, attributed to the location block
 * that encloses it, with the `proxy_set_header` values that nginx would apply
 * to it.
 *
 * nginx inherits `proxy_set_header` from the enclosing level only when the
 * current level declares none of its own, so the headers reported for a route
 * are those of the nearest enclosing location that declares any -- walking out
 * through the block chain exactly as nginx does.
 */
export function nginxProxyRoutes(source) {
  const root = parseNginxBlocks(source);
  const lineOf = lineCounter(source);
  const routes = [];
  const unlocated = [];

  const visit = (block, chain) => {
    const nextChain = [...chain, block];
    for (const directive of block.directives) {
      if (!/^proxy_pass(\s|$)/.test(directive.text)) {
        continue;
      }
      const location = [...nextChain]
        .reverse()
        .find((entry) => /^location(\s|$)/.test(entry.header));
      if (location === undefined) {
        unlocated.push({
          proxyPass: directive.text,
          line: lineOf(directive.offset),
        });
        continue;
      }
      const declaring = [...nextChain]
        .reverse()
        .find((entry) =>
          entry.directives.some(
            (candidate) => headerName(candidate.text) !== null,
          ),
        );
      const headers = (declaring?.directives ?? [])
        .map((candidate) => headerName(candidate.text))
        .filter((candidate) => candidate !== null);
      routes.push({
        location: location.header,
        line: lineOf(location.headerOffset),
        proxyPass: directive.text,
        headers,
      });
    }
    for (const nested of block.blocks) {
      visit(nested, nextChain);
    }
  };
  visit(root, []);
  return { routes, unlocated };
}

/**
 * The forwarding-header contract, derived route by route.
 *
 * `minimumRoutes` is not an expectation that goes stale when a route is added:
 * it is the floor that stops the per-route loop from passing vacuously. A
 * `for` loop over an empty route list asserts nothing, so a parser that found
 * no routes -- or a configuration that lost them -- must be a failure and not a
 * silent pass.
 */
export function forwardingContractErrors(
  source,
  { label, forwardedFor, forwardedProto, minimumRoutes, lineOffset = 0 },
) {
  const { routes, unlocated } = nginxProxyRoutes(source);
  const errors = [];
  for (const orphan of unlocated) {
    errors.push(
      `${label}:${orphan.line + lineOffset}: "${orphan.proxyPass}" is not inside any location block, so no route-level forwarding header can be attributed to it`,
    );
  }
  if (routes.length < minimumRoutes) {
    errors.push(
      `${label}: found ${routes.length} proxied backend route(s) (${routes.map((route) => route.location).join(", ") || "none"}) but at least ${minimumRoutes} are required; a route-by-route forwarding check over fewer routes than that proves nothing`,
    );
  }
  for (const route of routes) {
    for (const [name, required] of [
      ["X-Forwarded-For", forwardedFor],
      ["X-Forwarded-Proto", forwardedProto],
    ]) {
      const declared = route.headers.find((header) => header.name === name);
      if (declared?.value !== required) {
        errors.push(
          `${label}:${route.line + lineOffset}: backend route "${route.location}" sets ${name} to ${declared === undefined ? "nothing" : `"${declared.value}"`} but every proxied backend route must overwrite it with ${required}`,
        );
      }
    }
  }
  return errors;
}

/**
 * The nginx site the LXC installer writes, lifted out of its unquoted heredoc.
 *
 * The body is shell, so `\$` there is a literal `$` in the generated file;
 * unescaping it is what makes the generated configuration parseable as nginx.
 * `lineOffset` maps a line of the extracted site back onto install.sh, so a
 * diagnostic names a line an operator can open.
 *
 * Returns null when the heredoc is not where it is expected, so a mutated
 * fixture produces a contract error rather than an exception.
 */
export function extractLxcNginxSite(installer) {
  const opening = 'cat > "${conf}" <<EOF\n';
  const start = installer.indexOf(opening);
  if (start < 0) {
    return null;
  }
  const bodyStart = start + opening.length;
  const end = installer.indexOf("\nEOF\n", bodyStart);
  if (end < 0) {
    return null;
  }
  return {
    site: installer.slice(bodyStart, end).replace(/\\([$`\\])/g, "$1"),
    lineOffset: installer.slice(0, bodyStart).split("\n").length - 1,
  };
}
