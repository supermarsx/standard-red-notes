import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  FEATURE_SCREENSHOT_MANIFEST_PATH,
  README_SCREENSHOT_CONTRACT,
  extractFeatureScreenshotIncludes,
  loadFeatureScreenshotManifest,
  readPngDimensions,
  validateDocsScreenshots,
  validateFeatureScreenshot,
  validateFeatureScreenshotManifest,
  validateFeatureScreenshotTemplate,
  validateOnboardingScreenshotContexts,
} from './validate-docs-screenshots.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

test('readPngDimensions reads dimensions from the PNG IHDR header', () => {
  assert.deepEqual(readPngDimensions(pngHeader(1440, 900)), { width: 1440, height: 900 })
  assert.throws(() => readPngDimensions(Buffer.alloc(24)), /valid PNG signature/)
})

test('feature includes carry only a manifest id and preserve source lines', () => {
  const [include] = extractFeatureScreenshotIncludes(
    'intro\n\n{% include feature-screenshot.html id="workspace-overview" %}',
    'docs/fixture.md',
  )

  assert.equal(include.file, 'docs/fixture.md')
  assert.equal(include.line, 3)
  assert.deepEqual(include.attributes, { id: 'workspace-overview' })
  assert.deepEqual(validateFeatureScreenshot(include), [])
})

test('feature includes reject duplicate, inline, and unknown metadata', () => {
  const [include] = extractFeatureScreenshotIncludes(
    '{% include feature-screenshot.html id="missing-feature" id="again" alt="Inline metadata" %}',
    'docs/broken.md',
  )
  const errors = validateFeatureScreenshot(include).join('\n')

  assert.match(errors, /duplicate feature-screenshot attribute "id"/)
  assert.match(errors, /metadata belongs in the manifest, not attribute "alt"/)
  assert.match(errors, /unknown manifest feature "again"/)
})

test('onboarding screenshot evidence is bound to its reviewed section and pixel-boundary disclaimer', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'docs', 'onboarding.md'), 'utf8')
  const manifest = loadFeatureScreenshotManifest(repositoryRoot)

  assert.deepEqual(validateOnboardingScreenshotContexts(source, manifest), [])

  const wrongId = source.replace(
    'id="workspace-note-results"',
    'id="workspace-note-actions"',
  )
  assert.match(
    validateOnboardingScreenshotContexts(wrongId, manifest).join('\n'),
    /section "Finding things".*must contain only that screenshot include/,
  )

  const searchInclude = '{% include feature-screenshot.html id="workspace-note-results" %}'
  const wrongSection = source
    .replace(searchInclude, '')
    .replace('### Organizing single notes\n', `### Organizing single notes\n\n${searchInclude}\n`)
  assert.match(
    validateOnboardingScreenshotContexts(wrongSection, manifest).join('\n'),
    /section "Finding things".*found <none>/,
  )

  const missingDisclaimer = source.replace(
    'It does not show an entered query, filtered results, relevance',
    'It shows an entered query, filtered results, relevance',
  )
  assert.match(
    validateOnboardingScreenshotContexts(missingDisclaimer, manifest).join('\n'),
    /section "Finding things".*pixel-boundary disclaimer is missing or changed/,
  )
})

test('onboarding screenshot context rejects captions, claims, and targets that exceed stored pixels', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'docs', 'onboarding.md'), 'utf8')
  const manifest = clone(loadFeatureScreenshotManifest(repositoryRoot))
  manifest.features['workspace-note-actions'].caption =
    'The open menu proves that pin, archive, trash, and protect actions work.'
  manifest.features['workspace-super-toolbar'].evidenceClaims.push('block-picker-open')
  manifest.features['workspace-collections'].targets[0].text =
    'A populated nested folder hierarchy is visible.'

  const errors = validateOnboardingScreenshotContexts(source, manifest).join('\n')
  assert.match(errors, /workspace-note-actions.*caption no longer matches the reviewed pixel boundary/)
  assert.match(errors, /workspace-super-toolbar.*evidence claims no longer match the reviewed pixel boundary/)
  assert.match(errors, /workspace-collections.*target text no longer matches the reviewed visible controls/)
})

