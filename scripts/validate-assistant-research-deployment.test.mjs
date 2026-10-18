import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { parse } = require('yaml');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
for (const [file, gateway] of [['docker-compose.yml', 'server'], ['docker-compose.single.yml', 'app']]) {
  test(`${file} isolates PDFium and wires only server research credentials`, () => {
    const compose = parse(read(file), { merge: true });
    const parser = compose.services['assistant-pdf'];
    assert.deepEqual(parser.build, { context: './server/pdf-extractor' });
    assert.equal(parser.ports, undefined);
    assert.equal(parser.read_only, true);
    assert.deepEqual(parser.cap_drop, ['ALL']);
    assert.deepEqual(parser.networks, ['assistant-pdf']);
    assert.equal(compose.networks['assistant-pdf'].internal, true);
    assert.ok(compose.services[gateway].networks.includes('assistant-pdf'));
    assert.equal(compose.services[gateway].depends_on?.['assistant-pdf'], undefined);
    assert.match(compose.services[gateway].environment.PDF_EXTRACTOR_URL, /http:\/\/assistant-pdf:8091/);
    assert.ok(compose.services[gateway].environment.TELEGRAM_ASSISTANT_BOT_TOKEN);
  });
}
test('single deployment forwards parser and bridge settings to gateway env', () => {
  const source = read('server/docker/single/entrypoint.sh');
  for (const name of ['PDF_EXTRACTOR_URL', 'TELEGRAM_ASSISTANT_BOT_TOKEN', 'TELEGRAM_ASSISTANT_WEBHOOK_SECRET']) {
    assert.ok(source.includes(`put_opt ${name} `));
  }
});
test('CI builds companion before no-build disposable stacks', () => {
  const workflow = parse(read('.github/workflows/ci.yml'));
  for (const job of Object.values(workflow.jobs)) {
    const steps = job.steps ?? [];
    const start = steps.findIndex((step) => step.name === 'Start disposable stack');
    if (start >= 0) {
      assert.ok(steps.slice(0, start).some((step) => step.run === 'docker compose build assistant-pdf'));
    }
  }
});
