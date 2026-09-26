/**
 * @jest-environment jsdom
 */

// @ts-expect-error CSS is not defined in jsdom env
global.CSS = {}

import { WebApplication } from '@/Application/WebApplication'
import { NotesController } from '@/Controllers/NotesController/NotesController'
import {
  ApplicationEvent,
  ProposedSecondsToDeferUILevelSessionExpirationDuringActiveInteraction,
  SNNote,
  NoteType,
  PayloadEmitSource,
  VaultServiceInterface,
} from '@standardnotes/snjs'
import NoteView from './NoteView'
import { NoteViewController } from './Controller/NoteViewController'

describe('NoteView', () => {
  let noteViewController: NoteViewController
  let application: WebApplication

  let notesController: NotesController
  let vaults: VaultServiceInterface

  const createNoteView = () =>
    new NoteView({
      controller: noteViewController,
      application,
    })

  beforeEach(() => {
    jest.useFakeTimers()

    noteViewController = {} as jest.Mocked<NoteViewController>

    notesController = {} as jest.Mocked<NotesController>
    notesController.setShowProtectedWarning = jest.fn()
    notesController.getSpellcheckStateForNote = jest.fn()
    notesController.getEditorWidthForNote = jest.fn()

    vaults = {} as jest.Mocked<VaultServiceInterface>
    vaults.getItemVault = jest.fn().mockReturnValue(undefined)

    application = {
      notesController,
      noteViewController,
      vaults,
      items: {
        isTemplateItem: jest.fn().mockReturnValue(false),
        findItem: jest.fn((uuid: string) => {
          return noteViewController.item?.uuid === uuid ? noteViewController.item : undefined
        }),
      },
    } as unknown as jest.Mocked<WebApplication>

    application.hasProtectionSources = jest.fn().mockReturnValue(true)
    application.authorizeNoteAccess = jest.fn()
    application.addWebEventObserver = jest.fn()
    application.isAuthorizedToRenderItem = WebApplication.prototype.isAuthorizedToRenderItem.bind(application)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('note is protected', () => {
    it("should hide the note if at the time of the session expiration the note wasn't edited for longer than the allowed idle time", async () => {
      const secondsElapsedSinceLastEdit = ProposedSecondsToDeferUILevelSessionExpirationDuringActiveInteraction + 5

      noteViewController.item = {
        protected: true,
        userModifiedDate: new Date(Date.now() - secondsElapsedSinceLastEdit * 1000),
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>

      await createNoteView().onAppEvent(ApplicationEvent.UnprotectedSessionExpired)

      expect(notesController.setShowProtectedWarning).toHaveBeenCalledWith(true)
    })

    it('should postpone the note hiding by correct time if the time passed after its last modification is less than the allowed idle time', async () => {
      const secondsElapsedSinceLastEdit = ProposedSecondsToDeferUILevelSessionExpirationDuringActiveInteraction - 3

      noteViewController.item = {
        protected: true,
        userModifiedDate: new Date(Date.now() - secondsElapsedSinceLastEdit * 1000),
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>

      await createNoteView().onAppEvent(ApplicationEvent.UnprotectedSessionExpired)

      const secondsAfterWhichTheNoteShouldHide =
        ProposedSecondsToDeferUILevelSessionExpirationDuringActiveInteraction - secondsElapsedSinceLastEdit

      jest.advanceTimersByTime((secondsAfterWhichTheNoteShouldHide - 1) * 1000)

      expect(notesController.setShowProtectedWarning).not.toHaveBeenCalled()

      jest.advanceTimersByTime(1 * 1000)

      expect(notesController.setShowProtectedWarning).toHaveBeenCalledWith(true)
    })

    it('should postpone the note hiding by correct time if the user continued editing it even after the protection session has expired', async () => {
      const secondsElapsedSinceLastModification = 3

      noteViewController.item = {
        protected: true,
        userModifiedDate: new Date(Date.now() - secondsElapsedSinceLastModification * 1000),
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>

      await createNoteView().onAppEvent(ApplicationEvent.UnprotectedSessionExpired)

      let secondsAfterWhichTheNoteShouldHide =
        ProposedSecondsToDeferUILevelSessionExpirationDuringActiveInteraction - secondsElapsedSinceLastModification
      jest.advanceTimersByTime((secondsAfterWhichTheNoteShouldHide - 1) * 1000)

      noteViewController.item = {
        protected: true,
        userModifiedDate: new Date(),
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>

      secondsAfterWhichTheNoteShouldHide = ProposedSecondsToDeferUILevelSessionExpirationDuringActiveInteraction
      jest.advanceTimersByTime((secondsAfterWhichTheNoteShouldHide - 1) * 1000)
      expect(notesController.setShowProtectedWarning).not.toHaveBeenCalled()

      jest.advanceTimersByTime(1 * 1000)
      expect(notesController.setShowProtectedWarning).toHaveBeenCalledWith(true)
    })
  })

  describe('note is unprotected', () => {
    it('should not call any hiding logic', async () => {
      noteViewController.item = {
        protected: false,
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>

      await createNoteView().onAppEvent(ApplicationEvent.UnprotectedSessionExpired)

      expect(notesController.setShowProtectedWarning).not.toHaveBeenCalled()
    })
  })

  describe('stale vault authorization', () => {
    it('renders only the protected overlay when a retained vault association no longer resolves', () => {
      noteViewController.dealloced = false
      noteViewController.item = {
        uuid: 'revoked-vault-note',
        text: 'must not render retained vault plaintext',
        protected: false,
        locked: false,
        key_system_identifier: 'revoked-vault-key-system',
        userModifiedDate: new Date(),
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>
      Object.defineProperty(application, 'vaultLocks', {
        configurable: true,
        value: { isVaultLocked: jest.fn() } as unknown as WebApplication['vaultLocks'],
      })
      jest.mocked(application.items.findItem).mockReturnValue(undefined)
      jest.mocked(vaults.getItemVault).mockReturnValue(undefined)

      const rendered = createNoteView().render() as { props: { itemType: string } }

      expect(rendered).not.toBeNull()
      expect(rendered.props.itemType).toBe('note')
      expect(vaults.getItemVault).toHaveBeenCalledWith(noteViewController.item)
    })

    it('continues authorizing an ordinary item when no vault association exists', () => {
      const ordinaryNote = {
        uuid: 'ordinary-note',
        protected: false,
        key_system_identifier: undefined,
      } as SNNote
      jest.mocked(application.items.findItem).mockReturnValue(ordinaryNote)

      expect(application.isAuthorizedToRenderItem(ordinaryNote)).toBe(true)
      expect(vaults.getItemVault).not.toHaveBeenCalled()
    })

    it('denies a removed ordinary item and authorizes it only after authoritative reinsertion', () => {
      const ordinaryNote = {
        uuid: 'removed-ordinary-note',
        protected: false,
      } as SNNote
      jest.mocked(application.items.findItem).mockReturnValue(undefined)

      expect(application.isAuthorizedToRenderItem(ordinaryNote)).toBe(false)

      jest.mocked(application.items.findItem).mockReturnValue(ordinaryNote)
      expect(application.isAuthorizedToRenderItem(ordinaryNote)).toBe(true)
    })

    it('uses authoritative protection and vault fields instead of a stale caller object', () => {
      const staleNote = {
        uuid: 'stale-note',
        protected: false,
        key_system_identifier: undefined,
      } as SNNote
      const latestProtectedNote = {
        ...staleNote,
        protected: true,
      } as SNNote
      jest.mocked(application.items.findItem).mockReturnValue(latestProtectedNote)
      Object.defineProperty(application, 'protections', {
        configurable: true,
        value: { hasUnprotectedAccessSession: jest.fn().mockReturnValue(false) },
      })

      expect(application.isAuthorizedToRenderItem(staleNote)).toBe(false)

      const latestOrphanedVaultNote = {
        ...staleNote,
        protected: false,
        key_system_identifier: 'missing-vault-key-system',
      } as SNNote
      jest.mocked(application.items.findItem).mockReturnValue(latestOrphanedVaultNote)
      expect(application.isAuthorizedToRenderItem(staleNote)).toBe(false)
    })
  })

  describe('editors', () => {
    it('accepts an assistant-originated title as authoritative for the open tab', () => {
      noteViewController.item = {
        uuid: 'note-1',
        title: 'Before',
        locked: false,
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>
      const view = createNoteView()
      view.setState = jest.fn()

      view.onNoteInnerChange(
        { ...noteViewController.item, title: 'After' } as jest.Mocked<SNNote>,
        PayloadEmitSource.AssistantChanged,
      )

      expect(view.setState).toHaveBeenCalledWith({ editorTitle: 'After' })
    })

    it('should reload editor if noteType changes', async () => {
      noteViewController.item = {
        noteType: NoteType.Code,
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>

      const view = createNoteView()
      view.reloadEditorComponent = jest.fn()
      view.setState = jest.fn()

      const changedItem = {
        noteType: NoteType.Plain,
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>
      view.onNoteInnerChange(changedItem, PayloadEmitSource.LocalChanged)

      expect(view.reloadEditorComponent).toHaveBeenCalled()
    })

    it('should reload editor if editorIdentifier changes', async () => {
      noteViewController.item = {
        editorIdentifier: 'foo',
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>

      const view = createNoteView()
      view.reloadEditorComponent = jest.fn()
      view.setState = jest.fn()

      const changedItem = {
        editorIdentifier: 'bar',
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>
      view.onNoteInnerChange(changedItem, PayloadEmitSource.LocalChanged)

      expect(view.reloadEditorComponent).toHaveBeenCalled()
    })
  })

  describe('dismissProtectedWarning', () => {
    beforeEach(() => {
      noteViewController.item = {
        protected: false,
        getAppDomainValue: jest.fn(),
      } as unknown as jest.Mocked<SNNote>
    })

    describe('the note has protection sources', () => {
      it('should reveal note contents if the authorization has been passed', async () => {
        application.authorizeNoteAccess = jest.fn().mockReturnValue(true)

        const noteView = new NoteView({
          controller: noteViewController,
          application,
        })

        await noteView.authorizeAndDismissProtectedWarning()

        expect(notesController.setShowProtectedWarning).toHaveBeenCalledWith(false)
      })

      it('should not reveal note contents if the authorization has not been passed', async () => {
        application.authorizeNoteAccess = jest.fn().mockReturnValue(false)

        const noteView = new NoteView({
          controller: noteViewController,
          application,
        })

        await noteView.authorizeAndDismissProtectedWarning()

        expect(notesController.setShowProtectedWarning).not.toHaveBeenCalled()
      })
    })

    describe('the note does not have protection sources', () => {
      it('should reveal note contents', async () => {
        application.hasProtectionSources = jest.fn().mockReturnValue(false)

        const noteView = new NoteView({
          controller: noteViewController,
          application,
        })

        await noteView.authorizeAndDismissProtectedWarning()

        expect(notesController.setShowProtectedWarning).toHaveBeenCalledWith(false)
      })
    })
  })
  /**
   * Standard Red Notes (t99): a sync that RETRIEVES the note used to overwrite the title input
   * with the server's copy unconditionally, discarding whatever the user had typed since. That is
   * an independent mechanism from the editor-handover bug — it needs no lost focus at all, just a
   * round-trip landing mid-keystroke — and it produces the same user-visible symptom: the typed
   * title vanishes.
   *
   * Adopting a retrieved title is correct behaviour (it is how an edit from another device reaches
   * the field), so it is narrowed rather than removed: deferred ONLY while this note's title input
   * holds focus AND its value has diverged from the item.
   */
  describe('retrieved title vs. the title the user is typing', () => {
    const noteUuid = 'note-title-1'

    /** The real input carries `data-srn-note-uuid`; focus is scoped by it, not by the shared id. */
    const focusTitleInputFor = (uuid: string) => {
      const input = document.createElement('input')
      input.setAttribute('data-srn-note-uuid', uuid)
      document.body.appendChild(input)
      input.focus()
      return input
    }

    /**
     * Enter the field and type, exactly as the component sees it: onFocus arms the "untouched"
     * state and onTitleChange records the uncommitted local change. Driving the flag through the
     * real handlers rather than setting it directly keeps the test honest about the wiring.
     */
    const typeIntoTitle = (view: NoteView, input: HTMLInputElement, value: string) => {
      view.onTitleFocus({ target: input } as unknown as Parameters<typeof view.onTitleFocus>[0])
      input.value = value
      view.onTitleChange({ currentTarget: input } as unknown as Parameters<typeof view.onTitleChange>[0])
    }

    const hasDeferredTitle = (view: NoteView) =>
      (view as unknown as { pendingRetrievedTitle: string | undefined }).pendingRetrievedTitle !== undefined

    const noteWithTitle = (title: string) =>
      ({
        uuid: noteUuid,
        title,
        locked: false,
        getAppDomainValue: jest.fn(),
      }) as unknown as jest.Mocked<SNNote>

    /**
     * `setState` is replaced with a recorder that also updates `state`, because the deferral and
     * its reconciliation both READ `state.editorTitle` — a pure `jest.fn()` would leave the view
     * frozen at its initial state and the divergence check could never be false.
     */
    const viewWithLiveState = (editorTitle: string) => {
      const view = createNoteView()
      const calls: Partial<{ editorTitle: string }>[] = []
      ;(view as unknown as { state: { editorTitle: string } }).state = {
        ...view.state,
        editorTitle,
      }
      view.setState = jest.fn((partial: unknown) => {
        const update = partial as Partial<{ editorTitle: string }>
        calls.push(update)
        ;(view as unknown as { state: Record<string, unknown> }).state = {
          ...(view as unknown as { state: Record<string, unknown> }).state,
          ...update,
        }
      }) as unknown as typeof view.setState
      return { view, titleUpdates: () => calls.filter((call) => 'editorTitle' in call) }
    }

    beforeEach(() => {
      document.body.innerHTML = ''
      noteViewController.item = noteWithTitle('Local typed title')
      ;(noteViewController as unknown as { hasPendingLocalSave: boolean }).hasPendingLocalSave = false
      // resetMocks is global, so the save stub has to be re-established per test.
      noteViewController.saveAndAwaitLocalPropagation = jest.fn().mockResolvedValue(undefined)
    })

    it('does not overwrite the title the user is actively typing', () => {
      const { view, titleUpdates } = viewWithLiveState('Local')
      const input = focusTitleInputFor(noteUuid)
      typeIntoTitle(view, input, 'Local typed title')

      // A round-trip lands with the server's older copy while the field is focused and dirty.
      view.onNoteInnerChange(noteWithTitle('Server copy'), PayloadEmitSource.RemoteRetrieved)

      // The server's value was never applied to the input, and the typed text survives.
      expect(titleUpdates()).not.toContainEqual({ editorTitle: 'Server copy' })
      expect(view.state.editorTitle).toBe('Local typed title')
    })

    it('still adopts a retrieved title when the field is not focused', () => {
      const { view } = viewWithLiveState('Local typed title')
      // Nothing focused: a genuine edit from another device must land.

      view.onNoteInnerChange(noteWithTitle('Edited on another device'), PayloadEmitSource.RemoteRetrieved)

      expect(view.state.editorTitle).toBe('Edited on another device')
    })

    it('still adopts a retrieved title when the field is focused but clean', () => {
      const { view } = viewWithLiveState('Same as item')
      const input = focusTitleInputFor(noteUuid)
      // Entered the field but typed nothing: there is nothing of the user's to lose.
      view.onTitleFocus({ target: input } as unknown as Parameters<typeof view.onTitleFocus>[0])

      view.onNoteInnerChange(noteWithTitle('Edited on another device'), PayloadEmitSource.RemoteRetrieved)

      expect(view.state.editorTitle).toBe('Edited on another device')
    })

    it('ignores focus that belongs to another tile’s title input', () => {
      const { view } = viewWithLiveState('Local')
      const input = focusTitleInputFor(noteUuid)
      typeIntoTitle(view, input, 'Local typed title')
      // The tiled editor renders one input per open note, all sharing ElementIds.NoteTitleEditor.
      // Focus now sits on a SIBLING tile's title input, so this view must not treat it as its own.
      focusTitleInputFor('a-different-note')

      view.onNoteInnerChange(noteWithTitle('Edited on another device'), PayloadEmitSource.RemoteRetrieved)

      expect(view.state.editorTitle).toBe('Edited on another device')
    })

    it('adopts the deferred title once the field is blurred', () => {
      const { view } = viewWithLiveState('Local')
      const input = focusTitleInputFor(noteUuid)
      typeIntoTitle(view, input, 'Local typed title')

      view.onNoteInnerChange(noteWithTitle('Server copy'), PayloadEmitSource.RemoteRetrieved)
      expect(view.state.editorTitle).toBe('Local typed title')

      // The user leaves the field; their own save has already landed, so the item is authoritative.
      noteViewController.item = noteWithTitle('Server copy')
      input.blur()
      view.onTitleBlur()

      expect(view.state.editorTitle).toBe('Server copy')
    })

    it('waits for the user’s own debounced save before reconciling, then reconciles', () => {
      /**
       * The editor save is debounced (~700ms) BEFORE the item is mutated, so immediately after a
       * keystroke `item.title` still holds the previous value. Reconciling then would display that
       * stale value and discard what the user just typed -- so the deferral is held until the
       * pending save clears, and the save's own local propagation brings us back here.
       */
      const { view } = viewWithLiveState('Local')
      const input = focusTitleInputFor(noteUuid)
      typeIntoTitle(view, input, 'Local typed title')

      view.onNoteInnerChange(noteWithTitle('Server copy'), PayloadEmitSource.RemoteRetrieved)

      ;(noteViewController as unknown as { hasPendingLocalSave: boolean }).hasPendingLocalSave = true
      input.blur()
      view.onTitleBlur()

      // Still the user's text: the item is not authoritative yet.
      expect(view.state.editorTitle).toBe('Local typed title')

      // The debounced save lands, mutating the item and emitting a local change.
      ;(noteViewController as unknown as { hasPendingLocalSave: boolean }).hasPendingLocalSave = false
      noteViewController.item = noteWithTitle('Local typed title')
      view.onNoteInnerChange(noteWithTitle('Local typed title'), PayloadEmitSource.LocalChanged)

      // Reconciled, and the user's edit won -- correct for a title they were actively editing.
      expect(view.state.editorTitle).toBe('Local typed title')
      expect(hasDeferredTitle(view)).toBe(false)
    })

    it('does not leave the input diverged from the item after a deferral', () => {
      const { view } = viewWithLiveState('Local')
      const input = focusTitleInputFor(noteUuid)
      typeIntoTitle(view, input, 'Local typed title')

      view.onNoteInnerChange(noteWithTitle('Server copy'), PayloadEmitSource.RemoteRetrieved)
      expect(hasDeferredTitle(view)).toBe(true)

      // Focus moves away and a later emission arrives (any source).
      document.body.innerHTML = ''
      noteViewController.item = noteWithTitle('Server copy')
      view.onNoteInnerChange(noteWithTitle('Server copy'), PayloadEmitSource.LocalChanged)

      expect(view.state.editorTitle).toBe('Server copy')
      expect(hasDeferredTitle(view)).toBe(false)
    })
  })
})
