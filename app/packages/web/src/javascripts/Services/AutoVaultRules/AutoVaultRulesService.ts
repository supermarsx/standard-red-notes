import {
  ApplicationEvent,
  ContentType,
  FolderContentType,
  PrefKey,
  SNNote,
  SNTag,
  SNFolder,
  VaultListingInterface,
  isDeletedItem,
} from '@standardnotes/snjs'
import { makeObservable, observableShallow, runInAction } from 'mobx'
import type { WebApplication } from '@/Application/WebApplication'
import { NoteViewController } from '@/Components/NoteView/Controller/NoteViewController'
import { CollaborationSaverRegistry } from '@/Components/SuperEditor/Collaboration/CollaborationSaverElection'
import { autoVaultDestination, matchAutoVaultRules, normalizeAutoVaultRules, AutoVaultRule } from './autoVaultRules'

export type AutoVaultProblem = {
  noteUuid?: string
  sourceUuid?: string
  reason: 'conflict' | 'locked' | 'permission' | 'linked-items' | 'saving' | 'unavailable' | 'move-failed'
}

export class AutoVaultRulesService {
  rules: AutoVaultRule[] = []
  problems: AutoVaultProblem[] = []
  private disposed = false
  private running?: Promise<void>
  private rerun = false
  private accountGeneration = 0
  private scheduled?: ReturnType<typeof setTimeout>
  private disposers: (() => void)[] = []

  constructor(private application: WebApplication) {
    makeObservable(this, { rules: observableShallow, problems: observableShallow })
    this.disposers.push(
      application.items.addObserver(
        [ContentType.TYPES.Note, ContentType.TYPES.Tag, FolderContentType, ContentType.TYPES.UserPrefs],
        () => this.schedule(),
      ),
    )
    this.disposers.push(
      application.addEventObserver(async (event) => {
        if (event === ApplicationEvent.SignedIn || event === ApplicationEvent.SignedOut) {
          this.accountGeneration++
          runInAction(() => {
            this.rules = []
            this.problems = []
          })
          if (event === ApplicationEvent.SignedIn) {
            this.schedule()
          }
          return
        }
        if (
          [
            ApplicationEvent.LocalDataLoaded,
            ApplicationEvent.CompletedFullSync,
            ApplicationEvent.ExitedOutOfSync,
          ].includes(event)
        ) {
          this.schedule()
        }
      }),
    )
    const timer = setInterval(() => {
      if (this.rules.length && this.problems.length) {
        this.schedule()
      }
    }, 10_000)
    this.disposers.push(() => clearInterval(timer))
    this.reloadRules()
  }

  private reloadRules() {
    const rules = normalizeAutoVaultRules(this.application.getPreference(PrefKey.AutoVaultRules, []))
    runInAction(() => {
      this.rules = rules
    })
  }

  previewRule(
    kind: AutoVaultRule['kind'],
    sourceUuid: string,
    vaultUuid: string,
  ): { notes: number; conflicts: number } {
    const rule = { kind, sourceUuid, vaultUuid }
    const rules = [
      ...this.rules.filter((candidate) => candidate.kind !== kind || candidate.sourceUuid !== sourceUuid),
      rule,
    ]
    const tags = this.application.items.getItems<SNTag>(ContentType.TYPES.Tag)
    const folders = this.application.items.getItems<SNFolder>(FolderContentType)
    const notes = this.application.items
      .getItems<SNNote>(ContentType.TYPES.Note)
      .filter(
        (note) =>
          !note.trashed && !isDeletedItem(note) && matchAutoVaultRules(note.uuid, [rule], tags, folders).length > 0,
      )
    return {
      notes: notes.length,
      conflicts: notes.filter(
        (note) => autoVaultDestination(matchAutoVaultRules(note.uuid, rules, tags, folders)).conflict,
      ).length,
    }
  }

  async setRule(kind: AutoVaultRule['kind'], sourceUuid: string, vaultUuid?: string): Promise<void> {
    const accountUuid = this.application.sessions.getUser()?.uuid
    const generation = this.accountGeneration
    if (!accountUuid) {
      throw new Error('Sign in to configure automatic vault rules.')
    }
    const rules = normalizeAutoVaultRules(this.application.getPreference(PrefKey.AutoVaultRules, [])).filter(
      (rule) => rule.kind !== kind || rule.sourceUuid !== sourceUuid,
    )
    if (vaultUuid) {
      rules.push({ kind, sourceUuid, vaultUuid })
    }
    await this.application.setPreference(PrefKey.AutoVaultRules, normalizeAutoVaultRules(rules))
    if (!this.isCurrentAccount(accountUuid, generation)) {
      return
    }
    this.reloadRules()
    await this.applyRules()
  }

