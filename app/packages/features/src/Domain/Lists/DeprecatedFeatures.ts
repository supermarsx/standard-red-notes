import { AnyFeatureDescription } from '../Feature/AnyFeatureDescription'
import { EditorFeatureDescription } from '../Feature/EditorFeatureDescription'
import { IframeComponentFeatureDescription } from '../Feature/IframeComponentFeatureDescription'
import { ContentType, RoleName } from '@standardnotes/domain-core'
import { PermissionName } from '../Permission/PermissionName'
import { NativeFeatureIdentifier } from '../Feature/NativeFeatureIdentifier'
import { NoteType } from '../Component/NoteType'
import { FillIframeEditorDefaults } from './Utilities/FillEditorComponentDefaults'
import { ComponentAction } from '../Component/ComponentAction'
import { ComponentArea } from '../Component/ComponentArea'

export function GetDeprecatedFeatures(): AnyFeatureDescription[] {
  const bold: EditorFeatureDescription = FillIframeEditorDefaults({
    name: 'Alternative Rich Text',
    identifier: NativeFeatureIdentifier.TYPES.DeprecatedBoldEditor,
    note_type: NoteType.RichText,
    file_type: 'html',
    component_permissions: [
      {
        name: ComponentAction.StreamContextItem,
        content_types: [ContentType.TYPES.Note],
      },
      {
        name: ComponentAction.StreamItems,
        content_types: [
          ContentType.TYPES.FilesafeCredentials,
          ContentType.TYPES.FilesafeFileMetadata,
          ContentType.TYPES.FilesafeIntegration,
        ],
      },
    ],
    spellcheckControl: true,
    deprecated: true,
    permission_name: PermissionName.BoldEditor,
    description: 'A simple and peaceful rich editor that helps you write and think clearly.',
    thumbnail_url: 'https://assets.standardnotes.com/screenshots/models/editors/bold.jpg',
    availableInRoles: [RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
  })

  const filesafe: IframeComponentFeatureDescription = FillIframeEditorDefaults({
    name: 'FileSafe',
    identifier: NativeFeatureIdentifier.TYPES.DeprecatedFileSafe,
    component_permissions: [
      {
        name: ComponentAction.StreamContextItem,
        content_types: [ContentType.TYPES.Note],
      },
      {
        name: ComponentAction.StreamItems,
        content_types: [
          ContentType.TYPES.FilesafeCredentials,
          ContentType.TYPES.FilesafeFileMetadata,
          ContentType.TYPES.FilesafeIntegration,
        ],
      },
    ],
    permission_name: PermissionName.ComponentFilesafe,
    area: ComponentArea.EditorStack,
    deprecated: true,
    description:
      'Encrypted attachments for your notes using your Dropbox, Google Drive, or WebDAV server. Limited to 50MB per file.',
    thumbnail_url: 'https://assets.standardnotes.com/screenshots/models/FileSafe-banner.png',
    availableInRoles: [RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
  })

  return [bold, filesafe]
}
