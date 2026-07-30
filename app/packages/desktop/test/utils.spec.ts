import test from 'ava'
import { CommandLineArgs } from '../app/javascripts/Shared/CommandLineArgs'
import { isTestLaunch, lowercaseDriveLetter } from '../app/javascripts/Main/Utils/Utils'

test("lowerCaseDriverLetter converts the drive letter of a given file's path to lower case", (t) => {
  t.is(lowercaseDriveLetter('/C:/Lansing'), '/c:/Lansing')
  t.is(lowercaseDriveLetter('/c:/Bone Rage'), '/c:/Bone Rage')
  t.is(lowercaseDriveLetter('/C:/Give/Us/the/Gold'), '/c:/Give/Us/the/Gold')
})

test('lowerCaseDriverLetter only changes a single drive letter', (t) => {
  t.is(lowercaseDriveLetter('C:/Hold Me In'), 'C:/Hold Me In')
  t.is(lowercaseDriveLetter('/Cd:/Egg Replacer'), '/Cd:/Egg Replacer')
  t.is(lowercaseDriveLetter('/C:radle of Rocks'), '/C:radle of Rocks')
})

test('test launch requires the explicit mode, flag, and a live IPC channel', (t) => {
  const completeLaunch = {
    argv: ['electron', 'app', CommandLineArgs.Testing],
    hasIpcChannel: true,
    testMode: '1',
  }

  t.true(isTestLaunch(completeLaunch))
  t.false(isTestLaunch({ ...completeLaunch, argv: ['electron', 'app'] }))
  t.false(isTestLaunch({ ...completeLaunch, hasIpcChannel: false }))
  t.false(isTestLaunch({ ...completeLaunch, testMode: undefined }))
})
