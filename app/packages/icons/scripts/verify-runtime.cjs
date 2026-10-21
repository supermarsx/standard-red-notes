const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Exercise the shipped UMD artifact, including its chosen React JSX runtime.
// A production webpack mode alone does not select Babel's production JSX calls.
const browser = { self: {} }
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/index.js'), 'utf8'), browser)
const icons = Object.entries(browser.self).filter(([, value]) => typeof value === 'function')
assert.ok(icons.length > 100, 'the built icon exports must be present')
for (const [name, render] of icons) {
  const element = render({})
  assert.equal(element.type, 'svg', `${name} must render its SVG with the production JSX runtime`)
}
console.log(`Verified ${icons.length} production icon components.`)
