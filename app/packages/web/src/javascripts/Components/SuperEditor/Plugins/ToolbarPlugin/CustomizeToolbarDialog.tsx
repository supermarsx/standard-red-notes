/**
 * Standard Red Notes: customization UI for the Super editor toolbar.
 *
 * Lists every group (in the user's current order) with up/down reordering, a
 * show/hide toggle and up/down reordering per button, a per-group rows (1–3)
 * selector, a global "single-line horizontal scroll" toggle, and a "Reset to
 * default" action. Changes apply live — the parent persists each new config to
 * the SuperToolbarConfig local pref, so the toolbar updates immediately and
 * across reloads.
 */
import Icon from '@/Components/Icon/Icon'
import { classNames } from '@standardnotes/snjs'
import {
  DEFAULT_GROUP_ROWS,
  DEFAULT_SUPER_TOOLBAR_CONFIG,
  DEFAULT_TOOLBAR_GROUPS,
  MAX_GROUP_ROWS,
  MIN_GROUP_ROWS,
  normalizeToolbarConfig,
  SuperToolbarConfig,
  ToolbarButtonId,
  ToolbarGroupId,
} from './ToolbarConfig'

type Props = {
  config: SuperToolbarConfig
  onChange: (config: SuperToolbarConfig) => void
  onClose: () => void
}

const GROUP_BY_ID = new Map(DEFAULT_TOOLBAR_GROUPS.map((g) => [g.id, g]))

/** Current group order: explicit order first, then remaining defaults. */
const resolveGroupOrder = (config: SuperToolbarConfig): ToolbarGroupId[] => {
  const ordered: ToolbarGroupId[] = []
  const seen = new Set<string>()
  for (const id of config.groupOrder) {
    if (GROUP_BY_ID.has(id as ToolbarGroupId) && !seen.has(id)) {
      ordered.push(id as ToolbarGroupId)
      seen.add(id)
    }
  }
  for (const group of DEFAULT_TOOLBAR_GROUPS) {
    if (!seen.has(group.id)) {
      ordered.push(group.id)
      seen.add(group.id)
    }
  }
  return ordered
}

/** Current button order within a group: explicit order first, then remaining defaults. */
const resolveButtonOrder = (config: SuperToolbarConfig, groupId: ToolbarGroupId): ToolbarButtonId[] => {
  const group = GROUP_BY_ID.get(groupId)
  if (!group) {
    return []
  }
  const defaultIds = group.buttons.map((b) => b.id)
  const explicit = config.buttonOrder?.[groupId] ?? []
  const ordered: ToolbarButtonId[] = []
  const seen = new Set<string>()
  for (const id of explicit) {
    if (defaultIds.includes(id as ToolbarButtonId) && !seen.has(id)) {
      ordered.push(id as ToolbarButtonId)
      seen.add(id)
    }
  }
  for (const id of defaultIds) {
    if (!seen.has(id)) {
      ordered.push(id)
      seen.add(id)
    }
  }
  return ordered
}

