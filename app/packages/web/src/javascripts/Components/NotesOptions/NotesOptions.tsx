import Icon from '@/Components/Icon/Icon'
import { observer } from 'mobx-react-lite'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { NoteType, Platform } from '@standardnotes/snjs'
import {
  CHANGE_EDITOR_WIDTH_COMMAND,
  OPEN_NOTE_HISTORY_COMMAND,
  PIN_NOTE_COMMAND,
  SHOW_HIDDEN_OPTIONS_KEYBOARD_COMMAND,
  STAR_NOTE_COMMAND,
} from '@standardnotes/ui-services'
import ChangeEditorOption from './ChangeEditorOption'
import AddTagOption from './AddTagOption'
import MoveToFolderOption from './MoveToFolderOption'
import { NotesOptionsProps } from './NotesOptionsProps'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { createNoteExport } from '@/Utils/NoteExportUtils'
import ProtectedUnauthorizedLabel from '../ProtectedItemOverlay/ProtectedUnauthorizedLabel'
import { MenuItemIconSize } from '@/Constants/TailwindClassNames'
import { KeyboardShortcutIndicator } from '../KeyboardShortcutIndicator/KeyboardShortcutIndicator'
import { NoteAttributes } from './NoteAttributes'
import { SpellcheckOptions } from './SpellcheckOptions'
import { NoteAppearanceOptions } from './NoteAppearanceOptions'
import { NoteSizeWarning } from './NoteSizeWarning'
import { iconClass } from './ClassNames'
import SuperNoteOptions from './SuperNoteOptions'
import SpreadsheetNoteOptions from './SpreadsheetNoteOptions'
import MenuSwitchButtonItem from '../Menu/MenuSwitchButtonItem'
import MenuItem from '../Menu/MenuItem'
import { useApplication } from '../ApplicationProvider'
import { MutuallyExclusiveMediaQueryBreakpoints } from '@/Hooks/useMediaQuery'
import AddToVaultMenuOption from '../Vaults/AddToVaultMenuOption'
import MenuSection from '../Menu/MenuSection'
import { shareBlobOnMobile } from '@/NativeMobileWeb/ShareBlobOnMobile'
import { ToastType, addToast } from '@standardnotes/toast'
import ShareLinkModal from './ShareLinkModal'
import NarrationModal from './NarrationModal'
import AudioRecorderModal from '@/Components/AudioRecorder/AudioRecorderModal'
import SplitNoteModal from './SplitNoteModal'
import SuggestTagsModal from './SuggestTagsModal'
import AutoOrganizeModal from './AutoOrganizeModal'
import PublishToGitHubModal from './PublishToGitHubModal'
import SetReminderModal from '@/Reminders/SetReminderModal'
import { noteHasReminder } from '@/Reminders/reminders'
import { BOOKMARK_SPOT_COMMAND } from '@/Bookmarks/bookmarkCommand'
import { noteIsTemplate } from '@/Templates/templates'
import { getSelectionAIAvailability } from '@/Assistant/selectionActions'
import { downloadNoteImagesAsZip } from '@/Utils/NoteImagesUtils'

const iconSize = MenuItemIconSize
const iconClassDanger = `text-danger mr-2 ${iconSize}`
const iconClassWarning = `text-warning mr-2 ${iconSize}`
const iconClassSuccess = `text-success mr-2 ${iconSize}`

