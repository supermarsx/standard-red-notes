// Standard Red Notes clipper defaults. A self-hosted clipper must NOT point at
// hosted Standard Notes infrastructure, so there are no api/files/sockets
// .standardnotes.com defaults here. Blank => the clipper is "custom": the user
// configures their own server. To ship a clipper pre-pointed at your server,
// bake the values in at build time (or via your bundler's env injection).
window.defaultSyncServer = ''
window.defaultFilesHost = ''
window.enabledUnfinishedFeatures = false
window.websocketUrl = ''
// No paid tier — these go nowhere.
window.purchaseUrl = 'about:blank'
window.plansUrl = 'about:blank'
window.dashboardUrl = 'about:blank'
window.isClipper = true
