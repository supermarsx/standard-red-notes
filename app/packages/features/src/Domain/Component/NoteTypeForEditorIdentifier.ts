import { EditorFeatureDescription } from '../Feature/EditorFeatureDescription'
import { FindNativeFeature } from '../Feature/Features'
import { IframeComponentFeatureDescription } from '../Feature/IframeComponentFeatureDescription'
import { NoteType } from './NoteType'

// Kept separate from NoteType.ts so the NoteType enum has no dependency on
// Features (which depends back on NoteType via the editor lists) — that import
// formed a runtime circular dependency between NoteType <-> Features.
export function noteTypeForEditorIdentifier(identifier: string): NoteType {
  const feature = FindNativeFeature<EditorFeatureDescription | IframeComponentFeatureDescription>(identifier)
  if (feature && feature.note_type) {
    return feature.note_type
  }

  return NoteType.Unknown
}
