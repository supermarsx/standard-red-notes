import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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

test('manifest validation binds every feature to a real asset, crop, and exact locator', () => {
  const manifest = loadFeatureScreenshotManifest(repositoryRoot)
  assert.deepEqual(validateFeatureScreenshotManifest(manifest, { root: repositoryRoot }), [])

  for (const [featureId, feature] of Object.entries(manifest.features)) {
    assert.ok(manifest.captures[feature.capture], `${featureId} has no capture`)
    assert.ok(feature.targets.length >= 1, `${featureId} has no targets`)
    for (const target of feature.targets) {
      assert.ok(['css', 'text', 'role'].includes(target.locator.kind), `${featureId} has an unknown locator`)
      if (target.locator.kind !== 'css') {
        assert.equal(target.locator.exact, true, `${featureId} locator is not exact`)
      }
    }
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
