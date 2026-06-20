//= require_tree ./app

// css
import '../stylesheets/tailwind.css'
import '../stylesheets/index.css.scss'

// entry point
import './App'

import { registerServiceWorker } from './registerServiceWorker'

// PWA offline app-shell support. Skipped for the browser-extension (clipper)
// build, which has its own popup context and no server root to host the SW.
if (!window.isClipper) {
  registerServiceWorker()
}
