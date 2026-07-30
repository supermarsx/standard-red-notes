import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  README_SCREENSHOT_CONTRACT,
  extractFeatureScreenshotIncludes,
  readPngDimensions,
  validateDocsScreenshots,
  validateFeatureScreenshot,
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

function featureInclude(overrides = '') {
  return `{% include feature-screenshot.html
  id="fixture-crop"
  variant="inline"
  view_box="220 0 400 300"
  width="400"
  height="300"
  alt="Notes list with visible create and search controls"
  title="Find a note"
  caption="The crop documents controls visible in the source capture."
  marker_one_x="551"
  marker_one_y="29"
  marker_one_text="Create a note from the red plus button."
  marker_two_x="412"
  marker_two_y="73"
  marker_two_text="Search the current Notes collection."
  ${overrides}
%}`
}

test('readPngDimensions reads dimensions from the PNG IHDR header', () => {
  assert.deepEqual(readPngDimensions(pngHeader(1440, 900)), { width: 1440, height: 900 })
  assert.throws(() => readPngDimensions(Buffer.alloc(24)), /valid PNG signature/)
})

test('extractFeatureScreenshotIncludes records attributes and source lines', () => {
  const [include] = extractFeatureScreenshotIncludes(`intro\n\n${featureInclude()}`, 'docs/fixture.md')

  assert.equal(include.file, 'docs/fixture.md')
  assert.equal(include.line, 3)
  assert.equal(include.attributes.id, 'fixture-crop')
  assert.deepEqual(validateFeatureScreenshot(include), [])
})

test('feature screenshot validation rejects generic alt text, invalid crops, and clipped markers', () => {
  const [include] = extractFeatureScreenshotIncludes(
    featureInclude(`
  alt="Screenshot"
  view_box="1300 850 400 300"
  marker_three_x="1302"
  marker_three_y="852"
  marker_three_text="Menu"
`),
    'docs/broken.md',
  )
  const errors = validateFeatureScreenshot(include).join('\n')

  assert.match(errors, /duplicate feature-screenshot attribute "alt"/)
  assert.match(errors, /alt text must describe the visible crop/)
  assert.match(errors, /view_box .* exceeds the 1440x900 source image/)
  assert.match(errors, /marker 3 at 1302,852 is clipped/)
  assert.match(errors, /marker 3 text is too short/)
})

test('feature screenshot validation requires every marker coordinate and description together', () => {
  const [include] = extractFeatureScreenshotIncludes(
    featureInclude('marker_three_x="500"'),
    'docs/incomplete.md',
  )

  assert.match(validateFeatureScreenshot(include).join('\n'), /marker 3 requires x, y, and text together/)
})

test('the include template must reference the source asset, dimensions, and accessible title', () => {
  const validTemplate = `
<svg aria-labelledby="{{ include.id | escape }}-title">
  <title>{{ include.alt | escape }}</title>
  <image href="{{ '/assets/readme-screenshot.png' | relative_url }}" width="1440" height="900" />
</svg>`
  assert.deepEqual(validateFeatureScreenshotTemplate(validTemplate), [])
  assert.match(
    validateFeatureScreenshotTemplate(validTemplate.replace('width="1440"', 'width="1200"')).join('\n'),
    /dimensions must be 1440x900/,
  )
})

test('the committed screenshot asset and every documented crop satisfy the contract', () => {
  const result = validateDocsScreenshots({ root: repositoryRoot })

  assert.ok(result.screenshotCount >= 9, 'expected the workspace tour and contextual guide crops')
  assert.deepEqual(result.errors, [])

  const screenshot = fs.readFileSync(path.join(repositoryRoot, README_SCREENSHOT_CONTRACT.assetPath))
  assert.deepEqual(readPngDimensions(screenshot), {
    width: README_SCREENSHOT_CONTRACT.width,
    height: README_SCREENSHOT_CONTRACT.height,
  })
})
