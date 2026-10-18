import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const { parse } = require('yaml');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

for (const [file, gateway] of [['docker-compose.yml', 'server'], ['docker-compose.single.yml', 'app']]) {
  test(`${file} provides isolated, nonblocking search with explicit overrides`, () => {
    const compose = parse(read(file), { merge: true });
    const search = compose.services['assistant-search'];
    assert.equal(search.ports, undefined);
    assert.equal(search.profiles, undefined);
    assert.equal(search.user, '977:977');
    assert.equal(search.read_only, true);
    assert.deepEqual(search.cap_drop, ['ALL']);
    assert.deepEqual(search.networks, ['assistant-search']);
    assert.match(search.image, /sha256:[a-f0-9]{64}/);
    assert.ok(compose.services[gateway].networks.includes('assistant-search'));
    assert.equal(compose.services[gateway].depends_on?.['assistant-search'], undefined);
    assert.equal(compose.services[gateway].environment.SEARCH_PROVIDER, '${SEARCH_PROVIDER:-searxng}');
    assert.equal(compose.services[gateway].environment.SEARCH_API_URL, '${SEARCH_API_URL:-}');
    for (const [name, service] of Object.entries(compose.services)) {
      if (name !== gateway && name !== 'assistant-search') {
        const networks = Array.isArray(service.networks) ? service.networks : Object.keys(service.networks ?? {});
        assert.ok(!networks.includes('assistant-search'));
      }
    }
  });
}

test('JSON API uses upstream engines plus Bing and a runtime secret with LF shell', () => {
  const settings = parse(read('deploy/search/settings.yml'));
  assert.equal(settings.use_default_settings, true);
  assert.deepEqual(settings.search.formats, ['json']);
  assert.deepEqual(settings.engines, [{ name: 'bing', disabled: false }]);
  const script = read('deploy/search/start.sh');
  assert.ok(!script.includes('\r'));
  assert.match(script, /secrets.token_hex\(32\)/);
  assert.match(script, /exec \/usr\/local\/searxng\/entrypoint.sh/);
  const single = read('server/docker/single/entrypoint.sh');
  for (const name of ['SEARCH_PROVIDER', 'SEARCH_API_URL', 'SEARCH_API_KEY', 'SEARCH_SEARXNG_URL']) {
    assert.ok(single.includes(`put_opt ${name} `));
  }
});
