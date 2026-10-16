const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const postcss = require('postcss')
const guard = require('./GuardTextSizeAdjust.cjs')

function assertGuarded(root) {
  let found = 0
  root.walkDecls(/^(?:-webkit-)?text-size-adjust$/, (declaration) => {
    found++
    let parent = declaration.parent
    while (
      parent &&
      !(
        parent.type === 'atrule' &&
        parent.name === 'supports' &&
        parent.params === `(${declaration.prop}: ${declaration.value})`
      )
    ) {
      parent = parent.parent
    }
    assert.ok(parent, `${declaration.prop} must be guarded by its own support check`)
  })
  assert.ok(found > 0, 'supported browsers must retain text sizing')
}

test('guards generated vendor and standard sizing while retaining layer, selectors and other preflight rules', async () => {
  const result = await postcss([guard()]).process(
    '@layer base { html,:host { line-height:1.5; -webkit-text-size-adjust:100%; text-size-adjust:100% !important; tab-size:4 } }',
    { from: undefined },
  )
  assertGuarded(result.root)
  const sizing = []
  result.root.walkDecls(/text-size-adjust$/, (declaration) => {
    sizing.push(declaration)
    assert.equal(declaration.parent.selector, 'html,:host')
    assert.equal(declaration.parent.parent.parent.name, 'layer')
  })
  assert.equal(sizing.length, 2)
  assert.equal(sizing.find((declaration) => declaration.prop === 'text-size-adjust').important, true)
  assert.match(result.css, /line-height:1.5/)
  assert.match(result.css, /tab-size:4/)
  const repeated = await postcss([guard()]).process(result.css, { from: undefined })
  assert.equal(repeated.css, result.css)
})

test('actual Tailwind pipeline keeps preflight and guards its html/:host vendor declaration', async () => {
  const entry = path.resolve(__dirname, '../src/stylesheets/tailwind.css')
  const { plugins } = require('../postcss.config.js')
  const result = await postcss(plugins).process(readFileSync(entry, 'utf8'), { from: entry })
  assertGuarded(result.root)
  let preflight = false
  result.root.walkRules((rule) => {
    if (rule.selector.includes('html') && rule.selector.includes(':host')) {
      rule.walkDecls('line-height', () => {
        preflight = true
      })
    }
  })
  assert.equal(preflight, true)
})

test('retains the cascade order of repeated sizing declarations', async () => {
  const result = await postcss([guard()]).process(
    'html { -webkit-text-size-adjust:100%; -webkit-text-size-adjust:none }',
    { from: undefined },
  )
  const values = []
  result.root.walkDecls('-webkit-text-size-adjust', (declaration) => values.push(declaration.value))
  assert.deepEqual(values, ['100%', 'none'])
  assertGuarded(result.root)
})

test('shared SCSS normalize emits only supported text sizing and retains browser resets', () => {
  const sass = require('sass')
  const entry = path.resolve(__dirname, '../../styles/src/Styles/_normalize.scss')
  const result = postcss.parse(sass.compile(entry).css)
  assertGuarded(result)
  let margin
  result.walkRules('body', (rule) =>
    rule.walkDecls('margin', (declaration) => {
      margin = declaration.value
    }),
  )
  assert.equal(margin, '0')
})
