import Icon from '@/Components/Icon/Icon'
import Menu from '@/Components/Menu/Menu'
import { usePremiumModal } from '@/Hooks/usePremiumModal'
import { STRING_EDIT_LOCKED_ATTEMPT } from '@/Constants/Strings'
import { WebApplication } from '@/Application/WebApplication'
import {
  UIFeature,
  EditorFeatureDescription,
  NativeFeatureIdentifier,
  IframeComponentFeatureDescription,
  NoteMutator,
  NoteType,
  SNNote,
  ContentType,
  LocalPrefKey,
  PrefKey,
  PrefDefaults,
} from '@standardnotes/snjs'
import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { EditorMenuGroup } from '@/Components/NotesOptions/EditorMenuGroup'
import { EditorMenuItem } from '@/Components/NotesOptions/EditorMenuItem'
import { createEditorMenuGroups } from '../../Utils/createEditorMenuGroups'
import { reloadFont } from '../NoteView/FontFunctions'
import { SuperNoteImporter } from '../SuperEditor/SuperNoteImporter'
import MenuRadioButtonItem from '../Menu/MenuRadioButtonItem'
import { Pill } from '../Preferences/PreferencesComponents/Content'
import ModalOverlay from '../Modal/ModalOverlay'
import SuperNoteConverter from '../SuperEditor/SuperNoteConverter'
import MenuSection from '../Menu/MenuSection'
import { CanvasEditorIdentifier } from '../NoteView/CanvasEditor/CanvasEditor'
import { parseCanvasDocument, serializeCanvasDocument, createEmptyCanvasDocument } from '../NoteView/CanvasEditor/CanvasDocument'
import { BaseEditorIdentifier } from '../NoteView/BaseEditor/BaseEditor'
import { parseBaseDocument, serializeBaseDocument, createEmptyBaseDocument } from '../NoteView/BaseEditor/BaseDocument'

type ChangeEditorMenuProps = {
  application: WebApplication
  closeMenu: () => void
  note: SNNote | undefined
  onSelect?: (component: UIFeature<EditorFeatureDescription | IframeComponentFeatureDescription>) => void
  setDisableClickOutside?: (value: boolean) => void
}

const getGroupId = (group: EditorMenuGroup) => group.title.toLowerCase().replace(/\s/, '-')