test('manifest validation binds every feature to a real asset, crop, and exact locator', () => {
  const manifest = loadFeatureScreenshotManifest(repositoryRoot)
  assert.deepEqual(validateFeatureScreenshotManifest(manifest, { root: repositoryRoot }), [])

  for (const [featureId, feature] of Object.entries(manifest.features)) {
    assert.ok(manifest.captures[feature.capture], `${featureId} has no capture`)
    assert.ok(feature.evidenceClaims.length >= 1, `${featureId} has no bounded evidence claims`)
    for (const claim of feature.evidenceClaims) {
      assert.ok(
        !manifest.captures[feature.capture].unsupportedStates.includes(claim),
        `${featureId} claims unsupported state ${claim}`,
      )
    }
    assert.ok(feature.targets.length >= 1, `${featureId} has no targets`)
    for (const target of feature.targets) {
      assert.ok(['css', 'text', 'role'].includes(target.locator.kind), `${featureId} has an unknown locator`)
      if (target.locator.kind !== 'css') {
        assert.equal(target.locator.exact, true, `${featureId} locator is not exact`)
      }
    }
  }
})

test('capture provenance binds the exact asset while recording the live-locator limitation', () => {
  const manifest = loadFeatureScreenshotManifest(repositoryRoot)
  const capture = manifest.captures['workspace-overview']

  assert.match(capture.sha256, /^[a-f0-9]{64}$/)
  assert.match(capture.sourceCommit, /^[a-f0-9]{40}$/)
  assert.ok(!Number.isNaN(Date.parse(capture.sourceCommitTimestamp)))
  assert.equal(capture.liveLocatorRevalidated, false)
  assert.match(capture.limitation, /not been revalidated/i)
  assert.ok(capture.unsupportedStates.length >= 1)
})

