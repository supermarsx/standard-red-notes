import { ItemManagerInterface, SNFolder, SNTag } from '@standardnotes/snjs'
import { action, makeAutoObservable, observableRef } from 'mobx'

export class TagsCountsState {
  public counts: { [uuid: string]: number } = {}
  public folderCounts: { [uuid: string]: number } = {}

  public constructor(private items: ItemManagerInterface) {
    makeAutoObservable(this, {
      counts: observableRef,
      folderCounts: observableRef,
      update: action,
      updateFolders: action,
    })
  }

  public update(tags: SNTag[]) {
    const newCounts: { [uuid: string]: number } = Object.assign({}, this.counts)

    tags.forEach((tag) => {
      newCounts[tag.uuid] = this.items.countableNotesForTag(tag)
    })

    this.counts = newCounts
  }

  public updateFolders(folders: SNFolder[]): void {
    const newCounts = { ...this.folderCounts }
    let changed = false
    for (const folder of folders) {
      const count = this.items.countableNotesForFolder(folder, false)
      changed ||= newCounts[folder.uuid] !== count
      newCounts[folder.uuid] = count
    }
    if (changed) {
      this.folderCounts = newCounts
    }
  }
}
