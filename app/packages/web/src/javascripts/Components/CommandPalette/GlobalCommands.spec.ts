jest.mock('@/Achievements', () => ({
  achievements: [],
  METRICS: {},
}))

jest.mock('../Constellation/constellationWindow', () => ({
  openOrFocusConstellationWindow: jest.fn(),
}))

jest.mock('@/Diary/diaryService', () => ({
  openOrCreateDiaryEntry: jest.fn(),
}))

import { GLOBAL_COMMANDS } from './GlobalCommands'
import { AppPaneId } from '../Panes/AppPaneMetadata'

describe('GLOBAL_COMMANDS — a single Files entry', () => {
  // Commands whose title names Files as the destination. Keyword matching is
  // deliberately not used here: 'profile' on the account command contains 'file'.
  const filesCommands = GLOBAL_COMMANDS.filter((command) => /\bfiles\b/i.test(command.title))

  it('exposes exactly one Files command', () => {
    expect(filesCommands.map((command) => command.id)).toEqual(['global-open-files'])
  })

  it('no longer exposes the smart-view "Go to files" duplicate', () => {
    expect(GLOBAL_COMMANDS.find((command) => command.id === 'global-go-files')).toBeUndefined()
  })

  it('routes the surviving Files command to the Files tab, not the smart view', () => {
    const openPaneTab = jest.fn()
    const selectFilesView = jest.fn()
    const application = {
      paneController: { openPaneTab },
      navigationController: { selectFilesView },
    }

    const command = GLOBAL_COMMANDS.find((entry) => entry.id === 'global-open-files')
    expect(command).toBeDefined()

    command?.run(application as never)

    expect(openPaneTab).toHaveBeenCalledWith(AppPaneId.Files)
    expect(selectFilesView).not.toHaveBeenCalled()
  })

  it('keeps the removed command’s search terms on the surviving entry', () => {
    const command = GLOBAL_COMMANDS.find((entry) => entry.id === 'global-open-files')

    expect(command?.keywords).toEqual(expect.arrayContaining(['navigate', 'attachments']))
  })
})