test('historical provenance lookup is shallow-safe while the current asset digest stays mandatory', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(repositoryRoot, '.tmp-screenshot-shallow-'))
  const sourceRoot = path.join(temporaryDirectory, 'source')
  const shallowRoot = path.join(temporaryDirectory, 'shallow')
  try {
    fs.mkdirSync(path.join(sourceRoot, 'docs', 'assets'), { recursive: true })
    fs.mkdirSync(path.join(sourceRoot, 'scripts'), { recursive: true })
    const asset = pngHeader(100, 100)
    fs.writeFileSync(path.join(sourceRoot, 'docs', 'assets', 'capture.png'), asset)
    fs.writeFileSync(path.join(sourceRoot, 'scripts', 'capture.mjs'), 'export {}\n')
    runGit(sourceRoot, ['init'])
    runGit(sourceRoot, ['config', 'user.email', 'docs@example.test'])
    runGit(sourceRoot, ['config', 'user.name', 'Docs Test'])
    runGit(sourceRoot, ['add', '.'])
    runGit(sourceRoot, ['commit', '-m', 'capture'])
    const sourceCommit = runGit(sourceRoot, ['rev-parse', 'HEAD'])
    const sourceCommitTimestamp = runGit(sourceRoot, ['show', '-s', '--format=%aI', 'HEAD'])
    fs.writeFileSync(path.join(sourceRoot, 'later.txt'), 'later\n')
    runGit(sourceRoot, ['add', 'later.txt'])
    runGit(sourceRoot, ['commit', '-m', 'later'])
    runGit(temporaryDirectory, ['clone', '--depth', '1', pathToFileURL(sourceRoot).href, shallowRoot])
    assert.equal(runGit(shallowRoot, ['rev-parse', '--is-shallow-repository']), 'true')

    const manifest = {
      schemaVersion: 1,
      captures: {
        capture: {
          asset: 'capture.png',
          width: 100,
          height: 100,
          viewportWidth: 100,
          viewportHeight: 100,
          captureScript: 'scripts/capture.mjs',
          state: 'A genuine bounded fixture state for shallow provenance validation.',
          sha256: createHash('sha256').update(asset).digest('hex'),
          sourceCommit,
          sourceCommitTimestamp,
          liveLocatorRevalidated: false,
          limitation:
            'The live controls have not been revalidated in this shallow fixture; only the current asset digest is available.',
          unsupportedStates: ['account-recovery'],
        },
      },
      features: {
        navigation: {
          capture: 'capture',
          variant: 'card',
          viewBox: '0 0 100 100',
          width: 100,
          height: 100,
          alt: 'A visible navigation control in the fixture capture',
          title: 'Visible navigation',
          caption: 'This bounded fixture proves only the visible navigation control.',
          evidenceClaims: ['navigation'],
          targets: [{ x: 50, y: 50, text: 'Visible navigation control', locator: { kind: 'css', value: '#nav' } }],
        },
      },
    }

    assert.deepEqual(validateFeatureScreenshotManifest(manifest, { root: shallowRoot }), [])
    manifest.captures.capture.sha256 = '0'.repeat(64)
    assert.match(
      validateFeatureScreenshotManifest(manifest, { root: shallowRoot }).join('\n'),
      /capture\.png SHA-256 is .* expected 000000000000/,
    )
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('manifest validation rejects a missing asset, wrong capture, clipped marker, and vague locator', () => {
  const manifest = clone(loadFeatureScreenshotManifest(repositoryRoot))
  manifest.captures['workspace-overview'].asset = 'missing-feature-state.png'
  manifest.features['workspace-navigation'].capture = 'not-a-capture'
  manifest.features['workspace-note-tools'].targets[0].x = 221
  manifest.features['workspace-note-actions'].targets[0].locator.exact = false
  const errors = validateFeatureScreenshotManifest(manifest, { root: repositoryRoot }).join('\n')

  assert.match(errors, /missing-feature-state\.png does not exist/)
  assert.match(errors, /references unknown capture "not-a-capture"/)
  assert.match(errors, /marker at 221,29 is clipped/)
  assert.match(errors, /text locator must set exact to true/)
})

test('manifest validation rejects false provenance and explicitly unsupported evidence claims', () => {
  const manifest = clone(loadFeatureScreenshotManifest(repositoryRoot))
  manifest.captures['workspace-overview'].sha256 = '0'.repeat(64)
  manifest.captures['workspace-overview'].sourceCommitTimestamp = '2026-07-16T00:00:00Z'
  manifest.captures['workspace-overview'].liveLocatorRevalidated = 'yes'
  manifest.features['workspace-navigation'].evidenceClaims.push('account-recovery')
  const errors = validateFeatureScreenshotManifest(manifest, { root: repositoryRoot }).join('\n')

  assert.match(errors, /SHA-256 is .* expected 000000000000/)
  assert.match(errors, /sourceCommitTimestamp must match sourceCommit author time/)
  assert.match(errors, /liveLocatorRevalidated must explicitly record true or false/)
  assert.match(errors, /evidence claim "account-recovery" is explicitly unsupported/)
})

test('separate capture ids cannot silently reuse one image asset', () => {
  const manifest = clone(loadFeatureScreenshotManifest(repositoryRoot))
  manifest.captures.duplicate = clone(manifest.captures['workspace-overview'])
  const errors = validateFeatureScreenshotManifest(manifest, { root: repositoryRoot }).join('\n')

  assert.match(errors, /captures "workspace-overview" and "duplicate" reuse asset "readme-screenshot\.png"/)
})

test('the include template resolves capture assets and targets through the manifest', () => {
  const templatePath = path.join(repositoryRoot, 'docs', '_includes', 'feature-screenshot.html')
  const template = fs.readFileSync(templatePath, 'utf8')
  assert.deepEqual(validateFeatureScreenshotTemplate(template), [])
  assert.match(
    validateFeatureScreenshotTemplate(template.replace('{{ capture.width }}', '1440')).join('\n'),
    /missing manifest contract fragment width=/,
  )
})

test('the real capture script verifies manifest locators and marker proximity before writing', () => {
  const captureScript = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'capture-readme-screenshot.mjs'), 'utf8')

  assert.match(captureScript, /loadFeatureScreenshotManifest\(ROOT\)/)
  assert.match(captureScript, /locatorForTarget/)
  assert.match(captureScript, /locator\.boundingBox\(\)/)
  assert.match(captureScript, /does not point near its visible control/)
})

test('the committed manifest, capture assets, and documented feature references satisfy the contract', () => {
  const result = validateDocsScreenshots({ root: repositoryRoot })

  assert.equal(result.captureCount, 1)
  assert.ok(result.screenshotCount >= 10, 'expected the workspace tour and contextual guide views')
  assert.deepEqual(result.errors, [])
  assert.equal(FEATURE_SCREENSHOT_MANIFEST_PATH, 'docs/_data/feature_screenshots.json')

  const screenshot = fs.readFileSync(path.join(repositoryRoot, README_SCREENSHOT_CONTRACT.assetPath))
  assert.deepEqual(readPngDimensions(screenshot), {
    width: README_SCREENSHOT_CONTRACT.width,
    height: README_SCREENSHOT_CONTRACT.height,
  })
})
