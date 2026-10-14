import type { SNFolder, SNTag } from '@standardnotes/snjs'
import { NavigationController } from './NavigationController'

describe('navigation context menu ownership', () => {
  it('replaces a topic menu with a folder menu and then returns to a single topic menu', () => {
    const controller = Object.create(NavigationController.prototype) as NavigationController
    const topic = { uuid: 'topic' } as SNTag
    const folder = { uuid: 'folder' } as SNFolder

    controller.setContextMenuTag(topic, 'tags')
    controller.setContextMenuOpen(true)
    expect(controller.contextMenuTag).toBe(topic)

    controller.setContextMenuOpen(false)
    controller.setContextMenuFolder(folder)
    controller.setContextMenuOpen(true)
    expect(controller.contextMenuOpen).toBe(true)
    expect(controller.contextMenuFolder).toBe(folder)
    expect(controller.contextMenuTag).toBeUndefined()
    expect(controller.contextMenuTagSection).toBe('folders')

    controller.setContextMenuTag(topic, 'tags')
    expect(controller.contextMenuFolder).toBeUndefined()
    expect(controller.contextMenuTag).toBe(topic)
    expect(controller.contextMenuTagSection).toBe('tags')
  })
})