const CustomizeToolbarDialog = ({ config: rawConfig, onChange, onClose }: Props) => {
  const config = normalizeToolbarConfig(rawConfig)
  const groupOrder = resolveGroupOrder(config)
  const hidden = new Set<string>(config.hiddenButtonIds)
  const horizontalScroll = config.horizontalScroll === true

  const commit = (next: SuperToolbarConfig) => onChange(normalizeToolbarConfig(next))

  const moveGroup = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= groupOrder.length) {
      return
    }
    const next = groupOrder.slice()
    ;[next[index], next[target]] = [next[target], next[index]]
    commit({ ...config, groupOrder: next })
  }

  const toggleButton = (id: ToolbarButtonId) => {
    const nextHidden = new Set(hidden)
    if (nextHidden.has(id)) {
      nextHidden.delete(id)
    } else {
      nextHidden.add(id)
    }
    commit({ ...config, hiddenButtonIds: Array.from(nextHidden) as ToolbarButtonId[] })
  }

  const moveButton = (groupId: ToolbarGroupId, index: number, direction: -1 | 1) => {
    const order = resolveButtonOrder(config, groupId)
    const target = index + direction
    if (target < 0 || target >= order.length) {
      return
    }
    const next = order.slice()
    ;[next[index], next[target]] = [next[target], next[index]]
    commit({
      ...config,
      buttonOrder: { ...(config.buttonOrder ?? {}), [groupId]: next },
    })
  }

  const setGroupRows = (groupId: ToolbarGroupId, rows: number) => {
    const nextRows = { ...(config.groupRows ?? {}) }
    if (rows === DEFAULT_GROUP_ROWS) {
      delete nextRows[groupId]
    } else {
      nextRows[groupId] = rows
    }
    commit({ ...config, groupRows: nextRows })
  }

  const setHorizontalScroll = (value: boolean) => commit({ ...config, horizontalScroll: value })

  const reset = () => commit(DEFAULT_SUPER_TOOLBAR_CONFIG)

  const rowOptions: number[] = []
  for (let r = MIN_GROUP_ROWS; r <= MAX_GROUP_ROWS; r++) {
    rowOptions.push(r)
  }

  return (
    <div className="max-h-[min(70vh,32rem)] w-[min(85vw,28rem)] overflow-y-auto">
      <p className="mb-3 text-sm text-passive-0">
        Choose which toolbar buttons are shown, reorder groups and the buttons within them, and pick how many rows each
        group wraps onto. Changes apply immediately.
      </p>

      <label className="mb-3 flex cursor-pointer items-center justify-between gap-3 rounded border border-border px-3 py-2 text-sm">
        <span>
          <span className="font-semibold">Single-line toolbar (horizontal scroll)</span>
          <span className="block text-xs text-passive-1">
            When off, groups wrap onto multiple lines instead of scrolling sideways.
          </span>
        </span>
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer"
          checked={horizontalScroll}
          onChange={(event) => setHorizontalScroll(event.target.checked)}
        />
      </label>

      <div className="flex flex-col gap-3">
        {groupOrder.map((groupId, index) => {
          const group = GROUP_BY_ID.get(groupId)
          if (!group) {
            return null
          }
          const buttonOrder = resolveButtonOrder(config, groupId)
          const buttonById = new Map(group.buttons.map((b) => [b.id, b]))
          const currentRows = config.groupRows?.[groupId] ?? DEFAULT_GROUP_ROWS
          return (
            <div key={groupId} className="rounded border border-border">
              <div className="flex items-center justify-between gap-2 border-b border-border bg-contrast px-3 py-2">
                <span className="text-sm font-semibold">{group.label}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Move ${group.label} up`}
                    title="Move up"
                    className="rounded p-1 enabled:hover:bg-passive-3 disabled:opacity-40"
                    disabled={index === 0}
                    onClick={() => moveGroup(index, -1)}
                  >
                    <Icon type="chevron-up" size="small" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${group.label} down`}
                    title="Move down"
                    className="rounded p-1 enabled:hover:bg-passive-3 disabled:opacity-40"
                    disabled={index === groupOrder.length - 1}
                    onClick={() => moveGroup(index, 1)}
                  >
                    <Icon type="chevron-down" size="small" />
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
                <span className="text-xs text-passive-1">Rows</span>
                <div className="flex items-center gap-1">
                  {rowOptions.map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-label={`Set ${group.label} to ${r} row${r > 1 ? 's' : ''}`}
                      aria-pressed={currentRows === r}
                      className={classNames(
                        'h-6 w-6 rounded text-xs',
                        currentRows === r ? 'bg-info text-info-contrast' : 'hover:bg-passive-3',
                      )}
                      onClick={() => setGroupRows(groupId, r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col px-3 py-1">
                {buttonOrder.map((buttonId, buttonIndex) => {
                  const button = buttonById.get(buttonId)
                  if (!button) {
                    return null
                  }
                  const isShown = !hidden.has(button.id)
                  return (
                    <div key={button.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Move ${button.label} up`}
                          title="Move up"
                          className="rounded p-0.5 enabled:hover:bg-passive-3 disabled:opacity-40"
                          disabled={buttonIndex === 0}
                          onClick={() => moveButton(groupId, buttonIndex, -1)}
                        >
                          <Icon type="chevron-up" size="small" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${button.label} down`}
                          title="Move down"
                          className="rounded p-0.5 enabled:hover:bg-passive-3 disabled:opacity-40"
                          disabled={buttonIndex === buttonOrder.length - 1}
                          onClick={() => moveButton(groupId, buttonIndex, 1)}
                        >
                          <Icon type="chevron-down" size="small" />
                        </button>
                        <span className={classNames('ml-1', !isShown && 'text-passive-1')}>{button.label}</span>
                      </div>
                      <input
                        type="checkbox"
                        aria-label={`Show ${button.label}`}
                        className="h-4 w-4 cursor-pointer"
                        checked={isShown}
                        onChange={() => toggleButton(button.id)}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          className="rounded border border-border px-3 py-1.5 text-sm hover:bg-contrast"
          onClick={reset}
        >
          Reset to default
        </button>
        <button
          type="button"
          className="rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:brightness-110"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>
  )
}

export default CustomizeToolbarDialog
