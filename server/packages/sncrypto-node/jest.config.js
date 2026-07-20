// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

// No coverageThreshold override: the package measures 100/100/100/100, so it inherits the
// repo-wide 90 branches / 100 functions / 99 lines / 99 statements gate. The previous override
// (30 branches / 90 elsewhere) only existed to accommodate untested base32 padding paths.
module.exports = {
  ...base,
}
