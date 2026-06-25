/* istanbul ignore file */
//
// Operator-configurable branding/URLs for user-facing scheduler emails.
//
// These email template modules are plain functions and are NOT part of the inversify DI graph,
// so they read process.env directly. All values default to empty strings (NEVER standardnotes.com)
// so a self-hosted operator can wire their own instance without leaking upstream branding.
//
// Recognized environment variables (all optional):
//   APP_URL        - URL of the operator's web/desktop app (where users manage their account)
//   DASHBOARD_URL  - URL of the operator's account dashboard
//   PLANS_URL      - URL of a plans/pricing page (unused now; no paid tier)
//   HELP_URL       - URL of the operator's help/docs
//   SUPPORT_EMAIL  - support contact email address
//
export const emailConfig = {
  appUrl: process.env.APP_URL ?? '',
  dashboardUrl: process.env.DASHBOARD_URL ?? '',
  plansUrl: process.env.PLANS_URL ?? '',
  helpUrl: process.env.HELP_URL ?? '',
  supportEmail: process.env.SUPPORT_EMAIL ?? '',
}
