/**
 * @jest-environment jsdom
 *
 * Subtab render guard (MEMORY: verify UI render paths). tsc + jest passing is NOT
 * proof a subtab bar actually mounts — a toolbar group has vanished twice in this
 * repo behind a filter, and the t50 IA refactor re-groups the Groups tab into 4
 * subtabs, folds Audit into a 2-subtab Logs container, and drops the top-level
 * `audit` tab. So this drives the REAL components in jsdom and asserts, for every
 * restructured tab bar: each subtab label renders AND, after activating it, the
 * matching panel's own content renders (no orphan Tab without a TabPanel).
 *
 * The repo has no @testing-library, so we drive React directly with
 * react-dom/client's createRoot + act (mirroring AdminUsersTab.spec).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Regular: 'regular' },
}))

// Treat a response as an error only when it carries an explicit error field.
// classNames is re-exported from snjs and used by child components (Dropdown),
// so keep a real implementation — mocking it away breaks the render tree.
jest.mock('@standardnotes/snjs', () => ({
  isErrorResponse: (response: unknown) => Boolean((response as { error?: unknown })?.error),
  classNames: (...values: unknown[]) => values.filter(Boolean).join(' '),
}))

jest.mock('@standardnotes/ui-services', () => ({
  confirmDialog: jest.fn().mockResolvedValue(true),
}))

jest.mock('@standardnotes/filepicker', () => ({
  formatSizeToReadableString: (bytes: number) => `${bytes} B`,
}))

import Admin from './Admin'
import AdminGroupsTab from './AdminGroupsTab'
import AdminLogsContainer from './AdminLogsContainer'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A wide, permissive legacyApi: every admin call any of these tabs make on mount
// resolves to an empty, non-error payload so the components reach their rendered
// (non-loading) state. Extra methods are harmless.
const makeApplication = () => ({
  featuresController: { isAdminUser: () => true },
  sessions: { getUser: () => ({ uuid: 'current-admin-uuid' }) },
  legacyApi: {
    // Groups tab
    adminListRolesWithPermissions: jest.fn().mockResolvedValue({ data: { roles: [], permissions: [] } }),
    adminGetPermissionCatalog: jest.fn().mockResolvedValue({ data: { permissions: [] } }),
    adminGetAvailableRoles: jest.fn().mockResolvedValue({ data: { roleNames: [] } }),
    adminListGroups: jest.fn().mockResolvedValue({ data: { groups: [] } }),
    adminGetRoleHolders: jest.fn().mockResolvedValue({ data: { directUserCount: 0, groups: [] } }),
    // Logs container
    adminGetLogs: jest.fn().mockResolvedValue({ data: { logs: [] } }),
    adminGetAuditLog: jest.fn().mockResolvedValue({ data: { events: [], total: 0 } }),
    adminListUsers: jest.fn().mockResolvedValue({ data: { users: [], total: 0 } }),
  },
  // Diagnostics tab: reads the admin sync-diagnostics endpoint and the live
  // transport directly off the application, not through legacyApi.
  serverGetJsonRequest: jest.fn().mockResolvedValue({
    status: 200,
    ok: true,
    data: {
      gate: {
        recorded: true,
        gatewayAttached: true,
        syncLaneEnabled: false,
        unmetPreconditions: [{ code: 'REDIS_UNBOUND', remedy: 'configure REDIS_URL' }],
        unmetCodes: ['REDIS_UNBOUND'],
        files: {
          advertised: false,
          unmetCondition: 'FILES_INTERNAL_URL',
          remedy: 'no INTERNAL files service URL is configured.',
        },
      },
      live: { capabilities: [], unavailabilityReasons: ['sync-not-configured'], ticketAvailable: false },
      protocol: { version: 1, serverOperations: ['SYNC_ITEMS', 'FILES_V1'] },
    },
  }),
  serverJsonRequest: jest
    .fn()
    .mockResolvedValue({ status: 503, ok: false, data: { error: { code: 'SYNC_DISABLED' } } }),
  syncTransportStatus: { state: 'HTTP_ONLY', operations: [] },
})

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const render = async (element: ReturnType<typeof createElement>) => {
  await act(async () => {
    root.render(element)
  })
  await flush()
}

// Find a subtab <button role="tab"> by its (icon + text) label and click it.
const clickTab = async (label: string) => {
  const tab = Array.from(container.querySelectorAll('button[role="tab"]')).find((b) =>
    (b.textContent ?? '').includes(label),
  )
  expect(tab).toBeDefined()
  await act(async () => {
    ;(tab as HTMLButtonElement).click()
  })
  await flush()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asApp = (application: ReturnType<typeof makeApplication>) => application as any

describe('AdminGroupsTab — 4 subtabs each mount their panel', () => {
  it('shows all four subtab labels and each panel renders its own content', async () => {
    const application = makeApplication()
    await render(createElement(AdminGroupsTab, { application: asApp(application), noteIfForbidden: jest.fn() }))

    // Every subtab label is present in the bar.
    for (const label of ['Roles', 'Permission catalog', 'Effective permissions', 'Groups']) {
      expect(container.textContent).toContain(label)
    }

    // Default (roles) panel content.
    expect(container.textContent).toContain('exactly four roles')

    // Permission-catalog panel content (distinct from its subtab label).
    await clickTab('Permission catalog')
    expect(container.textContent).toContain('Every permission the server knows about')

    // Effective-permissions panel content (panel title differs from the label).
    await clickTab('Effective permissions')
    expect(container.textContent).toContain('Effective-permissions simulator')

    // Groups panel content.
    await clickTab('Groups')
    expect(container.textContent).toContain('Create a group')
  })
})

describe('AdminLogsContainer — 2 subtabs each mount their panel', () => {
  it('shows both subtab labels and each panel renders its own content', async () => {
    const application = makeApplication()
    await render(createElement(AdminLogsContainer, { application: asApp(application), noteIfForbidden: jest.fn() }))

    for (const label of ['Logs', 'Audit logs']) {
      expect(container.textContent).toContain(label)
    }

    // Default (logs) panel is the server-logs tail.
    expect(container.textContent).toContain('Server logs')

    // Audit-logs panel folds in the former top-level audit tab.
    await clickTab('Audit logs')
    expect(container.textContent).toContain('Audit log')
    expect(application.legacyApi.adminGetAuditLog).toHaveBeenCalled()
  })
})

describe('Admin shell — top-level tab set after folding Audit into Logs', () => {
  it('renders the top-level tabs and no standalone "Audit log" tab', async () => {
    const application = makeApplication()
    await render(createElement(Admin, { application: asApp(application) }))

    const tabLabels = Array.from(container.querySelectorAll('button[role="tab"]')).map((b) =>
      (b.textContent ?? '').trim(),
    )
    for (const label of ['Users', 'Groups & roles', 'Server', 'AI', 'Logs', 'Security', 'Diagnostics']) {
      expect(tabLabels.some((t) => t.includes(label))).toBe(true)
    }
    // The old standalone Audit-log tab is gone (folded into Logs).
    expect(tabLabels.some((t) => t.includes('Audit log'))).toBe(false)
  })

  // A tab in the bar whose panel does not mount is the exact failure this file
  // was written for, so the Diagnostics tab is activated and its own content
  // asserted — not just its label.
  it('mounts the Diagnostics panel and names the unmet condition', async () => {
    const application = makeApplication()
    await render(createElement(Admin, { application: asApp(application) }))

    await clickTab('Diagnostics')

    expect(container.textContent).toContain('Capability diagnostics')
    expect(container.textContent).toContain('REDIS_UNBOUND')
    expect(container.textContent).toContain('REDIS_URL')
    expect(application.serverGetJsonRequest).toHaveBeenCalledWith('/v1/admin/sync-diagnostics')
  })
})