const ChangeEditorMenu: FunctionComponent<ChangeEditorMenuProps> = ({
  application,
  closeMenu,
  note,
  onSelect,
  setDisableClickOutside,
}) => {
  const [groups, setGroups] = useState<EditorMenuGroup[]>([])
  const [unableToFindEditor, setUnableToFindEditor] = useState(false)

  const reloadGroups = useCallback(() => {
    const groups = createEditorMenuGroups(application)
    setGroups(groups)

    if (note && note.editorIdentifier) {
      let didFindEditor = false
      for (const group of groups) {
        for (const item of group.items) {
          if (item.uiFeature.featureIdentifier === note.editorIdentifier) {
            didFindEditor = true
            break
          }
        }
      }

      setUnableToFindEditor(!didFindEditor)
    }
  }, [application, note])

  useEffect(() => {
    application.items.streamItems([ContentType.TYPES.Component], reloadGroups)
  }, [application, reloadGroups])

  useEffect(() => {
    reloadGroups()
  }, [reloadGroups])

  const [currentFeature, setCurrentFeature] =
    useState<UIFeature<EditorFeatureDescription | IframeComponentFeatureDescription>>()
  const [pendingConversionItem, setPendingConversionItem] = useState<EditorMenuItem | null>(null)

  const showSuperNoteImporter =
    !!pendingConversionItem &&
    note?.noteType !== NoteType.Super &&
    !!note?.text.length &&
    pendingConversionItem.uiFeature.noteType === NoteType.Super
  const showSuperNoteConverter =
    !!pendingConversionItem &&
    note?.noteType === NoteType.Super &&
    pendingConversionItem.uiFeature.noteType !== NoteType.Super

  useEffect(() => {
    if (note) {
      setCurrentFeature(application.componentManager.editorForNote(note))
    }
  }, [application, note])

  const premiumModal = usePremiumModal()

  const isSelected = useCallback(
    (item: EditorMenuItem) => {
      // Canvas and Base are selected via editorIdentifier and are not part of the
      // native feature groups; when active, no native/group item should appear chosen.
      if (note?.editorIdentifier === CanvasEditorIdentifier || note?.editorIdentifier === BaseEditorIdentifier) {
        return false
      }

      if (currentFeature) {
        return item.uiFeature.featureIdentifier === currentFeature.featureIdentifier
      }

      const itemNoteTypeIsSameAsCurrentNoteType = item.uiFeature.noteType === note?.noteType
      const noteDoesntHaveTypeAndItemIsPlain = !note?.noteType && item.uiFeature.noteType === NoteType.Plain
      const unknownNoteTypeAndItemIsPlain =
        note?.noteType === NoteType.Unknown && item.uiFeature.noteType === NoteType.Plain

      return itemNoteTypeIsSameAsCurrentNoteType || noteDoesntHaveTypeAndItemIsPlain || unknownNoteTypeAndItemIsPlain
    },
    [currentFeature, note],
  )

  const selectComponent = useCallback(
    async (uiFeature: UIFeature<EditorFeatureDescription | IframeComponentFeatureDescription>, note: SNNote) => {
      if (uiFeature.isComponent && uiFeature.asComponent.conflictOf) {
        void application.changeAndSaveItem.execute(uiFeature.asComponent, (mutator) => {
          mutator.conflictOf = undefined
        })
      }

      await application.itemListController.insertCurrentIfTemplate()

      await application.changeAndSaveItem.execute(note, (mutator) => {
        const noteMutator = mutator as NoteMutator
        noteMutator.noteType = uiFeature.noteType
        noteMutator.editorIdentifier = uiFeature.featureIdentifier
      })

      setCurrentFeature(application.componentManager.editorForNote(note))

      if (uiFeature.featureIdentifier === NativeFeatureIdentifier.TYPES.PlainEditor) {
        reloadFont(
          application.preferences.getLocalValue(LocalPrefKey.EditorMonospaceEnabled),
          application.getPreference(PrefKey.EditorFontFamily, PrefDefaults[PrefKey.EditorFontFamily]),
        )
      }
    },
    [application],
  )

  const isCanvasSelected = note?.editorIdentifier === CanvasEditorIdentifier

  const selectCanvas = useCallback(async () => {
    if (!note) {
      return
    }
    if (note.locked) {
      application.alerts.alert(STRING_EDIT_LOCKED_ATTEMPT).catch(console.error)
      return
    }

    // Preserve any non-canvas content: only overwrite note.text with an empty
    // canvas when the existing text isn't already a recoverable canvas doc.
    const { recovered } = parseCanvasDocument(note.text)
    if (!recovered && note.text.length > 0) {
      const proceed = await application.alerts.confirm(
        'Switching this note to Canvas will replace its current content with an empty board. This cannot be undone.',
        'Switch to Canvas?',
        'Switch to Canvas',
      )
      if (!proceed) {
        return
      }
    }

    await application.itemListController.insertCurrentIfTemplate()

    await application.changeAndSaveItem.execute(note, (mutator) => {
      const noteMutator = mutator as NoteMutator
      noteMutator.noteType = NoteType.Unknown
      noteMutator.editorIdentifier = CanvasEditorIdentifier
      if (!recovered || note.text.length === 0) {
        noteMutator.text = serializeCanvasDocument(createEmptyCanvasDocument())
      } else {
        noteMutator.text = serializeCanvasDocument(parseCanvasDocument(note.text).document)
      }
    })

    setCurrentFeature(undefined)
    closeMenu()
  }, [application, note, closeMenu])

  const isBaseSelected = note?.editorIdentifier === BaseEditorIdentifier

  const selectBase = useCallback(async () => {
    if (!note) {
      return
    }
    if (note.locked) {
      application.alerts.alert(STRING_EDIT_LOCKED_ATTEMPT).catch(console.error)
      return
    }

    // Preserve any non-base content: only overwrite note.text with an empty base
    // when the existing text isn't already a recoverable base definition.
    const { recovered } = parseBaseDocument(note.text)
    if (!recovered && note.text.length > 0) {
      const proceed = await application.alerts.confirm(
        'Switching this note to a Base will replace its current content with an empty table definition. This cannot be undone.',
        'Switch to Base?',
        'Switch to Base',
      )
      if (!proceed) {
        return
      }
    }

    await application.itemListController.insertCurrentIfTemplate()

    await application.changeAndSaveItem.execute(note, (mutator) => {
      const noteMutator = mutator as NoteMutator
      noteMutator.noteType = NoteType.Unknown
      noteMutator.editorIdentifier = BaseEditorIdentifier
      if (!recovered || note.text.length === 0) {
        noteMutator.text = serializeBaseDocument(createEmptyBaseDocument())
      } else {
        noteMutator.text = serializeBaseDocument(parseBaseDocument(note.text).document)
      }
    })

    setCurrentFeature(undefined)
    closeMenu()
  }, [application, note, closeMenu])

  const handleConversionCompletion = useCallback(
    (item?: EditorMenuItem) => {
      const conversionItem = item || pendingConversionItem

      if (!conversionItem || !note) {
        return
      }

      selectComponent(conversionItem.uiFeature, note).catch(console.error)
      closeMenu()
    },
    [pendingConversionItem, note, closeMenu, selectComponent],
  )

  const handleMenuSelection = useCallback(
    async (menuItem: EditorMenuItem) => {
      if (!menuItem.isEntitled) {
        if (menuItem.uiFeature.featureIdentifier === NativeFeatureIdentifier.TYPES.SuperEditor) {
          premiumModal.showSuperDemo()
          return
        }

        premiumModal.activate(menuItem.uiFeature.displayName)
        return
      }

      if (!note) {
        return
      }

      if (note.locked) {
        application.alerts.alert(STRING_EDIT_LOCKED_ATTEMPT).catch(console.error)
        return
      }

      if (menuItem.uiFeature.noteType === NoteType.Super) {
        if (note.text.length === 0) {
          handleConversionCompletion(menuItem)
          return
        }

        if (note.noteType === NoteType.Super) {
          return
        }

        setPendingConversionItem(menuItem)
        setDisableClickOutside?.(true)
        return
      }

      if (note.noteType === NoteType.Super && note.text.length > 0) {
        setPendingConversionItem(menuItem)
        setDisableClickOutside?.(true)
        return
      }

      let shouldMakeSelection = true

      if (menuItem.uiFeature) {
        const changeRequiresAlert = application.componentManager.doesEditorChangeRequireAlert(
          currentFeature,
          menuItem.uiFeature,
        )

        if (changeRequiresAlert) {
          shouldMakeSelection = await application.componentManager.showEditorChangeAlert()
        }
      }

      if (shouldMakeSelection) {
        selectComponent(menuItem.uiFeature, note).catch(console.error)
      }

      closeMenu()

      if (onSelect) {
        onSelect(menuItem.uiFeature)
      }
    },
    [
      note,
      closeMenu,
      onSelect,
      premiumModal,
      application.alerts,
      application.componentManager,
      setDisableClickOutside,
      handleConversionCompletion,
      currentFeature,
      selectComponent,
    ],
  )

  const recommendSuper =
    !note ||
    (note.noteType &&
      [NoteType.Plain, NoteType.Markdown, NoteType.RichText, NoteType.Task, NoteType.Code, NoteType.Unknown].includes(
        note.noteType,
      ))

  const closeSuperNoteImporter = () => {
    setPendingConversionItem(null)
    setDisableClickOutside?.(false)
  }
  const closeSuperNoteConverter = () => {
    setPendingConversionItem(null)
    setDisableClickOutside?.(false)
  }

  const managePlugins = useCallback(() => {
    application.openPreferences('plugins')
  }, [application])

  return (
    <>
      <Menu className="pb-1 pt-0.5" a11yLabel="Change note type menu">
        <MenuSection>
          <div className="flex items-center justify-between py-3 pr-4 md:pb-1 md:pt-0">
            <div className="px-3">
              <h2 className="text-base font-bold">Choose a note type</h2>
              {unableToFindEditor && (
                <p className="mr-2 pt-1 text-xs text-warning">
                  Unable to find system editor for this note. Select Manage Plugins to reinstall this editor.
                </p>
              )}
            </div>
            <button className="cursor-pointer whitespace-nowrap text-right text-xs text-info" onClick={managePlugins}>
              Manage Plugins
            </button>
          </div>
        </MenuSection>

        {groups
          .filter((group) => group.items && group.items.length)
          .map((group) => {
            const groupId = getGroupId(group)

            return (
              <MenuSection key={groupId}>
                {group.items.map((menuItem) => {
                  const onClickEditorItem = () => {
                    handleMenuSelection(menuItem).catch(console.error)
                  }

                  return (
                    <MenuRadioButtonItem
                      key={menuItem.uiFeature.uniqueIdentifier.value}
                      onClick={onClickEditorItem}
                      className={'flex-row-reversed py-2'}
                      checked={isSelected(menuItem)}
                      info={menuItem.uiFeature.description}
                    >
                      <div className="flex flex-grow items-center justify-between">
                        <div className={`flex items-center ${group.featured ? 'font-bold' : ''}`}>
                          {group.icon && <Icon type={group.icon} className={`mr-2 ${group.iconClassName}`} />}
                          {menuItem.uiFeature.displayName}
                          {menuItem.isLabs && (
                            <Pill className="px-1.5 py-0.5" style="success">
                              Labs
                            </Pill>
                          )}
                          {menuItem.uiFeature.featureIdentifier === NativeFeatureIdentifier.TYPES.SuperEditor &&
                            !isSelected(menuItem) &&
                            recommendSuper && (
                              <Pill className="px-1.5 py-0.5 text-[0.5625rem]" style="info">
                                Recommended
                              </Pill>
                            )}
                        </div>
                      </div>
                    </MenuRadioButtonItem>
                  )
                })}
              </MenuSection>
            )
          })}

        <MenuSection>
          <MenuRadioButtonItem
            onClick={() => {
              selectCanvas().catch(console.error)
            }}
            className={'flex-row-reversed py-2'}
            checked={isCanvasSelected}
            info={'An infinite board for arranging cards and connecting them with edges.'}
          >
            <div className="flex flex-grow items-center justify-between">
              <div className="flex items-center">
                <Icon type="editor" className="mr-2 text-neutral" />
                Canvas
                <Pill className="px-1.5 py-0.5" style="success">
                  Labs
                </Pill>
              </div>
            </div>
          </MenuRadioButtonItem>
          <MenuRadioButtonItem
            onClick={() => {
              selectBase().catch(console.error)
            }}
            className={'flex-row-reversed py-2'}
            checked={isBaseSelected}
            info={'A database/table view over your notes with columns, filters, and sorting.'}
          >
            <div className="flex flex-grow items-center justify-between">
              <div className="flex items-center">
                <Icon type="hashtag" className="mr-2 text-neutral" />
                Base
                <Pill className="px-1.5 py-0.5" style="success">
                  Labs
                </Pill>
              </div>
            </div>
          </MenuRadioButtonItem>
        </MenuSection>
      </Menu>
      <ModalOverlay isOpen={showSuperNoteImporter} close={closeSuperNoteImporter}>
        {note && (
          <SuperNoteImporter
            note={note}
            application={application}
            onComplete={handleConversionCompletion}
            closeDialog={closeSuperNoteImporter}
          />
        )}
      </ModalOverlay>
      <ModalOverlay
        isOpen={showSuperNoteConverter}
        close={closeSuperNoteConverter}
        className="md:h-full md:max-h-[90%]"
      >
        {note && pendingConversionItem && (
          <SuperNoteConverter
            note={note}
            convertTo={pendingConversionItem}
            closeDialog={closeSuperNoteConverter}
            onComplete={handleConversionCompletion}
          />
        )}
      </ModalOverlay>
    </>
  )
}

export default ChangeEditorMenu
