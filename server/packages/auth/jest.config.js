// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')
const { defaults: tsjPreset } = require('ts-jest/presets')

module.exports = {
  ...base,
  transform: {
    ...tsjPreset.transform,
    '^.+\.m?jsx?$': 'babel-jest',
  },
  transformIgnorePatterns: ['/node_modules/(?!(inversify|@inversifyjs)/)'],
  coveragePathIgnorePatterns: ['/Bootstrap/', '/Infra/', '/Controller/', '/Projection/', '/Domain/Email/', '/Mapping/'],
  setupFilesAfterEnv: ['./test-setup.ts'],
}
