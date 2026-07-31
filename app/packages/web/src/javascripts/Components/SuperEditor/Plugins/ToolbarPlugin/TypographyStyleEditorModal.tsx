/**
 * Standard Red Notes: Typography Profiles popup style editor.
 *
 * A modal to FULLY edit the per-block styles of the ACTIVE typography profile,
 * with a live, truthful preview. Layout:
 *   - Left: block-type selector — the preview-square grid (each square is a
 *     live preview of that block under the profile being edited); selecting a
 *     square loads its editable `BlockStyle`.
 *   - Right/top: a live `BlockStylePreview` re-rendering on every change.
 *   - Right/body: GROUPED, progressive controls (Typography, Colour,
 *     Spacing & Indent, Alignment, Box/Border for quote/code, List for lists).
 *     All controls are OPTIONAL — an empty value means "inherit".
 *   - Footer: Cancel (discard) / Save (persist).
 *
 * Which profile: the currently ACTIVE profile (`resolveActiveTypographyProfile`).
 * Save writes the edited blocks back and persists via
 * `application.setPreference(PrefKey.TypographyProfiles, …)`, which NoteView's
 * `usePreference` already reacts to → live re-apply across editor/read/preview.
 *
 * Reuse: the profile model + `blockStyleToInlineStyle`/`resolveActiveTypographyProfile`;
 * `BlockStylePreview` + `GALLERY_BLOCKS`; `blockFormatting` presets;
 * `editorFont` grammar (font family); the shared `Modal`/`ModalOverlay`,
 * `Dropdown`, and native colour-swatch inputs. Sanitisation +
 * profile-write live in `Utils/typographyProfileEditor`.
 */
import { CSSProperties, ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { classNames, PrefKey } from '@standardnotes/snjs'
import type { BlockStyle, BlockTypeKey, TypographyProfile } from '@standardnotes/models'
import { useApplication } from '@/Components/ApplicationProvider'
import usePreference from '@/Hooks/usePreference'
import Icon from '@/Components/Icon/Icon'
import Modal from '@/Components/Modal/Modal'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import { blockStyleToInlineStyle, resolveActiveTypographyProfile } from '@/Utils/typographyProfiles'
import { sanitizeBlockStyle, setProfileBlocks } from '@/Utils/typographyProfileEditor'
import { BlockStylePreview } from './BlockStyleGallery'
import { GALLERY_BLOCKS, orderGalleryBlocks, reorderGalleryKeys } from './typographyGallery'
import { INDENT_STEP, LINE_HEIGHT_PRESETS, SPACING_PRESETS } from './blockFormatting'

type DraftBlocks = Partial<Record<BlockTypeKey, BlockStyle>>

/** Deep-copy a profile's block map so editing never mutates the pref object. */
const cloneBlocks = (blocks: DraftBlocks | undefined): DraftBlocks => {
  const clone: DraftBlocks = {}
  if (!blocks) {
    return clone
  }
  for (const key of Object.keys(blocks) as BlockTypeKey[]) {
    const style = blocks[key]
    if (style) {
      clone[key] = { ...style }
    }
  }
  return clone
}

/* -------------------------------------------------------------- primitives */

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="flex items-center justify-between gap-3 py-1">
    <span className="text-text flex-shrink-0 text-sm">{label}</span>
    <span className="flex min-w-0 items-center gap-1.5">{children}</span>
  </label>
)

