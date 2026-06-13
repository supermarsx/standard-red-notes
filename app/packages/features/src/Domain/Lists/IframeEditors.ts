import { ContentType } from '@standardnotes/domain-core'
import { PermissionName } from '../Permission/PermissionName'
import { NativeFeatureIdentifier } from '../Feature/NativeFeatureIdentifier'
import { NoteType } from '../Component/NoteType'
import { FillIframeEditorDefaults } from './Utilities/FillEditorComponentDefaults'
import { RoleName } from '@standardnotes/domain-core'
import { IframeComponentFeatureDescription } from '../Feature/IframeComponentFeatureDescription'
import { ComponentAction } from '../Component/ComponentAction'

const ALL_ROLES = [RoleName.NAMES.CoreUser, RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser]

export function IframeEditors(): IframeComponentFeatureDescription[] {
  const tokenvault = FillIframeEditorDefaults({
    name: 'Authenticator',
    note_type: NoteType.Authentication,
    file_type: 'json',
    interchangeable: false,
    identifier: NativeFeatureIdentifier.TYPES.TokenVaultEditor,
    permission_name: PermissionName.TokenVaultEditor,
    description:
      'Encrypt and protect your 2FA secrets for all your internet accounts. Authenticator handles your 2FA secrets so that you never lose them again, or have to start over when you get a new device.',
    thumbnail_url: 'https://assets.standardnotes.com/screenshots/models/editors/token-vault.png',
    availableInRoles: [RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
  })

  const spreadsheets = FillIframeEditorDefaults({
    name: 'Spreadsheet',
    identifier: NativeFeatureIdentifier.TYPES.SheetsEditor,
    note_type: NoteType.Spreadsheet,
    file_type: 'json',
    interchangeable: false,
    permission_name: PermissionName.SheetsEditor,
    description:
      'A powerful spreadsheet editor with formatting and formula support. Not recommended for large data sets, as encryption of such data may decrease editor performance.',
    thumbnail_url: 'https://assets.standardnotes.com/screenshots/models/editors/spreadsheets.png',
    availableInRoles: [RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
  })

  const code = FillIframeEditorDefaults({
    name: 'Code',
    spellcheckControl: true,
    identifier: NativeFeatureIdentifier.TYPES.DeprecatedCodeEditor,
    permission_name: PermissionName.DeprecatedCodeEditor,
    note_type: NoteType.Code,
    file_type: 'txt',
    interchangeable: true,
    index_path: 'index.html',
    description:
      'Syntax highlighting and convenient keyboard shortcuts for over 120 programming' +
      ' languages. Ideal for code snippets and procedures.',
    availableInRoles: ALL_ROLES,
  })

  const richText = FillIframeEditorDefaults({
    name: 'Rich Text',
    note_type: NoteType.RichText,
    file_type: 'html',
    identifier: NativeFeatureIdentifier.TYPES.DeprecatedPlusEditor,
    permission_name: PermissionName.DeprecatedPlusEditor,
    spellcheckControl: true,
    description:
      'From highlighting to custom font sizes and colors, to tables and lists, this editor is perfect for crafting any document.',
    availableInRoles: ALL_ROLES,
  })

  const markdown = FillIframeEditorDefaults({
    name: 'Markdown',
    identifier: NativeFeatureIdentifier.TYPES.DeprecatedMarkdownProEditor,
    note_type: NoteType.Markdown,
    file_type: 'md',
    permission_name: PermissionName.DeprecatedMarkdownProEditor,
    spellcheckControl: true,
    description:
      'A fully featured Markdown editor that supports live preview, a styling toolbar, and split pane support.',
    availableInRoles: ALL_ROLES,
  })

  const checklist = FillIframeEditorDefaults({
    name: 'Checklist',
    identifier: NativeFeatureIdentifier.TYPES.DeprecatedTaskEditor,
    note_type: NoteType.Task,
    spellcheckControl: true,
    file_type: 'md',
    interchangeable: false,
    permission_name: PermissionName.DeprecatedTaskEditor,
    description:
      'A great way to manage short-term and long-term to-dos. You can mark tasks as completed, change their order, and edit the text naturally in place.',
    availableInRoles: ALL_ROLES,
  })

  const basicMarkdown = FillIframeEditorDefaults({
    name: 'Basic Markdown',
    identifier: NativeFeatureIdentifier.TYPES.DeprecatedMarkdownBasicEditor,
    note_type: NoteType.Markdown,
    spellcheckControl: true,
    file_type: 'md',
    permission_name: PermissionName.MarkdownBasicEditor,
    description: 'A Markdown editor with dynamic split-pane preview.',
    availableInRoles: ALL_ROLES,
  })

  const minimalMarkdown = FillIframeEditorDefaults({
    name: 'Minimal Markdown',
    identifier: NativeFeatureIdentifier.TYPES.DeprecatedMarkdownMinimistEditor,
    note_type: NoteType.Markdown,
    file_type: 'md',
    index_path: 'index.html',
    permission_name: PermissionName.MarkdownMinimistEditor,
    spellcheckControl: true,
    description: 'A minimal Markdown editor with live rendering and in-text search via Ctrl/Cmd + F.',
    availableInRoles: ALL_ROLES,
  })

  const markdownMath = FillIframeEditorDefaults({
    name: 'Markdown with Math',
    identifier: NativeFeatureIdentifier.TYPES.DeprecatedMarkdownMathEditor,
    spellcheckControl: true,
    permission_name: PermissionName.MarkdownMathEditor,
    note_type: NoteType.Markdown,
    file_type: 'md',
    index_path: 'index.html',
    description: 'A beautiful split-pane Markdown editor with synced-scroll, LaTeX support, and colorful syntax.',
    availableInRoles: ALL_ROLES,
  })

  const markdownVisual = FillIframeEditorDefaults({
    name: 'Markdown Visual',
    identifier: NativeFeatureIdentifier.TYPES.DeprecatedMarkdownVisualEditor,
    note_type: NoteType.Markdown,
    file_type: 'md',
    permission_name: PermissionName.MarkdownVisualEditor,
    spellcheckControl: true,
    description:
      'A WYSIWYG-style Markdown editor that renders Markdown in preview-mode while you type without displaying any syntax.',
    index_path: 'build/index.html',
    availableInRoles: ALL_ROLES,
  })

  const advancedChecklist = FillIframeEditorDefaults({
    name: 'Advanced Checklist',
    identifier: NativeFeatureIdentifier.TYPES.AdvancedChecklistEditor,
    note_type: NoteType.Task,
    file_type: 'json',
    interchangeable: false,
    index_path: 'build/index.html',
    permission_name: PermissionName.AdvancedChecklistEditor,
    component_permissions: [
      {
        name: ComponentAction.StreamContextItem,
        content_types: [ContentType.TYPES.Note],
      },
    ],
    description:
      'A task editor with grouping, drag-and-drop reordering, progress tracking, and completed-task management.',
    availableInRoles: ALL_ROLES,
  })

  return [
    tokenvault,
    spreadsheets,
    code,
    richText,
    markdown,
    checklist,
    basicMarkdown,
    minimalMarkdown,
    markdownMath,
    markdownVisual,
    advancedChecklist,
  ]
}
