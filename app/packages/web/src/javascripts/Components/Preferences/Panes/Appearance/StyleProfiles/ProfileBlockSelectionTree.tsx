/**
 * Standard Red Notes: Typography Profiles — transfer wizard, selection TREE.
 *
 * The grouped checkbox tree shared by BOTH wizard modes. For each profile it
 * shows a whole-profile checkbox (select / clear all its blocks) and, beneath it,
 * the blocks the profile actually carries — grouped into the catalog's "Blocks"
 * and "Variants" sections (§3 product decision: variants are INCLUDED but clearly
 * labelled). Selection is driven entirely by e1's pure/immutable helpers so this
 * component holds no state of its own.
 *
 * Only blocks a profile CARRIES are offered (an unstyled block has nothing to
 * transfer), computed from e1's `buildFullSelection` so the tree and the transfer
 * logic agree on exactly which keys exist.
 */
import { FunctionComponent } from 'react'
import type { BlockTypeKey, TypographyProfile } from '@standardnotes/models'
import { classNames } from '@standardnotes/snjs'
import { BLOCK_CATALOG_GROUPS } from '@/Utils/typographyProfileBlockCatalog'
import {
  buildFullSelection,
  isBlockSelected,
  setBlockSelected,
  setProfileSelected,
  type ProfileBlockSelection,
} from '@/Utils/typographyProfileImportExport'

type Props = {
  profiles: TypographyProfile[]
  selection: ProfileBlockSelection
  onChange: (next: ProfileBlockSelection) => void
}

/** A checkbox that can also show an indeterminate (some-but-not-all) state. */
const TriStateCheckbox: FunctionComponent<{
  checked: boolean
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  label: string
}> = ({ checked, indeterminate, onChange, label }) => (
  <input
    type="checkbox"
    aria-label={label}
    checked={checked}
    ref={(element) => {
      if (element) {
        element.indeterminate = Boolean(indeterminate) && !checked
      }
    }}
    onChange={(event) => onChange(event.target.checked)}
    className="mr-2 flex-shrink-0"
  />
)

const ProfileBlockSelectionTree: FunctionComponent<Props> = ({ profiles, selection, onChange }) => {
  // The full universe of transferable blocks per profile (styled, non-empty),
  // straight from the transfer layer so the tree can never offer a key the logic
  // wouldn't carry.
  const available = buildFullSelection(profiles)

  if (profiles.length === 0) {
    return <div className="text-passive-1 text-sm">No profiles to select.</div>
  }

  return (
    <div className="flex flex-col gap-3">
      {profiles.map((profile) => {
        const availableKeys = available[profile.id] ?? []
        const selectedKeys = selection[profile.id] ?? []
        const allSelected = availableKeys.length > 0 && selectedKeys.length === availableKeys.length
        const someSelected = selectedKeys.length > 0

        return (
          <div key={profile.id} className="border-border rounded border px-3 py-2">
            <label className="text-text flex items-center text-sm font-semibold">
              <TriStateCheckbox
                checked={allSelected}
                indeterminate={someSelected}
                onChange={(checked) => onChange(setProfileSelected(selection, profile, checked))}
                label={`Select all blocks in ${profile.name}`}
              />
              <span className="truncate">{profile.name}</span>
              <span className="text-passive-1 ml-2 flex-shrink-0 text-xs font-normal">
                {selectedKeys.length}/{availableKeys.length} blocks
              </span>
            </label>

            {availableKeys.length === 0 ? (
              <div className="text-passive-1 mt-1 pl-6 text-xs">This profile has no styled blocks.</div>
            ) : (
              <div className="mt-2 flex flex-col gap-2 pl-6">
                {BLOCK_CATALOG_GROUPS.map((group) => {
                  const groupKeys = group.entries.filter((entry) => availableKeys.includes(entry.key))
                  if (groupKeys.length === 0) {
                    return null
                  }
                  return (
                    <div key={group.id}>
                      <div className="text-passive-1 mb-1 text-xs font-semibold tracking-wide uppercase">
                        {group.label}
                      </div>
                      <div className="flex flex-col">
                        {groupKeys.map((entry) => {
                          const key = entry.key as BlockTypeKey
                          const checked = isBlockSelected(selection, profile.id, key)
                          return (
                            <label
                              key={entry.key}
                              className={classNames(
                                'flex items-center py-0.5 text-sm',
                                checked ? 'text-text' : 'text-passive-0',
                              )}
                            >
                              <TriStateCheckbox
                                checked={checked}
                                onChange={(next) => onChange(setBlockSelected(selection, profile.id, key, next))}
                                label={`${entry.label} in ${profile.name}`}
                              />
                              {entry.label}
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default ProfileBlockSelectionTree
