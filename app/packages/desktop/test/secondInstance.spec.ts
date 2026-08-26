import test from 'ava'
import { describeSecondInstance } from '../app/javascripts/Shared/SecondInstance'

test('a second launch of the same build is reported as routine', (t) => {
  const message = describeSecondInstance('3.110.192', { version: '3.110.192' })
  t.true(message.includes('3.110.192'))
  t.false(message.includes('NOT RUNNING'))
})

test('a second launch of a different build says the new build is not what you are looking at', (t) => {
  const message = describeSecondInstance('3.110.192', { version: '3.111.0' })
  t.true(message.includes('3.111.0'))
  t.true(message.includes('3.110.192'))
  t.true(message.includes('THE NEWLY LAUNCHED BUILD IS NOT RUNNING'))
})

test('a payload without a usable version still names the running instance', (t) => {
  for (const payload of [undefined, null, {}, { version: 7 }, 'nonsense']) {
    const message = describeSecondInstance('3.110.192', payload)
    t.true(message.includes('did not report its version'))
    t.true(message.includes('3.110.192'))
  }
})
