/**
 * Standard Red Notes: customization UI for the Super editor toolbar.
 *
 * Lists every group (in the user's current order) with up/down reordering and a
 * show/hide toggle per button, plus a "Reset to default" action. Changes apply
 * live — the parent persists each new config to the SuperToolbarConfig local
 * pref, so the toolbar updates immediately and across reloads.
 */
import Icon from '@/Components/Icon/Icon'
import { classNames } from '@standardnotes/snjs'
import {
  DEFAULT_SUPER_TOOLBAR_CONFIG,
  DEFAULT_TOOLBAR_GROUPS,
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

const CustomizeToolbarDialog = ({ config: rawConfig, onChange, onClose }: Props) => {
  const config = normalizeToolbarConfig(rawConfig)
  const groupOrder = resolveGroupOrder(config)
  const hidden = new Set<string>(config.hiddenButtonIds)

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

  const reset = () => commit(DEFAULT_SUPER_TOOLBAR_CONFIG)

  return (
    <div className="max-h-[min(70vh,32rem)] w-[min(85vw,28rem)] overflow-y-auto">
      <p className="mb-3 text-sm text-passive-0">
        Choose which toolbar buttons are shown and reorder the groups. Changes apply immediately.
      </p>
      <div className="flex flex-col gap-3">
        {groupOrder.map((groupId, index) => {
          const group = GROUP_BY_ID.get(groupId)
          if (!group) {
            return null
          }
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
              <div className="flex flex-col px-3 py-1">
                {group.buttons.map((button) => {
                  const isShown = !hidden.has(button.id)
                  return (
                    <label
                      key={button.id}
                      className="flex cursor-pointer items-center justify-between gap-3 py-1.5 text-sm"
                    >
                      <span className={classNames(!isShown && 'text-passive-1')}>{button.label}</span>
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer"
                        checked={isShown}
                        onChange={() => toggleButton(button.id)}
                      />
                    </label>
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
