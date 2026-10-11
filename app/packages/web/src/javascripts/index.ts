//= require_tree ./app

// css
import '../stylesheets/tailwind.css'
import '../stylesheets/index.css.scss'
// The self-hosted editor web fonts' @font-face declarations. Imported from the
// ENTRY so they land in the initial `app.css` rather than in whichever async
// chunk happens to reach them: the editor font preference applies to plaintext
// and Markdown notes too, and its families were previously declared only in the
// Super toolbar's lazy chunk — so a chosen font silently did not apply until
// (and unless) that chunk loaded. Declaring a face downloads nothing; the woff2
// is fetched only once a rule actually matches, so this costs ~16KB of CSS text
// and no font bytes.
import '@/Components/SuperEditor/fonts/editorFonts.css'

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
