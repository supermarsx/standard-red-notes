import { CorpusEntry, ExpectedModel, ExpectedOverride } from '../__fixtures__/corpus'
import { EventModel, ModelTime, OccurrenceModel } from '../model/eventModel'

/** The text of a corpus entry as a server sends it: CRLF between lines and after the last. */
export const corpusText = (entry: CorpusEntry): string => `${entry.lines.join('\r\n')}\r\n`

const timeText = (time: ModelTime): string => {
  return time.kind === 'zoned' ? `zoned ${time.value} ${time.zone}` : `${time.kind} ${time.value}`
}

const occurrenceText = (occurrence: OccurrenceModel): Pick<ExpectedOverride, 'title' | 'start' | 'end' | 'status'> => {
  const text: Pick<ExpectedOverride, 'title' | 'start' | 'end' | 'status'> = {
    title: occurrence.title,
    start: timeText(occurrence.start),
  }
  if (occurrence.end) {
    text.end = timeText(occurrence.end)
  }
  if (occurrence.status !== '') {
    text.status = occurrence.status
  }
  return text
}

/**
 * A model in the short form the corpus states its expectations in: only what is
 * not empty, false or absent. Nothing is left out that a model can hold, so two
 * models with the same short form are the same model.
 */
export function shortForm(model: EventModel, zoneDefinitions: Record<string, string> = {}): ExpectedModel {
  const short: ExpectedModel = { uid: model.uid, ...occurrenceText(model) }
  if (model.description !== '') {
    short.description = model.description
  }
  if (model.location !== '') {
    short.location = model.location
  }
  if (model.rule !== '') {
    short.rule = model.rule
  }
  if (model.exdates.length > 0) {
    short.exdates = model.exdates
  }
  if (model.rdates.length > 0) {
    short.rdates = model.rdates
  }
  if (model.overrides.length > 0) {
    short.overrides = model.overrides.map((override) => {
      if (override.description !== '' || override.location !== '' || override.clipped !== '') {
        throw new Error('the short form has no place for the texts of a changed occurrence; extend it')
      }
      return { recurrenceId: override.recurrenceId, ...occurrenceText(override) }
    })
  }
  if (model.guests) {
    short.guests = true
  }
  if (model.alarm) {
    short.alarm = true
  }
  if (model.clipped !== '') {
    throw new Error('the short form has no place for a text that was cut; compare such a model in full')
  }
  const definitions = Object.keys(zoneDefinitions).sort()
  if (definitions.length > 0) {
    short.zoneDefinitions = definitions
  }
  return short
}
