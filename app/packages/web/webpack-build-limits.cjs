function integerSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum || Number(raw) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return Number(raw)
}

module.exports = function buildLimits() {
  return {
    parallelism: integerSetting('WEBPACK_PARALLELISM', 32, 1, 1000),
    minifyWorkers: integerSetting('WEBPACK_MINIFY_WORKERS', 2, 0, 64),
  }
}