/** A free-text CSS value input; empty string = inherit. */
const TextControl = ({
  value,
  placeholder,
  onChange,
}: {
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) => (
  <input
    type="text"
    value={value}
    placeholder={placeholder ?? 'inherit'}
    onChange={(event) => onChange(event.target.value)}
    className="border-border bg-default text-text focus:border-info w-40 min-w-0 rounded border px-2 py-1 text-sm focus:outline-none"
  />
)

/** A text value with quick preset chips (spacing / line-height / indent). */
const PresetControl = ({
  value,
  presets,
  placeholder,
  onChange,
}: {
  value: string
  presets: readonly string[]
  placeholder?: string
  onChange: (value: string) => void
}) => (
  <span className="flex items-center gap-1">
    <span className="hidden flex-wrap gap-1 md:flex">
      {presets.map((preset) => (
        <button
          key={preset}
          type="button"
          onClick={() => onChange(preset)}
          className={classNames(
            'rounded border px-1.5 py-0.5 text-xs',
            value.trim() === preset
              ? 'border-info bg-info text-info-contrast'
              : 'border-border text-passive-0 hover:bg-contrast',
          )}
        >
          {preset}
        </button>
      ))}
    </span>
    <TextControl value={value} placeholder={placeholder} onChange={onChange} />
  </span>
)

/** A colour value: a native swatch (writes hex) plus a text input (accepts var()). */
const ColorControl = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
  // The native picker only understands hex; fall back to black when the current
  // value is a var()/keyword so the swatch is still usable.
  const swatchValue = /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : '#000000'
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="color"
        aria-label="Colour swatch"
        value={swatchValue}
        onChange={(event) => onChange(event.target.value)}
        className="border-border h-7 w-8 flex-shrink-0 cursor-pointer rounded border bg-transparent p-0"
      />
      <TextControl value={value} placeholder="inherit" onChange={onChange} />
    </span>
  )
}

/** A dropdown for enumerated properties. The first item (value '') = inherit. */
const SelectControl = ({
  label,
  value,
  items,
  onChange,
}: {
  label: string
  value: string
  items: DropdownItem[]
  onChange: (value: string) => void
}) => (
  <Dropdown
    label={label}
    value={value}
    items={items}
    onChange={onChange}
    fullWidth
    popoverPlacement="bottom"
    classNameOverride={{ wrapper: 'w-40', button: '!min-w-0 !py-1 !text-sm' }}
  />
)

