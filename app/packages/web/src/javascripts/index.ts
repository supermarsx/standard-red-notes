//= require_tree ./app

// css
import '../stylesheets/tailwind.css'
import '../stylesheets/index.css.scss'

// i18n: initialize the translation framework once, before any component renders,
// so the very first paint is already localized and the <html lang/dir> is set.
import { initializeI18n } from './Internationalization/i18n'
initializeI18n()

// entry point
import './App'

import { registerServiceWorker } from './registerServiceWorker'

// PWA offline app-shell support. Skipped for the browser-extension (clipper)
// build, which has its own popup context and no server root to host the SW.
if (!window.isClipper) {
  registerServiceWorker()
}
