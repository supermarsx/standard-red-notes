import CompoundPredicateBuilder from '@/Components/SmartViewBuilder/CompoundPredicateBuilder'
import Icon from '@/Components/Icon/Icon'
import IconPicker from '@/Components/Icon/IconPicker'
import Popover from '@/Components/Popover/Popover'
import Spinner from '@/Components/Spinner/Spinner'
import { Platform, SmartViewDefaultIconName, VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AddSmartViewModalController } from './AddSmartViewModalController'
import { getPredicatePresets } from './PredicateGuidance'
import TabPanel from '../Tabs/TabPanel'
import { useTabState } from '../Tabs/useTabState'
import TabsContainer from '../Tabs/TabsContainer'
import CopyableCodeBlock from '../Shared/CopyableCodeBlock'
import { classNames } from '@standardnotes/utils'
import Modal, { ModalAction } from '../Modal/Modal'
import { Disclosure, DisclosureContent, useDisclosureStore } from '@ariakit/react'

type Props = {
  controller: AddSmartViewModalController
  platform: Platform
}

const ConflictedNotesExampleCode = `{
  "keypath": "content.conflict_of.length",
  "operator": ">",
  "value": 0
}`

const ComplexCompoundExampleCode = `{
  "operator": "and",
  "value": [
    {
      "operator": "not",
      "value": {
        "keypath": "tags",
        "operator": "includes",
        "value": {
          "keypath": "title",
          "operator": "=",
          "value": "completed"
        }
      }
    },
    {
      "keypath": "tags",
      "operator": "includes",
      "value": {
        "keypath": "title",
        "operator": "=",
        "value": "todo"
      }
    }
  ]
}
`

