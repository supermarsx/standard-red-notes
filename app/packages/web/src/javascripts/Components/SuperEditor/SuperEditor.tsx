import { WebApplication } from '@/Application/WebApplication'
import {
  ApplicationEvent,
  isPayloadSourceRetrieved,
  NativeFeatureIdentifier,
  FeatureStatus,
  EditorLineHeightValues,
  WebAppEvent,
  LocalPrefKey,
} from '@standardnotes/snjs'
import { CSSProperties, FocusEvent, FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BlocksEditor } from './BlocksEditor'
import { CollaborationConfig } from './Collaboration/CollaborationPlugin'
import { collaboratorColor } from './Collaboration/collaboratorColor'
import { BlocksEditorComposer } from './BlocksEditorComposer'
import { ItemSelectionPlugin } from './Plugins/ItemSelectionPlugin/ItemSelectionPlugin'
import { FileNode } from './Plugins/EncryptedFilePlugin/Nodes/FileNode'
import FilePlugin from './Plugins/EncryptedFilePlugin/FilePlugin'
import { ErrorBoundary } from '@/Utils/ErrorBoundary'
import { LinkingController } from '@/Controllers/LinkingController'
import LinkingControllerProvider from '../../Controllers/LinkingControllerProvider'
import { BubbleNode } from './Plugins/ItemBubblePlugin/Nodes/BubbleNode'
import ItemBubblePlugin from './Plugins/ItemBubblePlugin/ItemBubblePlugin'
import { NodeObserverPlugin } from './Plugins/NodeObserverPlugin/NodeObserverPlugin'
import { FilesController } from '@/Controllers/FilesController'
import FilesControllerProvider from '@/Controllers/FilesControllerProvider'
import { NoteViewController } from '../NoteView/Controller/NoteViewController'
import {
  ChangeContentCallbackPlugin,
  ChangeEditorFunction,
} from './Plugins/ChangeContentCallback/ChangeContentCallback'
import { SUPER_SHOW_MARKDOWN_PREVIEW, getPrimaryModifier } from '@standardnotes/ui-services'
import { SuperNoteMarkdownPreview } from './SuperNoteMarkdownPreview'
import GetMarkdownPlugin, { GetMarkdownPluginInterface } from './Plugins/GetMarkdownPlugin/GetMarkdownPlugin'
import { useResponsiveEditorFontSize } from '@/Utils/getPlaintextFontSize'
import ReadonlyPlugin from './Plugins/ReadonlyPlugin/ReadonlyPlugin'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import AutoFocusPlugin from './Plugins/AutoFocusPlugin'
import { useLocalPreference } from '@/Hooks/usePreference'
import BlockPickerMenuPlugin from './Plugins/BlockPickerPlugin/BlockPickerPlugin'
import { EditorEventSource } from '@/Types/EditorEventSource'
import { ElementIds } from '@/Constants/ElementIDs'
import { NoteFromSelectionPlugin } from './Plugins/NoteFromSelectionPlugin'

export const SuperNotePreviewCharLimit = 160

type Props = {
  application: WebApplication
  controller: NoteViewController
  linkingController: LinkingController
  filesController: FilesController
  spellcheck: boolean
  readonly?: boolean
  onFocus?: (event: FocusEvent) => void
  onBlur?: (event: FocusEvent) => void
  customBackgroundColor?: string
  customTextColor?: string
}

