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
})