  private schedule() {
    if (this.disposed || this.scheduled) {
      return
    }
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined
      const accountUuid = this.application.sessions.getUser()?.uuid
      const generation = this.accountGeneration
      void this.applyRules().catch(() => {
        if (this.isCurrentAccount(accountUuid, generation)) {
          runInAction(() => {
            this.problems = [{ reason: 'move-failed' }]
          })
        }
      })
    }, 150)
  }

  applyRules(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    if (this.running) {
      this.rerun = true
      return this.running
    }
    this.running = this.run().finally(() => {
      this.running = undefined
      if (this.rerun) {
        this.rerun = false
        this.schedule()
      }
    })
    return this.running
  }

  private async run(): Promise<void> {
    const accountUuid = this.application.sessions.getUser()?.uuid
    const generation = this.accountGeneration
    if (!accountUuid) {
      return
    }
    this.reloadRules()
    const signature = JSON.stringify(this.rules)
    const current = () =>
      this.isCurrentAccount(accountUuid, generation) &&
      JSON.stringify(normalizeAutoVaultRules(this.application.getPreference(PrefKey.AutoVaultRules, []))) === signature
    const tags = this.application.items.getItems<SNTag>(ContentType.TYPES.Tag)
    const folders = this.application.items.getItems<SNFolder>(FolderContentType)
    const notes = this.application.items
      .getItems<SNNote>(ContentType.TYPES.Note)
      .filter((note) => !note.trashed && !isDeletedItem(note))
    const problems: AutoVaultProblem[] = []
    const matches = (note: SNNote) => matchAutoVaultRules(note.uuid, this.rules, tags, folders)
    const conflictingSources = new Set(
      notes.flatMap((note) => {
        return autoVaultDestination(matches(note)).conflict
          ? matches(note).map((rule) => `${rule.kind}:${rule.sourceUuid}`)
          : []
      }),
    )
    // A configured topic is part of this rule; unrelated linked tags/files are never moved automatically.
    for (const rule of this.rules) {
      if (!current()) {
        return
      }
      if (rule.kind !== 'tag' || conflictingSources.has(`${rule.kind}:${rule.sourceUuid}`)) {
        continue
      }
      let source = this.application.items.findItem<SNTag>(rule.sourceUuid)
      const vault = this.application.vaults.getVaults().find((candidate) => candidate.uuid === rule.vaultUuid)
      if (
        !source ||
        !vault ||
        !notes.some((note) => matches(note).some((match) => match.sourceUuid === rule.sourceUuid))
      ) {
        continue
      }
      if (this.atTarget(source, vault)) {
        continue
      }
      const reason = this.canMove(source, vault)
      if (reason) {
        problems.push({ sourceUuid: rule.sourceUuid, reason })
        continue
      }
      try {
        const relatedNotes = notes.filter((note) =>
          matches(note).some((match) => match.kind === rule.kind && match.sourceUuid === rule.sourceUuid),
        )
        if (relatedNotes.some((note) => !this.canWriteLiveNote(note.uuid))) {
          problems.push({ sourceUuid: rule.sourceUuid, reason: 'saving' })
          continue
        }
        for (const controller of this.application.itemControllerGroup.itemControllers) {
          if (
            controller instanceof NoteViewController &&
            relatedNotes.some((note) => note.uuid === controller.item.uuid)
          ) {
            await controller.flushAndAwaitPendingSaveStrict()
            if (!current()) {
              return
            }
          }
        }
        if (!current()) {
          return
        }
        source = this.application.items.findItem<SNTag>(rule.sourceUuid)
        if (!source || this.canMove(source, vault) || relatedNotes.some((note) => !this.canWriteLiveNote(note.uuid))) {
          problems.push({ sourceUuid: rule.sourceUuid, reason: 'saving' })
          continue
        }
        const result = await this.application.vaults.moveItemToVault(vault, source)
        if (!current()) {
          return
        }
        if (result.isFailed()) {
          problems.push({ sourceUuid: rule.sourceUuid, reason: 'linked-items' })
        }
      } catch {
        if (!current()) {
          return
        }
        problems.push({ sourceUuid: rule.sourceUuid, reason: 'move-failed' })
      }
    }
    for (const original of notes) {
      if (!current()) {
        return
      }
      let note = this.application.items.findItem<SNNote>(original.uuid)
      if (!note || note.trashed || isDeletedItem(note)) {
        continue
      }
      const destination = autoVaultDestination(matches(note))
      if (destination.conflict) {
        problems.push({ noteUuid: note.uuid, reason: 'conflict' })
        continue
      }
      if (!destination.vaultUuid) {
        continue
      }
      const vault = this.application.vaults.getVaults().find((candidate) => candidate.uuid === destination.vaultUuid)
      if (!vault) {
        problems.push({ noteUuid: note.uuid, reason: 'unavailable' })
        continue
      }
      if (this.atTarget(note, vault)) {
        continue
      }
      const reason = this.canMove(note, vault)
      if (reason) {
        problems.push({ noteUuid: note.uuid, reason })
        continue
      }
      const saver = CollaborationSaverRegistry.get(note.uuid)
      if (saver && (!saver.isSaver || saver.paused || !saver.saveFence)) {
        problems.push({ noteUuid: note.uuid, reason: 'saving' })
        continue
      }
      const linked = [
        ...this.application.items.getUnsortedTagsForItem(note),
        ...this.application.items.getItemLinkedFiles(note),
        ...this.application.items.getItemLinkedNotes(note),
      ]
      if (linked.some((item) => item.key_system_identifier !== vault.systemIdentifier)) {
        problems.push({ noteUuid: note.uuid, reason: 'linked-items' })
        continue
      }
      try {
        for (const controller of this.application.itemControllerGroup.itemControllers) {
          if (controller instanceof NoteViewController && controller.item.uuid === note.uuid) {
            await controller.flushAndAwaitPendingSaveStrict()
            if (!current()) {
              return
            }
          }
        }
        note = this.application.items.findItem<SNNote>(note.uuid)
        if (!note || note.trashed || isDeletedItem(note) || this.disposed) {
          continue
        }
        const latest = autoVaultDestination(
          matchAutoVaultRules(
            note.uuid,
            normalizeAutoVaultRules(this.application.getPreference(PrefKey.AutoVaultRules, [])),
            this.application.items.getItems<SNTag>(ContentType.TYPES.Tag),
            this.application.items.getItems<SNFolder>(FolderContentType),
          ),
        )
        if (latest.conflict || latest.vaultUuid !== vault.uuid) {
          continue
        }
        const currentSaver = CollaborationSaverRegistry.get(note.uuid)
        const currentReason = this.canMove(note, vault)
        if (
          currentReason ||
          (currentSaver && (!currentSaver.isSaver || currentSaver.paused || !currentSaver.saveFence))
        ) {
          problems.push({ noteUuid: note.uuid, reason: currentReason ?? 'saving' })
          continue
        }
        const result = await this.application.vaults.moveItemToVault(vault, note)
        if (!current()) {
          return
        }
        if (result.isFailed()) {
          problems.push({ noteUuid: note.uuid, reason: 'move-failed' })
        }
      } catch {
        if (!current()) {
          return
        }
        problems.push({ noteUuid: original.uuid, reason: 'move-failed' })
      }
    }
    if (current()) {
      runInAction(() => {
        this.problems = problems
      })
    }
  }

  private canMove(item: SNNote | SNTag, vault: VaultListingInterface): AutoVaultProblem['reason'] | undefined {
    const sourceVault = this.application.vaults.getItemVault(item)
    if (
      this.application.vaultLocks.isVaultLocked(vault) ||
      (sourceVault && this.application.vaultLocks.isVaultLocked(sourceVault))
    ) {
      return 'locked'
    }
    if (
      this.application.vaultUsers.isCurrentUserReadonlyVaultMember(vault) ||
      (sourceVault && this.application.vaultUsers.isCurrentUserReadonlyVaultMember(sourceVault))
    ) {
      return 'permission'
    }
    return undefined
  }

  private isCurrentAccount(accountUuid: string | undefined, generation: number): boolean {
    return (
      !this.disposed &&
      Boolean(accountUuid) &&
      this.accountGeneration === generation &&
      this.application.sessions.getUser()?.uuid === accountUuid
    )
  }

  private canWriteLiveNote(noteUuid: string): boolean {
    const saver = CollaborationSaverRegistry.get(noteUuid)
    return !saver || (saver.isSaver && !saver.paused && Boolean(saver.saveFence))
  }

  private atTarget(item: SNNote | SNTag, vault: VaultListingInterface): boolean {
    return (
      item.key_system_identifier === vault.systemIdentifier &&
      item.shared_vault_uuid === (vault.isSharedVaultListing() ? vault.sharing.sharedVaultUuid : undefined)
    )
  }

  deinit(): void {
    this.disposed = true
    if (this.scheduled) {
      clearTimeout(this.scheduled)
    }
    this.disposers.splice(0).forEach((dispose) => dispose())
    runInAction(() => {
      this.rules = []
      this.problems = []
    })
  }
}