export const SuperEditor: FunctionComponent<Props> = ({
  application,
  linkingController,
  filesController,
  spellcheck,
  controller,
  readonly,
  onFocus,
  onBlur,
  customBackgroundColor,
  customTextColor,
}) => {
  const note = useRef(controller.item)
  const changeEditorFunction = useRef<ChangeEditorFunction | undefined>(undefined)
  const ignoreNextChange = useRef(false)
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false)
  const getMarkdownPlugin = useRef<GetMarkdownPluginInterface | null>(null)
  const [featureStatus, setFeatureStatus] = useState<FeatureStatus>(FeatureStatus.Entitled)

  const reloadFeatureStatus = useCallback(() => {
    setFeatureStatus(
      application.features.getFeatureStatus(
        NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.SuperEditor).getValue(),
        {
          inContextOfItem: note.current,
        },
      ),
    )
  }, [application.features])

  useEffect(() => {
    reloadFeatureStatus()
  }, [reloadFeatureStatus])

  useEffect(() => {
    return application.addEventObserver(async (event) => {
      switch (event) {
        case ApplicationEvent.FeaturesAvailabilityChanged:
        case ApplicationEvent.UserRolesChanged:
        case ApplicationEvent.LocalDataLoaded:
          reloadFeatureStatus()
          break
      }
    })
  }, [application, reloadFeatureStatus])

  const keyboardService = application.keyboardService
  const isEditorReadonly = note.current.locked || Boolean(readonly) || featureStatus !== FeatureStatus.Entitled

  useEffect(() => {
    return application.commands.addWithShortcut(
      SUPER_SHOW_MARKDOWN_PREVIEW,
      'Super notes',
      'Show markdown preview for current note',
      () => setShowMarkdownPreview((s) => !s),
      'markdown',
    )
  }, [application.commands])

  useEffect(() => {
    const platform = application.platform
    const primaryModifier = getPrimaryModifier(application.platform)

    return keyboardService.registerExternalKeyboardShortcutHelpItems([
      {
        key: 'b',
        modifiers: [primaryModifier],
        description: 'Bold',
        category: 'Formatting',
        platform: platform,
      },
      {
        key: 'i',
        modifiers: [primaryModifier],
        description: 'Italic',
        category: 'Formatting',
        platform: platform,
      },
      {
        key: 'u',
        modifiers: [primaryModifier],
        description: 'Underline',
        category: 'Formatting',
        platform: platform,
      },
      {
        key: 'k',
        modifiers: [primaryModifier],
        description: 'Link',
        category: 'Formatting',
        platform: platform,
      },
    ])
  }, [application.platform, keyboardService])

  const closeMarkdownPreview = useCallback(() => {
    setShowMarkdownPreview(false)
  }, [])

  // Live co-editing is OPT-IN: only for notes in a shared vault, and only when
  // explicitly enabled via window.enableSuperCollaboration. Default off, so solo
  // notes and the normal editing path are completely unaffected. The room secret
  // is derived from the shared vault's key-system identifier (all members hold
  // it); for E2E against an untrusted relay, swap in the raw vault key.
  const collaboration = useMemo<CollaborationConfig | undefined>(() => {
    if (!(window as { enableSuperCollaboration?: boolean }).enableSuperCollaboration) {
      return undefined
    }
    const vault = application.vaults.getItemVault(note.current)
    if (!vault || !vault.isSharedVaultListing()) {
      return undefined
    }
    const user = application.sessions.getUser()
    const email = user?.email ?? 'Collaborator'
    // Color the local user's cursor by their OWN account id so it stays stable
    // across notes and matches their presence dot in the sidebar.
    return {
      room: note.current.uuid,
      sharedSecret: String(vault.systemIdentifier),
      username: email,
      cursorColor: collaboratorColor(user?.uuid ?? email),
      userUuid: user?.uuid,
      shouldBootstrap: true,
      initialEditorState: note.current.text && note.current.text.length > 0 ? note.current.text : undefined,
    }
  }, [application])

  useEffect(() => {
    return application.actions.addPayloadRequestHandler((uuid) => {
      if (uuid === note.current.uuid) {
        const basePayload = note.current.payload.ejected()
        return {
          ...basePayload,
          content: {
            ...basePayload.content,
            text: getMarkdownPlugin.current?.getMarkdown() ?? basePayload.content.text,
          },
        }
      }
    })
  }, [application])

  const handleChange = useCallback(
    async (value: string, preview: string, bypassDebounce?: boolean) => {
      if (ignoreNextChange.current === true) {
        ignoreNextChange.current = false
        return
      }
      if (isEditorReadonly) {
        return
      }

      void controller.saveAndAwaitLocalPropagation({
        text: value,
        isUserModified: true,
        // Standard Red Notes (last-edit-loss fix): a lifecycle flush
        // (note-switch/blur/unmount/logout/unload) forwards bypassDebounce=true so the
        // edit is dirtied + persisted immediately instead of waiting out the 700ms sync
        // debounce, which a close/logout/clearAllData could otherwise pre-empt.
        bypassDebouncer: bypassDebounce,
        previews: {
          previewPlain: preview,
          previewHtml: undefined,
        },
      })
    },
    [controller, isEditorReadonly],
  )

  /**
   * Standard Red Notes (last-edit-loss fix): register the editor's debounce control
   * (flush + hasPending) with the controller so lifecycle code (ItemGroupController
   * note-switch, ConfirmSignoutModal, beforeunload) can force a pending edit through
   * the save path before this editor/controller is torn down. Stable identity so the
   * BlocksEditor effect registers once.
   */
  const registerDebounceControl = useCallback(
    (control: { flush: () => void; hasPending: () => boolean }) => {
      return controller.registerEditorFlush(control.flush, control.hasPending)
    },
    [controller],
  )

  const handleBubbleRemove = useCallback(
    (itemUuid: string) => {
      const item = application.items.findItem(itemUuid)
      if (item) {
        // TODO: We should only unlink item if all link bubbles to that item have been removed from the note
        linkingController.unlinkItemFromSelectedItem(item).catch(console.error)
      }
    },
    [linkingController, application],
  )

  useEffect(() => {
    const disposer = controller.addNoteInnerValueChangeObserver((updatedNote, source) => {
      if (updatedNote.uuid !== note.current.uuid) {
        throw Error('Editor received changes for non-current note')
      }

      if (isPayloadSourceRetrieved(source)) {
        ignoreNextChange.current = true
        changeEditorFunction.current?.(updatedNote.text)
      }

      note.current = updatedNote
    })

    return disposer
  }, [controller, controller.item.uuid])

  const [lineHeight] = useLocalPreference(LocalPrefKey.EditorLineHeight)
  const [fontSize] = useLocalPreference(LocalPrefKey.EditorFontSize)
  const responsiveFontSize = useResponsiveEditorFontSize(fontSize, false)

  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const invalidURLClickFix = (event: MouseEvent) => {
      if ((event.target as HTMLElement).tagName !== 'A') {
        return
      }
      const isAbsoluteLink = (event.target as HTMLAnchorElement).getAttribute('href')?.startsWith('http')
      if (!isAbsoluteLink) {
        event.preventDefault()
      }
    }

    const element = ref.current

    if (element) {
      element.addEventListener('click', invalidURLClickFix)
    }

    return () => {
      if (element) {
        element.removeEventListener('click', invalidURLClickFix)
      }
    }
  }, [])

  const handleFocus = useCallback(
    (event: FocusEvent) => {
      application.notifyWebEvent(WebAppEvent.EditorDidFocus, { eventSource: EditorEventSource.UserInteraction })
      onFocus?.(event)
    },
    [application, onFocus],
  )

  return (
    <div
      id={ElementIds.SuperEditor}
      className="font-editor relative flex h-full w-full flex-col"
      style={
        {
          '--line-height': EditorLineHeightValues[lineHeight],
          '--font-size': responsiveFontSize,
          // Standard Red Notes: per-note custom appearance. Omitted (undefined)
          // when the note has no override so the theme controls the surface.
          backgroundColor: customBackgroundColor,
          color: customTextColor,
        } as CSSProperties
      }
      ref={ref}
    >
      <ErrorBoundary>
        <LinkingControllerProvider controller={linkingController}>
          <FilesControllerProvider controller={filesController}>
            <BlocksEditorComposer
              readonly={isEditorReadonly}
              initialValue={note.current.text}
              collaborating={!!collaboration}
            >
              <BlocksEditor
                onChange={handleChange}
                className="blocks-editor h-full resize-none"
                previewLength={SuperNotePreviewCharLimit}
                spellcheck={spellcheck}
                readonly={isEditorReadonly}
                onFocus={handleFocus}
                onBlur={onBlur}
                application={application}
                collaboration={collaboration}
                registerDebounceControl={registerDebounceControl}
              >
                <ItemSelectionPlugin currentNote={note.current} />
                <FilePlugin currentNote={note.current} />
                <ItemBubblePlugin />
                <GetMarkdownPlugin ref={getMarkdownPlugin} />
                <ChangeContentCallbackPlugin
                  providerCallback={(callback) => (changeEditorFunction.current = callback)}
                />
                <NodeObserverPlugin nodeType={BubbleNode} onRemove={handleBubbleRemove} />
                <NodeObserverPlugin nodeType={FileNode} onRemove={handleBubbleRemove} />
                {readonly === undefined && (
                  <ReadonlyPlugin note={note.current} forceReadonly={featureStatus !== FeatureStatus.Entitled} />
                )}
                <AutoFocusPlugin isEnabled={controller.isTemplateNote} />
                <BlockPickerMenuPlugin />
                <NoteFromSelectionPlugin currentNote={note.current} />
              </BlocksEditor>
            </BlocksEditorComposer>
          </FilesControllerProvider>
        </LinkingControllerProvider>
        <ModalOverlay isOpen={showMarkdownPreview} close={closeMarkdownPreview}>
          <SuperNoteMarkdownPreview note={note.current} closeDialog={closeMarkdownPreview} />
        </ModalOverlay>
      </ErrorBoundary>
    </div>
  )
}
