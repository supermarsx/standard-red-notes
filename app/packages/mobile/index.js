/* global __DEV__, console */
/* eslint-disable no-console */

import { SNLog, redactLogValue, safeErrorLogMetadata } from '@standardnotes/snjs'
import { AppRegistry } from 'react-native'
import { name as appName } from './app.json'
import { MobileWebApp } from './src/MobileWebApp'

const safeConsoleValue = (value) => (value instanceof Error ? safeErrorLogMetadata(value) : redactLogValue(value))
const forwardSafeLog = (...messages) => console.log(...messages.map(safeConsoleValue))
const forwardSafeError = (error) => console.error('SNJS operation failed', safeErrorLogMetadata(error))

if (__DEV__ === false) {
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
}
SNLog.onError = forwardSafeError
SNLog.onLog = forwardSafeLog
/* eslint-enable no-console */

const originalWarn = console.warn

console.warn = function filterWarnings(msg) {
  const supressedWarnings = [
    "[react-native-gesture-handler] Seems like you're using an old API with gesture components",
  ]

  if (typeof msg !== 'string' || !supressedWarnings.some((entry) => msg.includes(entry))) {
    originalWarn.apply(console, Array.from(arguments, safeConsoleValue))
  }
}

AppRegistry.registerComponent(appName, () => MobileWebApp)
