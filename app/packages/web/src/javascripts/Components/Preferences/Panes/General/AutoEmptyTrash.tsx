import { FunctionComponent, useCallback, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import {
  AUTO_EMPTY_TRASH_OPTIONS,
  AutoEmptyTrashInterval,
  readAutoEmptyTrashInterval,
  writeAutoEmptyTrashInterval,
} from '@/Services/AutoEmptyTrash/AutoEmptyTrashService'
import { achievements, METRICS } from '@/Achievements'

/**
 * Standard Red Notes: lets the user choose how long notes may sit in the Trash
 * before they are permanently (and irreversibly) deleted. The choice is stored
 * per-device in localStorage; "Never" disables the feature.
 */
const AutoEmptyTrash: FunctionComponent = () => {
  const [intervalMs, setIntervalMs] = useState<number>(() => readAutoEmptyTrashInterval())

  const items: DropdownItem[] = AUTO_EMPTY_TRASH_OPTIONS.map((option) => ({
    value: String(option.value),
    label: option.label,
  }))

  const handleChange = useCallback((value: string) => {
    const parsed = Number(value)
    setIntervalMs(parsed)
    writeAutoEmptyTrashInterval(parsed)
    // Easter egg: choosing the ten-year option unlocks a hidden achievement.
    if (parsed === AutoEmptyTrashInterval.TenYears) {
      achievements.markEvent(METRICS.decadeOfTrash)
    }
  }, [])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Auto-empty trash</Title>
        <Subtitle>Permanently delete trashed notes after they reach a chosen age</Subtitle>

        <Text className="mb-3 mt-2">
          When set, this device permanently deletes notes that have been in the Trash longer than the selected age.
          Because your notes are end-to-end encrypted, the server cannot do this for you — the cleanup runs on this
          device on app start and roughly once an hour while open. Only items already in the Trash are affected.
        </Text>

        <Text className="mb-3">
          <strong>Permanent deletion is irreversible.</strong> Once a trashed note is auto-deleted it cannot be
          recovered (unless it exists in a separate backup). Use &ldquo;Never&rdquo; to turn this off. Notes are aged
          from their last-modified time as a proxy for when they were trashed, so editing a note while it is in the
          Trash restarts its countdown.
        </Text>

        <div className="mt-2 max-w-xs">
          <Dropdown
            label="Select how long to keep trashed notes before permanent deletion"
            items={items}
            value={String(intervalMs)}
            onChange={handleChange}
          />
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(AutoEmptyTrash)