const AddSmartViewModal = ({ controller, platform }: Props) => {
  const {
    isSaving,
    title,
    setTitle,
    icon,
    setIcon,
    closeModal,
    saveCurrentSmartView,
    predicateController,
    customPredicateJson,
    setCustomPredicateJson,
    isCustomJsonValidPredicate,
    validateAndPrettifyCustomPredicate,
    customPredicateValidationError,
    insertPreset,
  } = controller

  const presets = useMemo(() => getPredicatePresets(), [])

  const titleInputRef = useRef<HTMLInputElement>(null)
  const customJsonInputRef = useRef<HTMLTextAreaElement>(null)

  const [shouldShowIconPicker, setShouldShowIconPicker] = useState(false)
  const iconPickerButtonRef = useRef<HTMLButtonElement>(null)

  const jsonExamplesDisclosure = useDisclosureStore()
  const showingJsonExamples = jsonExamplesDisclosure.useState('open')

  const toggleIconPicker = () => {
    setShouldShowIconPicker((shouldShow) => !shouldShow)
  }

  const tabState = useTabState({
    defaultTab: 'builder',
  })

  const save = useCallback(() => {
    if (!title.length) {
      titleInputRef.current?.focus()
      return
    }

    if (tabState.activeTab === 'custom' && !isCustomJsonValidPredicate) {
      validateAndPrettifyCustomPredicate()
      return
    }

    void saveCurrentSmartView()
  }, [
    isCustomJsonValidPredicate,
    saveCurrentSmartView,
    tabState.activeTab,
    title.length,
    validateAndPrettifyCustomPredicate,
  ])

  const canSave = tabState.activeTab === 'builder' || isCustomJsonValidPredicate

  useEffect(() => {
    if (!customJsonInputRef.current) {
      return
    }

    if (tabState.activeTab === 'custom' && isCustomJsonValidPredicate === false) {
      customJsonInputRef.current.focus()
    }
  }, [isCustomJsonValidPredicate, tabState.activeTab])

  const modalActions = useMemo(
    (): ModalAction[] => [
      {
        label: 'Cancel',
        onClick: closeModal,
        disabled: isSaving,
        type: 'cancel',
        mobileSlot: 'left',
      },
      {
        label: isSaving ? <Spinner className="h-4.5 w-4.5" /> : canSave ? 'Save' : 'Validate',
        onClick: save,
        disabled: isSaving,
        mobileSlot: 'right',
        type: 'primary',
      },
    ],
    [canSave, closeModal, isSaving, save],
  )

  return (
    <Modal title="Add Smart View" close={closeModal} actions={modalActions}>
      <div className="px-4 py-4">
        <div className="flex h-full flex-col gap-4">
          <div className="flex items-center gap-2.5">
            <div className="text-sm font-semibold">Title:</div>
            <input
              className="rounded border border-border bg-default px-2 py-1 md:translucent-ui:bg-transparent"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value)
              }}
              ref={titleInputRef}
            />
          </div>
          <div className="flex items-center gap-2.5">
            <div className="text-sm font-semibold">Icon:</div>
            <button
              className="rounded border border-border p-2"
              aria-label="Change icon"
              onClick={toggleIconPicker}
              ref={iconPickerButtonRef}
            >
              <Icon type={icon || SmartViewDefaultIconName} />
            </button>
            <Popover
              title="Choose icon"
              open={shouldShowIconPicker}
              anchorElement={iconPickerButtonRef}
              togglePopover={toggleIconPicker}
              align="start"
              overrideZIndex="z-modal"
            >
              <div className="p-2">
                <IconPicker
                  selectedValue={icon || SmartViewDefaultIconName}
                  onIconChange={(value?: VectorIconNameOrEmoji) => {
                    setIcon(value ?? SmartViewDefaultIconName)
                    toggleIconPicker()
                  }}
                  platform={platform}
                  useIconGrid={true}
                />
              </div>
            </Popover>
          </div>
          <div className="flex flex-grow flex-col gap-2.5">
            <div className="text-sm font-semibold">Predicate:</div>
            <TabsContainer
              className="flex flex-grow flex-col"
              tabs={[
                {
                  id: 'builder',
                  title: 'Builder',
                },
                {
                  id: 'custom',
                  title: 'Custom (JSON)',
                },
              ]}
              state={tabState}
            >
              <TabPanel state={tabState} id="builder" className="flex flex-col gap-2.5 p-4">
                <CompoundPredicateBuilder controller={predicateController} />
              </TabPanel>
              <TabPanel state={tabState} id="custom" className="flex flex-grow flex-col">
                <textarea
                  className="h-full min-h-[10rem] w-full flex-grow resize-none bg-default px-2.5 py-1.5 font-mono text-sm"
                  value={customPredicateJson}
                  onChange={(event) => {
                    setCustomPredicateJson(event.target.value)
                  }}
                  spellCheck={false}
                  ref={customJsonInputRef}
                  aria-label="Custom predicate JSON"
                  aria-invalid={isCustomJsonValidPredicate === false}
                  aria-describedby="custom-predicate-validation"
                />
                <div
                  id="custom-predicate-validation"
                  aria-live="polite"
                  className="border-t border-border px-2.5 py-1.5 text-sm"
                >
                  {customPredicateJson && isCustomJsonValidPredicate === false && (
                    <div className="flex items-start gap-1.5 text-danger">
                      <Icon type="warning" className="mt-0.5 flex-shrink-0" size="small" />
                      <span>{customPredicateValidationError ?? 'Invalid predicate. Double check your entry.'}</span>
                    </div>
                  )}
                  {customPredicateJson && isCustomJsonValidPredicate === true && (
                    <div className="flex items-center gap-1.5 text-success">
                      <Icon type="check-circle-filled" className="flex-shrink-0" size="small" />
                      <span>Valid predicate. This smart view is ready to save.</span>
                    </div>
                  )}
                  {!customPredicateJson && (
                    <span className="text-passive-0">
                      Paste a predicate below, or pick an example from the list underneath.
                    </span>
                  )}
                </div>
              </TabPanel>
            </TabsContainer>
            {tabState.activeTab === 'custom' && (
              <>
                <div className="flex flex-col gap-1.5 rounded-md border-2 border-info-backdrop bg-info-backdrop px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Icon type="info" className="flex-shrink-0 text-info" size="small" />
                    <div className="text-sm font-semibold">What is a smart view?</div>
                  </div>
                  <div className="text-sm text-passive-0">
                    A smart view automatically collects every note that matches a rule you define, called a{' '}
                    <span className="font-semibold">predicate</span>. A predicate is a small JSON object with three
                    parts: a <span className="font-mono">keypath</span> (the field to look at, such as{' '}
                    <span className="font-mono">pinned</span> or <span className="font-mono">tags</span>), an{' '}
                    <span className="font-mono">operator</span> (such as <span className="font-mono">=</span>,{' '}
                    <span className="font-mono">includes</span>, or <span className="font-mono">{'>'}</span>), and a{' '}
                    <span className="font-mono">value</span> to compare against. Use{' '}
                    <span className="font-mono">and</span>, <span className="font-mono">or</span>, and{' '}
                    <span className="font-mono">not</span> operators to combine several rules. Pick a ready-made example
                    below to get started, then tweak it.
                  </div>
                </div>

                <div className="flex flex-col gap-2 rounded-md border border-border px-4 py-3">
                  <div className="text-sm font-semibold">Insert an example</div>
                  <div className="flex flex-wrap gap-2">
                    {presets.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        title={preset.description}
                        className="flex items-center gap-1.5 rounded border border-border bg-default px-2.5 py-1 text-sm hover:bg-contrast focus:bg-contrast"
                        onClick={() => {
                          insertPreset(preset)
                          customJsonInputRef.current?.focus()
                        }}
                      >
                        <Icon type="add" size="small" className="flex-shrink-0" />
                        <span>{preset.label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="text-xs text-passive-1">
                    Selecting an example fills the editor above with a valid predicate you can save as-is or edit.
                  </div>
                </div>

                <div className="flex flex-col gap-1.5 rounded-md border-2 border-info-backdrop bg-info-backdrop px-4 py-3">
                  <Disclosure
                    store={jsonExamplesDisclosure}
                    className="flex items-center justify-between focus:shadow-none focus:outline-none"
                  >
                    <div className="text-sm font-semibold">Advanced examples</div>
                    <Icon type={showingJsonExamples ? 'chevron-up' : 'chevron-down'} />
                  </Disclosure>
                  <DisclosureContent
                    store={jsonExamplesDisclosure}
                    className={classNames(showingJsonExamples && 'flex', 'flex-col gap-2.5')}
                  >
                    <div className="text-sm font-medium">1. List notes that are conflicted copies of another note:</div>
                    <CopyableCodeBlock code={ConflictedNotesExampleCode} />
                    <div className="text-sm font-medium">
                      2. List notes that have the tag `todo` but not the tag `completed`:
                    </div>
                    <CopyableCodeBlock code={ComplexCompoundExampleCode} />
                  </DisclosureContent>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

export default observer(AddSmartViewModal)