const NotesOptions = ({ notes, closeMenu }: NotesOptionsProps) => {
  const application = useApplication()
  const notesController = application.notesController

  const [altKeyDown, setAltKeyDown] = useState(false)
  const [shareLinkOpen, setShareLinkOpen] = useState(false)
  const [narrationOpen, setNarrationOpen] = useState(false)
  const [audioRecorderOpen, setAudioRecorderOpen] = useState(false)
  const [reminderOpen, setReminderOpen] = useState(false)
  const [splitOpen, setSplitOpen] = useState(false)
  const [suggestTagsOpen, setSuggestTagsOpen] = useState(false)
  const [publishGitHubOpen, setPublishGitHubOpen] = useState(false)
  const [organizeNoteOpen, setOrganizeNoteOpen] = useState(false)
  const [organizeAllOpen, setOrganizeAllOpen] = useState(false)
  const { toggleAppPane } = useResponsiveAppPane()

  const {
    trashed,
    notTrashed,
    pinned,
    unpinned,
    starred,
    archived,
    unarchived,
    locked,
    protect,
    hidePreviews,
    localOnly,
  } = notesController.getNotesInfo(notes)

  const editorForNote = useMemo(
    () => (notes[0] ? application.componentManager.editorForNote(notes[0]) : undefined),
    [application.componentManager, notes],
  )

  const aiAvailability = useMemo(() => getSelectionAIAvailability(application), [application])

  useEffect(() => {
    const removeAltKeyObserver = application.keyboardService.addCommandHandler({
      command: SHOW_HIDDEN_OPTIONS_KEYBOARD_COMMAND,
      onKeyDown: () => {
        setAltKeyDown(true)
      },
      onKeyUp: () => {
        setAltKeyDown(false)
      },
    })

    return () => {
      removeAltKeyObserver()
    }
  }, [application])

  const shareSelectedItems = useCallback(() => {
    createNoteExport(application, notes)
      .then((result) => {
        if (!result) {
          return
        }

        const { blob, fileName } = result

        shareBlobOnMobile(application.mobileDevice, application.isNativeMobileWeb(), blob, fileName).catch(
          console.error,
        )
      })
      .catch(console.error)
  }, [application, notes])

  // Standard Red Notes: download every image attached to a single note (uploaded
  // image files referenced by the note, plus best-effort remote image URLs) as a
  // single ZIP named after the note. Empty/partial-failure handling lives in the
  // helper, which surfaces toasts.
  const downloadImages = useCallback(() => {
    const note = notes[0]
    if (!note) {
      return
    }
    downloadNoteImagesAsZip(application, note).catch((error) => {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to download images.' })
    })
  }, [application, notes])

  // Standard Red Notes: print the active note. The actual layout (hide app
  // chrome, show only the note title + editor content, force legible light
  // colors) is handled by the `@media print` rules in the global stylesheet.
  // Here we only need to dismiss the floating options menu first so it doesn't
  // capture focus / appear in the print, then defer window.print() to the next
  // frame so the menu has fully unmounted.
  const printNote = useCallback(() => {
    closeMenu()
    requestAnimationFrame(() => {
      window.print()
    })
  }, [closeMenu])

  const closeMenuAndToggleNotesList = useCallback(() => {
    const isMobileScreen = matchMedia(MutuallyExclusiveMediaQueryBreakpoints.sm).matches
    if (isMobileScreen) {
      toggleAppPane(AppPaneId.Items)
    }
    closeMenu()
  }, [closeMenu, toggleAppPane])

  const duplicateSelectedNotes = useCallback(async () => {
    await notesController.duplicateSelectedNotes()
    closeMenuAndToggleNotesList()
  }, [closeMenuAndToggleNotesList, notesController])

  const openRevisionHistoryModal = useCallback(() => {
    application.historyModalController.openModal(notesController.firstSelectedNote)
  }, [application.historyModalController, notesController.firstSelectedNote])

  const historyShortcut = useMemo(
    () => application.keyboardService.keyboardShortcutForCommand(OPEN_NOTE_HISTORY_COMMAND),
    [application],
  )

  const pinShortcut = useMemo(
    () => application.keyboardService.keyboardShortcutForCommand(PIN_NOTE_COMMAND),
    [application],
  )

  const starShortcut = useMemo(
    () => application.keyboardService.keyboardShortcutForCommand(STAR_NOTE_COMMAND),
    [application],
  )

  const toggleLineWidthModal = useCallback(() => {
    application.keyboardService.triggerCommand(CHANGE_EDITOR_WIDTH_COMMAND)
  }, [application.keyboardService])
  const editorWidthShortcut = useMemo(
    () => application.keyboardService.keyboardShortcutForCommand(CHANGE_EDITOR_WIDTH_COMMAND),
    [application],
  )

  const unauthorized = notes.some((note) => !application.isAuthorizedToRenderItem(note))
  if (unauthorized) {
    return <ProtectedUnauthorizedLabel />
  }

  const areSomeNotesInSharedVault = notes.some((note) => application.vaults.getItemVault(note)?.isSharedVaultListing())
  const areSomeNotesInReadonlySharedVault = notes.some((note) => {
    const vault = application.vaults.getItemVault(note)
    return vault?.isSharedVaultListing() && application.vaultUsers.isCurrentUserReadonlyVaultMember(vault)
  })
  const hasAdminPermissionForAllSharedNotes = notes.every((note) => {
    const vault = application.vaults.getItemVault(note)
    if (!vault?.isSharedVaultListing()) {
      return true
    }
    return application.vaultUsers.isCurrentUserSharedVaultAdmin(vault)
  })

  if (notes.length === 0) {
    return null
  }

  return (
    <>
      {notes.length === 1 && (
        <NarrationModal
          application={application}
          note={notes[0]}
          isOpen={narrationOpen}
          close={() => setNarrationOpen(false)}
        />
      )}
      {notes.length === 1 && (
        <AudioRecorderModal
          application={application}
          filesController={application.filesController}
          note={notes[0]}
          isOpen={audioRecorderOpen}
          close={() => setAudioRecorderOpen(false)}
        />
      )}
      {notes.length === 1 && (
        <ShareLinkModal
          application={application}
          note={notes[0]}
          isOpen={shareLinkOpen}
          close={() => setShareLinkOpen(false)}
        />
      )}
      {notes.length === 1 && (
        <SetReminderModal
          application={application}
          notesController={notesController}
          note={notes[0]}
          isOpen={reminderOpen}
          close={() => setReminderOpen(false)}
        />
      )}
      {notes.length === 1 && (
        <SplitNoteModal
          application={application}
          note={notes[0]}
          isOpen={splitOpen}
          close={() => setSplitOpen(false)}
        />
      )}
      {notes.length === 1 && (
        <SuggestTagsModal
          application={application}
          note={notes[0]}
          isOpen={suggestTagsOpen}
          close={() => setSuggestTagsOpen(false)}
        />
      )}
      {notes.length === 1 && (
        <PublishToGitHubModal
          application={application}
          note={notes[0]}
          isOpen={publishGitHubOpen}
          close={() => setPublishGitHubOpen(false)}
        />
      )}
      {notes.length === 1 && (
        <AutoOrganizeModal
          application={application}
          note={notes[0]}
          mode="current-note"
          isOpen={organizeNoteOpen}
          close={() => setOrganizeNoteOpen(false)}
        />
      )}
      <AutoOrganizeModal
        application={application}
        note={notes[0]}
        mode="all-notes"
        isOpen={organizeAllOpen}
        close={() => setOrganizeAllOpen(false)}
      />
      {notes.length === 1 && (
        <>
          <MenuSection>
            <MenuItem onClick={openRevisionHistoryModal}>
              <Icon type="history" className={iconClass} />
              Note history
              {historyShortcut && <KeyboardShortcutIndicator className="ml-auto" shortcut={historyShortcut} />}
            </MenuItem>
          </MenuSection>
          <MenuSection>
            <MenuItem onClick={toggleLineWidthModal} disabled={areSomeNotesInReadonlySharedVault}>
              <Icon type="line-width" className={iconClass} />
              Editor width
              {editorWidthShortcut && <KeyboardShortcutIndicator className="ml-auto" shortcut={editorWidthShortcut} />}
            </MenuItem>
          </MenuSection>
        </>
      )}
      <MenuSection>
        <MenuSwitchButtonItem
          checked={locked}
          onChange={(locked) => {
            notesController.setLockSelectedNotes(locked)
          }}
          disabled={areSomeNotesInReadonlySharedVault}
        >
          <Icon type="pencil-off" className={iconClass} />
          Prevent editing
        </MenuSwitchButtonItem>
        <MenuSwitchButtonItem
          checked={!hidePreviews}
          onChange={(hidePreviews) => {
            notesController.setHideSelectedNotePreviews(!hidePreviews)
          }}
          disabled={areSomeNotesInReadonlySharedVault}
        >
          <Icon type="rich-text" className={iconClass} />
          Show preview
        </MenuSwitchButtonItem>
        <MenuSwitchButtonItem
          checked={protect}
          onChange={(protect) => {
            notesController.setProtectSelectedNotes(protect).catch(console.error)
          }}
          disabled={areSomeNotesInReadonlySharedVault}
        >
          <Icon type="lock" className={iconClass} />
          Password protect
        </MenuSwitchButtonItem>
        <MenuSwitchButtonItem
          checked={localOnly}
          onChange={(localOnly) => {
            notesController.setLocalOnlySelectedNotes(localOnly)
          }}
          disabled={areSomeNotesInReadonlySharedVault}
        >
          <Icon type="cloud-off" className={iconClass} />
          <div className="flex flex-col">
            <div>Keep local only — don&apos;t sync to the server</div>
            <div className="mt-1 text-xs text-passive-0">
              Stays on this device. Won&apos;t be backed up or appear on your other devices.
            </div>
          </div>
        </MenuSwitchButtonItem>
      </MenuSection>
      {notes.length === 1 && (
        <MenuSection>
          <ChangeEditorOption
            iconClassName={iconClass}
            application={application}
            note={notes[0]}
            disabled={areSomeNotesInReadonlySharedVault}
          />
        </MenuSection>
      )}

      <MenuSection className={notes.length > 1 ? 'md:!mb-2' : ''}>
        {application.featuresController.isVaultsEnabled() && (
          <AddToVaultMenuOption
            iconClassName={iconClass}
            items={notes}
            disabled={!hasAdminPermissionForAllSharedNotes}
          />
        )}

        {application.navigationController.tagsCount > 0 && (
          <AddTagOption
            iconClassName={iconClass}
            navigationController={application.navigationController}
            selectedItems={notes}
            linkingController={application.linkingController}
            disabled={areSomeNotesInReadonlySharedVault}
          />
        )}
        {notes.length === 1 && (
          <MoveToFolderOption
            iconClassName={iconClass}
            navigationController={application.navigationController}
            note={notes[0]}
            disabled={areSomeNotesInReadonlySharedVault}
          />
        )}
        <MenuItem
          onClick={() => {
            notesController.setStarSelectedNotes(!starred)
          }}
          disabled={areSomeNotesInReadonlySharedVault}
        >
          <Icon type="star" className={iconClass} />
          {starred ? 'Unstar' : 'Star'}
          {starShortcut && <KeyboardShortcutIndicator className="ml-auto" shortcut={starShortcut} />}
        </MenuItem>

        {unpinned && (
          <MenuItem
            onClick={() => {
              notesController.setPinSelectedNotes(true)
            }}
            disabled={areSomeNotesInReadonlySharedVault}
          >
            <Icon type="pin" className={iconClass} />
            Pin to top
            {pinShortcut && <KeyboardShortcutIndicator className="ml-auto" shortcut={pinShortcut} />}
          </MenuItem>
        )}
        {pinned && (
          <MenuItem
            onClick={() => {
              notesController.setPinSelectedNotes(false)
            }}
            disabled={areSomeNotesInReadonlySharedVault}
          >
            <Icon type="unpin" className={iconClass} />
            Unpin
            {pinShortcut && <KeyboardShortcutIndicator className="ml-auto" shortcut={pinShortcut} />}
          </MenuItem>
        )}
        <MenuItem onClick={notesController.exportSelectedNotes}>
          <Icon type="download" className={iconClass} />
          Export
        </MenuItem>
        {notes.length === 1 && (
          <MenuItem onClick={printNote}>
            <Icon type="file-doc" className={iconClass} />
            Print note
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem onClick={downloadImages}>
            <Icon type="image" className={iconClass} />
            Download images (.zip)
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem
            onClick={() => {
              setShareLinkOpen(true)
            }}
          >
            <Icon type="link" className={iconClass} />
            Create share link
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem
            onClick={() => {
              // Account-gated sharing reuses the existing trusted-contact /
              // shared-vault E2E invite flow, which is vault-scoped. We route the
              // user to the Vaults preferences pane where they can move the note
              // into a shared vault and invite a contact who has an account.
              application.openPreferences('vaults')
            }}
          >
            <Icon type="user" className={iconClass} />
            Invite by account…
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem
            onClick={() => {
              setPublishGitHubOpen(true)
            }}
            disabled={areSomeNotesInReadonlySharedVault}
          >
            <Icon type="upload" className={iconClass} />
            Publish to GitHub…
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem
            onClick={() => {
              setNarrationOpen(true)
            }}
          >
            <Icon type="file-music" className={iconClass} />
            Narrate / Listen
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem
            onClick={() => {
              setAudioRecorderOpen(true)
            }}
            disabled={areSomeNotesInReadonlySharedVault}
          >
            <Icon type="file-music" className={iconClass} />
            Record audio / Transcribe…
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem
            onClick={() => {
              setReminderOpen(true)
            }}
            disabled={areSomeNotesInReadonlySharedVault}
          >
            <Icon type="clock" className={iconClass} />
            {noteHasReminder(notes[0]) ? 'Edit reminder…' : 'Set reminder…'}
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem
            onClick={() => {
              // Standard Red Notes: route through the shared bookmark command so
              // this menu item uses the SAME spot-capture flow as Ctrl/Cmd+M.
              application.keyboardService.triggerCommand(BOOKMARK_SPOT_COMMAND)
            }}
            disabled={areSomeNotesInReadonlySharedVault}
          >
            <Icon type="pin" className={iconClass} />
            Bookmark this spot
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem
            onClick={() => {
              // Standard Red Notes: flag/unflag this note as a reusable template
              // (stored in the note's appData). Templates are listed in the
              // Templates view, from which fresh notes can be spun up.
              void notesController.setNoteIsTemplate(notes[0], !noteIsTemplate(notes[0]))
              closeMenu()
            }}
            disabled={areSomeNotesInReadonlySharedVault}
          >
            <Icon type="copy" className={iconClass} />
            {noteIsTemplate(notes[0]) ? 'Remove from templates' : 'Save as template'}
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem
            onClick={() => {
              setSplitOpen(true)
            }}
            disabled={areSomeNotesInReadonlySharedVault}
          >
            <Icon type="menu-arrow-down" className={iconClass} />
            Split note…
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem
            onClick={() => {
              setSuggestTagsOpen(true)
            }}
            disabled={areSomeNotesInReadonlySharedVault || !aiAvailability.available}
          >
            <Icon type="hashtag" className={iconClass} />
            Suggest topics (AI)
          </MenuItem>
        )}
        {notes.length === 1 && (
          <MenuItem
            onClick={() => {
              setOrganizeNoteOpen(true)
            }}
            disabled={areSomeNotesInReadonlySharedVault || !aiAvailability.available}
          >
            <Icon type="folder" className={iconClass} />
            Auto-organize note (AI)
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            setOrganizeAllOpen(true)
          }}
          disabled={!aiAvailability.available}
        >
          <Icon type="folder" className={iconClass} />
          Auto-organize all notes (AI)
        </MenuItem>
        {application.platform === Platform.Android && (
          <MenuItem onClick={shareSelectedItems}>
            <Icon type="share" className={iconClass} />
            Share
          </MenuItem>
        )}
        <MenuItem onClick={duplicateSelectedNotes} disabled={areSomeNotesInReadonlySharedVault}>
          <Icon type="copy" className={iconClass} />
          Duplicate
        </MenuItem>
        {unarchived && (
          <MenuItem
            onClick={async () => {
              await notesController.setArchiveSelectedNotes(true).catch(console.error)
              closeMenuAndToggleNotesList()
            }}
            disabled={areSomeNotesInReadonlySharedVault}
          >
            <Icon type="archive" className={iconClassWarning} />
            <span className="text-warning">Archive</span>
          </MenuItem>
        )}
        {archived && (
          <MenuItem
            onClick={async () => {
              await notesController.setArchiveSelectedNotes(false).catch(console.error)
              closeMenuAndToggleNotesList()
            }}
            disabled={areSomeNotesInReadonlySharedVault}
          >
            <Icon type="unarchive" className={iconClassWarning} />
            <span className="text-warning">Unarchive</span>
          </MenuItem>
        )}
        {notTrashed &&
          (altKeyDown ? (
            <MenuItem
              disabled={areSomeNotesInReadonlySharedVault}
              onClick={async () => {
                await notesController.deleteNotesPermanently()
                closeMenuAndToggleNotesList()
              }}
            >
              <Icon type="close" className="mr-2 text-danger" />
              <span className="text-danger">Delete permanently</span>
            </MenuItem>
          ) : (
            <MenuItem
              onClick={async () => {
                await notesController.setTrashSelectedNotes(true)
                closeMenuAndToggleNotesList()
              }}
              disabled={areSomeNotesInReadonlySharedVault}
            >
              <Icon type="trash" className={iconClassDanger} />
              <span className="text-danger">Move to trash</span>
            </MenuItem>
          ))}
        {trashed && (
          <>
            <MenuItem
              onClick={async () => {
                await notesController.setTrashSelectedNotes(false)
                closeMenuAndToggleNotesList()
              }}
              disabled={areSomeNotesInReadonlySharedVault}
            >
              <Icon type="restore" className={iconClassSuccess} />
              <span className="text-success">Restore</span>
            </MenuItem>
            <MenuItem
              disabled={areSomeNotesInReadonlySharedVault}
              onClick={async () => {
                await notesController.deleteNotesPermanently()
                closeMenuAndToggleNotesList()
              }}
            >
              <Icon type="close" className="mr-2 text-danger" />
              <span className="text-danger">Delete permanently</span>
            </MenuItem>
            <MenuItem
              onClick={async () => {
                await notesController.emptyTrash()
                closeMenuAndToggleNotesList()
              }}
              disabled={areSomeNotesInReadonlySharedVault}
            >
              <div className="flex items-start">
                <Icon type="trash-sweep" className="mr-2 text-danger" />
                <div className="flex-row">
                  <div className="text-danger">Empty Trash</div>
                  <div className="text-xs">{notesController.trashedNotesCount} notes in Trash</div>
                </div>
              </div>
            </MenuItem>
          </>
        )}
      </MenuSection>

      {notes.length === 1 && (
        <>
          {notes[0].noteType === NoteType.Super && <SuperNoteOptions closeMenu={closeMenu} />}

          {notes[0].noteType === NoteType.Spreadsheet && (
            <SpreadsheetNoteOptions note={notes[0]} closeMenu={closeMenu} />
          )}

          {editorForNote && (
            <MenuSection>
              <SpellcheckOptions
                editorForNote={editorForNote}
                notesController={notesController}
                note={notes[0]}
                disabled={areSomeNotesInReadonlySharedVault}
              />
            </MenuSection>
          )}

          <MenuSection>
            <NoteAppearanceOptions
              notesController={notesController}
              note={notes[0]}
              disabled={areSomeNotesInReadonlySharedVault}
            />
          </MenuSection>

          <NoteAttributes className="mb-2" application={application} note={notes[0]} />

          <NoteSizeWarning note={notes[0]} />
        </>
      )}
    </>
  )
}

export default observer(NotesOptions)