/** A collapsible group of related controls. */
const Group = ({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) => {
  const [open, setOpen] = useState(Boolean(defaultOpen))
  return (
    <div className="border-border border-b">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="text-text hover:bg-contrast flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold"
      >
        {title}
        <Icon type="chevron-down" size="small" className={classNames('text-passive-1', open ? 'rotate-180' : '')} />
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

/* ----------------------------------------------------------- select option sets */

const inheritFirst = (items: DropdownItem[]): DropdownItem[] => [{ label: 'Inherit', value: '' }, ...items]

const FONT_WEIGHT_ITEMS = inheritFirst(
  ['300', '400', '500', '600', '700', '800', '900'].map((w) => ({
    label: w === '400' ? '400 (normal)' : w === '700' ? '700 (bold)' : w,
    value: w,
  })),
)
const FONT_STYLE_ITEMS = inheritFirst([
  { label: 'Normal', value: 'normal' },
  { label: 'Italic', value: 'italic' },
])
const TEXT_TRANSFORM_ITEMS = inheritFirst([
  { label: 'None', value: 'none' },
  { label: 'UPPERCASE', value: 'uppercase' },
  { label: 'lowercase', value: 'lowercase' },
  { label: 'Capitalize', value: 'capitalize' },
])
const TEXT_ALIGN_ITEMS = inheritFirst([
  { label: 'Left', value: 'left' },
  { label: 'Center', value: 'center' },
  { label: 'Right', value: 'right' },
  { label: 'Justify', value: 'justify' },
])
const BORDER_STYLE_ITEMS = inheritFirst([
  { label: 'Solid', value: 'solid' },
  { label: 'Dashed', value: 'dashed' },
  { label: 'Dotted', value: 'dotted' },
  { label: 'Double', value: 'double' },
  { label: 'None', value: 'none' },
])
const BORDER_SIDE_ITEMS: DropdownItem[] = [
  { label: 'All sides', value: 'all' },
  { label: 'Left', value: 'left' },
  { label: 'Right', value: 'right' },
  { label: 'Top', value: 'top' },
  { label: 'Bottom', value: 'bottom' },
]
const LIST_MARKER_ITEMS = inheritFirst([
  { label: 'Disc', value: 'disc' },
  { label: 'Circle', value: 'circle' },
  { label: 'Square', value: 'square' },
  { label: 'Decimal', value: 'decimal' },
  { label: 'Lower alpha', value: 'lower-alpha' },
  { label: 'Upper alpha', value: 'upper-alpha' },
  { label: 'Lower roman', value: 'lower-roman' },
  { label: 'Upper roman', value: 'upper-roman' },
  { label: 'None', value: 'none' },
])

const isBoxBlock = (key: BlockTypeKey): boolean => key === 'quote' || key === 'code' || key === 'callout'
const isListBlock = (key: BlockTypeKey): boolean =>
  key === 'bulletList' || key === 'numberedList' || key === 'checkList'

/* ------------------------------------------------------------------- content */

const ModalContent = ({ close, profileId }: { close: () => void; profileId?: string }) => {
  const { t } = useTranslation('editor')
  const application = useApplication()
  const profiles = usePreference(PrefKey.TypographyProfiles)
  const activeId = usePreference(PrefKey.ActiveTypographyProfileId)

  // The block-style gallery display order (synced pref; empty = built-in default),
  // resolved to ordered descriptors for the left selector column. Reordering is a
  // GLOBAL preference, orthogonal to `draftBlocks` and to this modal's Save/Cancel:
  // its `setPreference` writes take effect immediately and are never part of the
  // profile draft, so switching order never touches the style edits in progress.
  const galleryOrder = usePreference(PrefKey.BlockStyleGalleryOrder)
  const orderedBlocks = useMemo(() => orderGalleryBlocks(galleryOrder), [galleryOrder])
  const [reordering, setReordering] = useState(false)

  const moveBlock = (key: BlockTypeKey, direction: -1 | 1): void => {
    const orderedKeys = orderedBlocks.map((descriptor) => descriptor.key)
    void application.setPreference(PrefKey.BlockStyleGalleryOrder, reorderGalleryKeys(orderedKeys, key, direction))
  }
  const resetOrder = (): void => {
    void application.setPreference(PrefKey.BlockStyleGalleryOrder, [])
  }

  // The profile being edited: an explicit `profileId` (P4 — edit ANY profile from
  // Settings) when given, otherwise the ACTIVE profile (P3 — in-editor button).
  const targetProfile: TypographyProfile | null = useMemo(
    () =>
      (profileId ? profiles?.find((p) => p.id === profileId) : undefined) ??
      resolveActiveTypographyProfile(profiles, activeId),
    [profiles, activeId, profileId],
  )

  const [draftBlocks, setDraftBlocks] = useState<DraftBlocks>(() => cloneBlocks(targetProfile?.blocks))
  const [selectedKey, setSelectedKey] = useState<BlockTypeKey>('paragraph')

  const selectedDescriptor = GALLERY_BLOCKS.find((descriptor) => descriptor.key === selectedKey) ?? GALLERY_BLOCKS[0]
  const draft = draftBlocks[selectedKey] ?? {}

  const inlineFor = (key: BlockTypeKey): CSSProperties => {
    // Layer the built-in `baseStyle` (paragraph-variant identity) under the draft
    // so a variant previews correctly before the user overrides anything — the
    // same merge used at apply time and in the toolbar gallery squares.
    const base = GALLERY_BLOCKS.find((descriptor) => descriptor.key === key)?.baseStyle ?? {}
    return blockStyleToInlineStyle(sanitizeBlockStyle({ ...base, ...draftBlocks[key] })) as CSSProperties
  }

  const setField = (prop: keyof BlockStyle, value: string): void => {
    setDraftBlocks((prev) => {
      // Edit through a string-map view: `prop` spans a key union (incl. the
      // borderSide enum), which TS won't let us assign a plain string to directly.
      const current = { ...(prev[selectedKey] ?? {}) } as Record<string, string>
      if (value.trim() === '') {
        delete current[prop]
      } else {
        current[prop] = value
      }
      return { ...prev, [selectedKey]: current as BlockStyle }
    })
  }

  const get = (prop: keyof BlockStyle): string => (draft[prop] as string | undefined) ?? ''

  const onSave = (): void => {
    if (!targetProfile) {
      close()
      return
    }
    const updated = setProfileBlocks(profiles, targetProfile.id, draftBlocks)
    void application.setPreference(PrefKey.TypographyProfiles, updated)
    close()
  }

  return (
    <Modal
      title={`Edit styles — ${targetProfile ? targetProfile.name : 'Default'}`}
      close={close}
      className="p-0"
      actions={[
        { label: 'Cancel', type: 'cancel', onClick: close, mobileSlot: 'left' },
        { label: 'Save', type: 'primary', onClick: onSave, mobileSlot: 'right' },
      ]}
    >
      <div className="md:divide-border flex flex-col md:flex-row md:divide-x">
        {/* Left: block-type selector (P2 preview squares, now live on the draft),
            in the user's saved gallery order. A "Reorder" toggle swaps the grid
            for a dependency-free move-up/down list that writes the global order
            pref immediately (independent of this modal's Save/Cancel). */}
        <div className="border-border flex-shrink-0 border-b p-2 md:w-52 md:border-b-0">
          <div className="mb-1 flex items-center justify-between gap-2 px-1">
            <span className="text-passive-1 text-xs">Block type</span>
            <button
              type="button"
              aria-pressed={reordering}
              onClick={() => setReordering((prev) => !prev)}
              className={classNames(
                'flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs transition-colors duration-75',
                reordering
                  ? 'border-info bg-info text-info-contrast'
                  : 'border-border text-passive-0 hover:bg-contrast',
              )}
            >
              <Icon type="arrows-vertical" size="custom" className="h-3.5 w-3.5 flex-shrink-0" />
              {reordering ? t('doneReordering') : t('reorderBlockStyles')}
            </button>
          </div>
          {reordering ? (
            <div className="flex flex-col gap-1">
              {orderedBlocks.map((descriptor, index) => (
                <div
                  key={descriptor.key}
                  className="border-border bg-default flex items-center gap-1 rounded border px-2 py-1"
                >
                  <Icon type={descriptor.iconName} size="custom" className="text-passive-1 h-3.5 w-3.5 flex-shrink-0" />
                  <span className="text-text min-w-0 flex-grow overflow-hidden text-xs text-ellipsis whitespace-nowrap">
                    {descriptor.label}
                  </span>
                  <button
                    type="button"
                    aria-label={t('moveBlockStyleUp')}
                    title={t('moveBlockStyleUp')}
                    disabled={index === 0}
                    onClick={() => moveBlock(descriptor.key, -1)}
                    className="text-passive-1 hover:bg-contrast flex-shrink-0 rounded p-0.5 disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <Icon type="chevron-up" size="custom" className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('moveBlockStyleDown')}
                    title={t('moveBlockStyleDown')}
                    disabled={index === orderedBlocks.length - 1}
                    onClick={() => moveBlock(descriptor.key, 1)}
                    className="text-passive-1 hover:bg-contrast flex-shrink-0 rounded p-0.5 disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <Icon type="chevron-down" size="custom" className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={resetOrder}
                className="border-border text-passive-0 hover:bg-contrast mt-1 rounded border px-2 py-1 text-xs"
              >
                {t('resetBlockStyleOrder')}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5 md:grid-cols-2">
              {orderedBlocks.map((descriptor) => (
                <button
                  key={descriptor.key}
                  type="button"
                  aria-label={descriptor.label}
                  aria-pressed={descriptor.key === selectedKey}
                  onClick={() => setSelectedKey(descriptor.key)}
                  className={classNames(
                    'flex flex-col items-stretch gap-1 rounded border p-1.5 transition-colors duration-75 select-none',
                    descriptor.key === selectedKey
                      ? 'border-info bg-contrast'
                      : 'border-border bg-default hover:border-info',
                  )}
                >
                  <div
                    className="flex h-10 items-center overflow-hidden rounded-sm px-1.5"
                    style={{
                      backgroundColor: 'var(--sn-stylekit-editor-background-color)',
                      color: 'var(--sn-stylekit-editor-foreground-color)',
                    }}
                  >
                    <BlockStylePreview descriptor={descriptor} style={inlineFor(descriptor.key)} />
                  </div>
                  <span className="flex items-center gap-1 overflow-hidden">
                    <Icon
                      type={descriptor.iconName}
                      size="custom"
                      className="text-passive-1 h-3.5 w-3.5 flex-shrink-0"
                    />
                    <span className="text-passive-0 overflow-hidden text-[0.65rem] leading-none text-ellipsis whitespace-nowrap">
                      {descriptor.label}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: live preview + grouped controls for the selected block. */}
        <div className="flex min-w-0 flex-grow flex-col">
          <div className="border-border border-b p-3">
            <div className="text-passive-1 mb-1 text-xs">Live preview · {selectedDescriptor.label}</div>
            <div
              className="flex min-h-16 items-center overflow-hidden rounded px-3 py-2"
              style={{
                backgroundColor: 'var(--sn-stylekit-editor-background-color)',
                color: 'var(--sn-stylekit-editor-foreground-color)',
              }}
            >
              <BlockStylePreview descriptor={selectedDescriptor} style={inlineFor(selectedKey)} />
            </div>
          </div>

          <div className="min-h-0 flex-grow overflow-y-auto">
            <Group title="Typography" defaultOpen>
              <Field label="Font family">
                <TextControl
                  value={get('fontFamily')}
                  placeholder="e.g. Georgia, serif · google:Inter"
                  onChange={(v) => setField('fontFamily', v)}
                />
              </Field>
              <Field label="Font size">
                <TextControl
                  value={get('fontSize')}
                  placeholder="e.g. 1rem, 18px"
                  onChange={(v) => setField('fontSize', v)}
                />
              </Field>
              <Field label="Font weight">
                <SelectControl
                  label="Font weight"
                  value={get('fontWeight')}
                  items={FONT_WEIGHT_ITEMS}
                  onChange={(v) => setField('fontWeight', v)}
                />
              </Field>
              <Field label="Font style">
                <SelectControl
                  label="Font style"
                  value={get('fontStyle')}
                  items={FONT_STYLE_ITEMS}
                  onChange={(v) => setField('fontStyle', v)}
                />
              </Field>
              <Field label="Letter spacing">
                <TextControl
                  value={get('letterSpacing')}
                  placeholder="e.g. 0.02em"
                  onChange={(v) => setField('letterSpacing', v)}
                />
              </Field>
              <Field label="Text transform">
                <SelectControl
                  label="Text transform"
                  value={get('textTransform')}
                  items={TEXT_TRANSFORM_ITEMS}
                  onChange={(v) => setField('textTransform', v)}
                />
              </Field>
              <Field label="Line height">
                <PresetControl
                  value={get('lineHeight')}
                  presets={LINE_HEIGHT_PRESETS}
                  placeholder="e.g. 1.5"
                  onChange={(v) => setField('lineHeight', v)}
                />
              </Field>
            </Group>

            <Group title="Colour">
              <Field label="Text colour">
                <ColorControl value={get('color')} onChange={(v) => setField('color', v)} />
              </Field>
              <Field label="Background">
                <ColorControl value={get('backgroundColor')} onChange={(v) => setField('backgroundColor', v)} />
              </Field>
            </Group>

            <Group title="Spacing & indent">
              <Field label="Space before">
                <PresetControl
                  value={get('marginTop')}
                  presets={SPACING_PRESETS}
                  onChange={(v) => setField('marginTop', v)}
                />
              </Field>
              <Field label="Space after">
                <PresetControl
                  value={get('marginBottom')}
                  presets={SPACING_PRESETS}
                  onChange={(v) => setField('marginBottom', v)}
                />
              </Field>
              <Field label="Indent left">
                <PresetControl
                  value={get('paddingLeft')}
                  presets={['0', INDENT_STEP]}
                  onChange={(v) => setField('paddingLeft', v)}
                />
              </Field>
              <Field label="Indent right">
                <PresetControl
                  value={get('paddingRight')}
                  presets={['0', INDENT_STEP]}
                  onChange={(v) => setField('paddingRight', v)}
                />
              </Field>
              <Field label="First-line indent">
                <TextControl
                  value={get('textIndent')}
                  placeholder="e.g. 2em"
                  onChange={(v) => setField('textIndent', v)}
                />
              </Field>
              <Field label="Margin left">
                <TextControl value={get('marginLeft')} onChange={(v) => setField('marginLeft', v)} />
              </Field>
              <Field label="Margin right">
                <TextControl value={get('marginRight')} onChange={(v) => setField('marginRight', v)} />
              </Field>
            </Group>

            <Group title="Alignment">
              <Field label="Text align">
                <SelectControl
                  label="Text align"
                  value={get('textAlign')}
                  items={TEXT_ALIGN_ITEMS}
                  onChange={(v) => setField('textAlign', v)}
                />
              </Field>
            </Group>

            {isBoxBlock(selectedKey) && (
              <Group title="Box & border">
                <Field label="Border side">
                  <SelectControl
                    label="Border side"
                    value={get('borderSide') || 'all'}
                    items={BORDER_SIDE_ITEMS}
                    onChange={(v) => setField('borderSide', v)}
                  />
                </Field>
                <Field label="Border colour">
                  <ColorControl value={get('borderColor')} onChange={(v) => setField('borderColor', v)} />
                </Field>
                <Field label="Border width">
                  <TextControl
                    value={get('borderWidth')}
                    placeholder="e.g. 4px"
                    onChange={(v) => setField('borderWidth', v)}
                  />
                </Field>
                <Field label="Border style">
                  <SelectControl
                    label="Border style"
                    value={get('borderStyle')}
                    items={BORDER_STYLE_ITEMS}
                    onChange={(v) => setField('borderStyle', v)}
                  />
                </Field>
                <Field label="Border radius">
                  <TextControl
                    value={get('borderRadius')}
                    placeholder="e.g. 0.25rem"
                    onChange={(v) => setField('borderRadius', v)}
                  />
                </Field>
                <Field label="Vertical padding">
                  <TextControl
                    value={get('paddingBlock')}
                    placeholder="e.g. 1rem"
                    onChange={(v) => setField('paddingBlock', v)}
                  />
                </Field>
              </Group>
            )}

            {isListBlock(selectedKey) && (
              <Group title="List">
                <Field label="Marker style">
                  <SelectControl
                    label="Marker style"
                    value={get('listMarkerStyle')}
                    items={LIST_MARKER_ITEMS}
                    onChange={(v) => setField('listMarkerStyle', v)}
                  />
                </Field>
                <Field label="Marker colour">
                  <ColorControl value={get('markerColor')} onChange={(v) => setField('markerColor', v)} />
                </Field>
              </Group>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

/**
 * The popup style editor. Mounted (and its draft seeded) only while open, so
 * Cancel/close discards; reopening starts fresh from the target profile.
 *
 * `profileId` selects which profile to edit: omit it (P3 in-editor button) to
 * edit the ACTIVE profile, or pass an id (P4 Settings) to edit that profile.
 */
const TypographyStyleEditorModal = ({
  isOpen,
  close,
  profileId,
}: {
  isOpen: boolean
  close: () => void
  profileId?: string
}) => (
  <ModalOverlay isOpen={isOpen} close={close} className="md:!w-auto md:max-w-[52rem]">
    <ModalContent close={close} profileId={profileId} />
  </ModalOverlay>
)

export default TypographyStyleEditorModal
