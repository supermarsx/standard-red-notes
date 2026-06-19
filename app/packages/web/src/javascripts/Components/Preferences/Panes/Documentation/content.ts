/**
 * Bundled, offline documentation for Standard Red Notes, organized as a wiki of
 * categories -> subpages. All content lives here as plain data (no external
 * links) so it renders consistently, is fully searchable, and works offline.
 *
 * Page ids are namespaced (`category/page`) and unique across the whole wiki so
 * they can be referenced from `related` for cross-linking.
 */

export type DocBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'steps'; items: string[] }
  | { type: 'code'; code: string }
  | { type: 'callout'; variant: 'info' | 'tip' | 'warning'; text: string }
  | { type: 'table'; rows: Array<[string, string]> }

export type DocPage = {
  id: string
  title: string
  summary: string
  blocks: DocBlock[]
  related?: string[]
}

export type DocCategory = {
  id: string
  title: string
  icon: string
  description: string
  pages: DocPage[]
}

export const DOC_CATEGORIES: DocCategory[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    icon: 'notes-filled',
    description: 'Your first notes, the interface, and how accounts work.',
    pages: [
      {
        id: 'getting-started/welcome',
        title: 'Welcome to Standard Red Notes',
        summary: 'A private, end-to-end encrypted notes app where every feature is unlocked for free.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Standard Red Notes is a private notes app built on end-to-end encryption. Your notes are encrypted on your device before they ever reach a server, so only you can read them. It is a single-tier, fully-free, self-hostable app — there are no paid plans and no locked features.',
          },
          {
            type: 'heading',
            text: 'What you get',
          },
          {
            type: 'list',
            items: [
              'Every editor and note type: rich text, the Super block editor, Markdown, code, spreadsheet, checklists, and diagrams.',
              'Unlimited notes, tags, nested folders, and smart views.',
              'End-to-end encrypted file attachments.',
              'Two-factor authentication via an authenticator app or an email magic link.',
              'Encrypted backups and import/export in native and Markdown formats.',
              'Optional AI assistant that can run entirely against a local model.',
              'Self-hosting, multi-device sync, shared vaults, and realtime collaboration.',
            ],
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'Because your notes are end-to-end encrypted, the privacy guarantees and the responsibility for your password are both stronger than in a typical app. Read "How encryption works" and "Your password and key" before you store anything important.',
          },
        ],
        related: ['encryption/how-it-works', 'getting-started/create-first-note', 'getting-started/no-account'],
      },
      {
        id: 'getting-started/create-first-note',
        title: 'Creating your first note',
        summary: 'Make a note, give it a title, and pick the editor that fits.',
        blocks: [
          {
            type: 'steps',
            items: [
              'Click the “+” (Create new note) button at the top of the notes list.',
              'Type a title, then press Tab or click into the body to start writing.',
              'Open the note options menu (the “…” / info icon) to change the note type, pin, star, or protect the note.',
            ],
          },
          {
            type: 'paragraph',
            text: 'A new note uses your default editor. You can change the editor for any individual note at any time, and you can set a different default under Preferences → General.',
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Changing a note’s type converts its content where possible. Converting between very different formats (for example a spreadsheet to plain text) can lose formatting, so duplicate the note first if you want to keep the original.',
          },
        ],
        related: ['editors/note-types', 'editors/super', 'organization/note-options'],
      },
      {
        id: 'getting-started/interface-tour',
        title: 'The interface',
        summary: 'How the navigation, notes list, and editor panels fit together.',
        blocks: [
          {
            type: 'paragraph',
            text: 'The app has three main panels, left to right:',
          },
          {
            type: 'list',
            items: [
              'Navigation — your views (All notes, Starred, Files, Trash), tags, and smart views.',
              'Notes list — the notes inside the selected view, with sorting and search.',
              'Editor — the open note and its options.',
            ],
          },
          {
            type: 'paragraph',
            text: 'On narrow screens the panels stack and you move between them with back gestures. You can collapse panels and toggle focus mode to write distraction-free.',
          },
        ],
        related: ['organization/tags', 'organization/smart-views', 'organization/search'],
      },
      {
        id: 'getting-started/no-account',
        title: 'Using the app without an account',
        summary: 'Everything works offline and locally, with no sign-up required.',
        blocks: [
          {
            type: 'paragraph',
            text: 'You can use Standard Red Notes with no account at all. Your notes are stored in a local encrypted database on your device and never leave it. This is great for trying the app or for a strictly offline workflow.',
          },
          {
            type: 'paragraph',
            text: 'When you are ready to sync across devices or keep an off-device backup, create an account and sign in — your existing local notes are uploaded and encrypted to your server on first sync.',
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'With no account, there is no server-side copy of your notes. If you clear the app’s local data or lose the device, the notes are gone. Export an encrypted backup regularly.',
          },
        ],
        related: ['getting-started/account-setup', 'backups/export-import', 'sync/how-it-works'],
      },
      {
        id: 'getting-started/account-setup',
        title: 'Creating an account & signing in',
        summary: 'Register, choose a strong password, and sign in on each device.',
        blocks: [
          {
            type: 'steps',
            items: [
              'Open the account menu and choose Create account (or Sign in if you already have one).',
              'Confirm the sync server address. For a self-hosted install this is your server’s URL.',
              'Enter your email and a strong password, then create the account.',
            ],
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'Your password is also your encryption key. It is never sent to the server and there is no password reset. Choose something strong that you will not forget, and keep encrypted backups.',
          },
          {
            type: 'paragraph',
            text: 'To use a second device, install the app, point it at the same sync server, and sign in with the same credentials. Your encrypted notes download and decrypt locally.',
          },
        ],
        related: ['encryption/your-password', 'security/two-factor', 'sync/multi-device'],
      },
    ],
  },
  {
    id: 'encryption',
    title: 'Privacy & encryption',
    icon: 'lock-filled',
    description: 'How end-to-end encryption protects your notes and what it means for you.',
    pages: [
      {
        id: 'encryption/how-it-works',
        title: 'How end-to-end encryption works',
        summary: 'Notes are encrypted on your device; the server only ever stores ciphertext.',
        blocks: [
          {
            type: 'paragraph',
            text: 'When you save a note, the app encrypts its contents on your device using keys derived from your account password. Only the encrypted result (ciphertext) is sent to and stored by the server. When you open the app on another device and sign in, the ciphertext is downloaded and decrypted locally with your key.',
          },
          {
            type: 'paragraph',
            text: 'This is what “end-to-end” means: the data is readable only at the ends (your devices), never in the middle (the server or the network).',
          },
          {
            type: 'list',
            items: [
              'Your password is run through a key-derivation function to produce your master key — locally, never on the server.',
              'Each item is encrypted with modern authenticated encryption, so tampering is detectable.',
              'The server authenticates you and stores/relays ciphertext, but cannot decrypt it.',
            ],
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'Encryption protects the content of your notes and files. Some metadata (such as item creation/update timestamps and the fact that an item exists) is necessarily visible to the server so it can sync efficiently.',
          },
        ],
        related: ['encryption/your-password', 'encryption/what-server-sees', 'encryption/encrypted-vs-decrypted'],
      },
      {
        id: 'encryption/your-password',
        title: 'Your password & key',
        summary: 'Your password is your key. There is no reset — back up instead.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Your account password is used to derive your encryption key. The server stores only a value it can use to verify you can sign in; it never receives your actual password or your key.',
          },
          {
            type: 'heading',
            text: 'Why there is no “forgot password”',
          },
          {
            type: 'paragraph',
            text: 'Because the server cannot decrypt your data, it also cannot reset your password and re-encrypt your notes for you. If you forget your password, your encrypted notes cannot be recovered. This is the cost of true privacy.',
          },
          {
            type: 'list',
            items: [
              'Use a long, memorable passphrase, or store the password in a password manager.',
              'Export encrypted backups regularly — they can be restored on any device with the password.',
              'Changing your password re-wraps your keys; keep a recent backup before doing so.',
            ],
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'Treat your password like the only key to a safe. Lose it and the contents are unrecoverable.',
          },
        ],
        related: ['security/change-password', 'backups/why-backups', 'encryption/how-it-works'],
      },
      {
        id: 'encryption/what-server-sees',
        title: 'What the server can and cannot see',
        summary: 'The server stores ciphertext and sync metadata — never your note contents.',
        blocks: [
          {
            type: 'heading',
            text: 'The server cannot see',
          },
          {
            type: 'list',
            items: [
              'The text of your notes.',
              'The contents of your files.',
              'Your tags’ contents, note titles, or editor data — these are encrypted too.',
              'Your password or encryption keys.',
            ],
          },
          {
            type: 'heading',
            text: 'The server does see',
          },
          {
            type: 'list',
            items: [
              'Your email address (used to sign in and, optionally, to send magic-link codes).',
              'That items exist and when they were created or last updated, so it can sync changes.',
              'The size of encrypted items and files.',
              'Your IP address and session/device info for active sessions.',
            ],
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Self-hosting puts even this metadata on infrastructure you control.',
          },
        ],
        related: ['self-hosting/overview', 'security/sessions', 'encryption/how-it-works'],
      },
      {
        id: 'encryption/encrypted-vs-decrypted',
        title: 'Encrypted vs decrypted data',
        summary: 'The difference matters most when you export or move data around.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Inside the app, your notes are always shown decrypted — you just read and write normally. The distinction becomes important when data leaves the app, for example in a backup.',
          },
          {
            type: 'table',
            rows: [
              ['Encrypted backup', 'Ciphertext. Safe to store anywhere. Requires your password (or the backup’s key) to restore.'],
              ['Decrypted backup', 'Plain, readable content. Convenient but unprotected — anyone with the file can read everything.'],
            ],
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'Prefer encrypted backups for archival. Only create a decrypted backup when you specifically need readable data, and store it somewhere safe.',
          },
        ],
        related: ['backups/export-import', 'backups/why-backups'],
      },
    ],
  },
  {
    id: 'security',
    title: 'Account & security',
    icon: 'safe-square',
    description: 'Two-factor authentication, sessions, passwords, and note protection.',
    pages: [
      {
        id: 'security/two-factor',
        title: 'Two-factor authentication (authenticator app)',
        summary: 'Add a TOTP authenticator app as a second factor at sign-in.',
        blocks: [
          {
            type: 'steps',
            items: [
              'Open Preferences → Security.',
              'Enable two-factor authentication and scan the displayed QR code with any authenticator app (the TOTP standard is supported by all of them).',
              'Save your secret/backup key somewhere safe in case you lose the authenticator.',
              'Enter the current 6-digit code to confirm and finish enabling.',
            ],
          },
          {
            type: 'paragraph',
            text: 'After enabling, signing in requires your password plus the current code from your authenticator app.',
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'Store the secret key offline (printed or in a password manager). Without it, losing your authenticator device can lock you out of new sign-ins.',
          },
        ],
        related: ['security/magic-link', 'security/sessions', 'troubleshooting/lost-2fa'],
      },
      {
        id: 'security/magic-link',
        title: 'Email magic-link 2FA',
        summary: 'Use a one-time emailed code as your second factor.',
        blocks: [
          {
            type: 'paragraph',
            text: 'As an alternative to an authenticator app, Standard Red Notes supports an email magic-link second factor. At sign-in, a one-time code is delivered to your email address; entering it completes authentication.',
          },
          {
            type: 'list',
            items: [
              'When your server has email (SMTP) configured, the code is emailed to you.',
              'When email is not configured (for example a minimal self-host), the server shows the code on-screen so you can still complete the flow.',
            ],
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'Magic-link 2FA ties your account security to your email account. Make sure that email account is itself well protected.',
          },
        ],
        related: ['security/two-factor', 'self-hosting/smtp'],
      },
      {
        id: 'security/sessions',
        title: 'Managing sessions & devices',
        summary: 'See where you are signed in and revoke access remotely.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Each device you sign in on creates a session. Under Preferences → Security you can review your active sessions and revoke any you do not recognize.',
          },
          {
            type: 'steps',
            items: [
              'Open Preferences → Security and find the active sessions list.',
              'Review the device, app, and last-active details for each session.',
              'Revoke any session you no longer trust — that device is immediately signed out.',
            ],
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Revoke sessions for lost or sold devices right away. The data on those devices stays encrypted, but revoking prevents further sync.',
          },
        ],
        related: ['security/change-password', 'encryption/what-server-sees'],
      },
      {
        id: 'security/change-password',
        title: 'Changing your password',
        summary: 'Rotate your password safely without losing access to your notes.',
        blocks: [
          {
            type: 'steps',
            items: [
              'Export a current encrypted backup first, as a safety net.',
              'Open Preferences → Account and choose to change your password.',
              'Enter your current password and the new one; your keys are re-wrapped with the new password.',
              'Sign in again on your other devices with the new password.',
            ],
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'Other signed-in devices may need to re-authenticate after a password change. Keep the backup until every device is updated and syncing.',
          },
        ],
        related: ['encryption/your-password', 'backups/why-backups', 'security/sessions'],
      },
      {
        id: 'security/protected-notes',
        title: 'Protected notes & app lock',
        summary: 'Require authentication to view sensitive notes or to open the app.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Mark any note as protected from its options menu. Protected notes require you to re-authenticate (with your account password, or a device passcode/biometric where available) before they can be viewed or edited.',
          },
          {
            type: 'paragraph',
            text: 'You can also set an app-level passcode or biometric lock so the whole app requires authentication when opened or after it has been idle.',
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Protection is a convenience guard against shoulder-surfing and casual access. The underlying notes are always encrypted regardless of protection state.',
          },
        ],
        related: ['organization/note-options', 'security/two-factor'],
      },
    ],
  },
  {
    id: 'editors',
    title: 'Notes & editors',
    icon: 'rich-text',
    description: 'Every note type and editor, and when to use each.',
    pages: [
      {
        id: 'editors/note-types',
        title: 'Note types overview',
        summary: 'Switch any note between editors to match the content.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Each note has a type, set from the note options menu. All types are available to every account.',
          },
          {
            type: 'table',
            rows: [
              ['Super', 'A modern block editor with rich blocks, tables, checklists, and embedded diagrams.'],
              ['Rich text', 'Classic formatted text (bold, lists, links, images).'],
              ['Markdown', 'Plain Markdown with a live preview.'],
              ['Code', 'Syntax-highlighted code with language selection.'],
              ['Plain text', 'No formatting — fastest and most portable.'],
              ['Spreadsheet', 'A grid for tabular data and simple calculations.'],
              ['Checklist / tasks', 'Lists of items you can check off.'],
            ],
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Set your most-used type as the default under Preferences → General so new notes start in the right editor.',
          },
        ],
        related: ['editors/super', 'editors/markdown', 'editors/code', 'editors/spreadsheet'],
      },
      {
        id: 'editors/super',
        title: 'The Super (block) editor',
        summary: 'A flexible block editor with slash commands, tables, and diagrams.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Super is the most capable editor. Content is organized into blocks — paragraphs, headings, lists, checklists, tables, code blocks, dividers, and more. Type “/” to open the block menu and insert any block type.',
          },
          {
            type: 'list',
            items: [
              'Slash commands to insert and transform blocks.',
              'Inline formatting, links, and embedded images/files.',
              'Collapsible sections, tables, and checklists in one document.',
              'Mermaid diagram blocks for flowcharts and diagrams from text.',
            ],
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Super is the most robust place to use Mermaid diagrams. The legacy Markdown editors also render Mermaid in their preview on a best-effort basis.',
          },
        ],
        related: ['editors/mermaid', 'editors/checklists', 'editors/note-types'],
      },
      {
        id: 'editors/markdown',
        title: 'Markdown editors',
        summary: 'Write in Markdown with a side-by-side or toggled preview.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Several Markdown editors are bundled, from minimal to full-featured. They render standard Markdown — headings, emphasis, lists, links, images, tables, and fenced code blocks — with a live preview.',
          },
          {
            type: 'paragraph',
            text: 'Fenced code blocks tagged as mermaid are rendered as diagrams in the preview where supported.',
          },
          {
            type: 'code',
            code: '```mermaid\nflowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do thing]\n  B -->|No| D[Stop]\n```',
          },
        ],
        related: ['editors/super', 'editors/mermaid', 'editors/code'],
      },
      {
        id: 'editors/code',
        title: 'Code editor',
        summary: 'Syntax highlighting for snippets and configuration.',
        blocks: [
          {
            type: 'paragraph',
            text: 'The code editor provides syntax highlighting for many languages. Pick the language from the editor’s controls; the choice is saved with the note.',
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Use the code editor for snippets, config files, and command references you want to keep readable and copy-pasteable.',
          },
        ],
        related: ['editors/note-types', 'editors/markdown'],
      },
      {
        id: 'editors/spreadsheet',
        title: 'Spreadsheet',
        summary: 'A grid editor for tabular data and light calculations.',
        blocks: [
          {
            type: 'paragraph',
            text: 'The spreadsheet editor turns a note into a grid of cells for tabular data, simple budgets, and trackers. Data is encrypted like any other note.',
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'For freeform tables inside a longer document, the Super editor’s table block is often more convenient than a full spreadsheet note.',
          },
        ],
        related: ['editors/super', 'editors/note-types'],
      },
      {
        id: 'editors/mermaid',
        title: 'Diagrams with Mermaid',
        summary: 'Describe flowcharts, sequence, and other diagrams as text.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Mermaid lets you write diagrams as text that render into flowcharts, sequence diagrams, Gantt charts, and more. The Super editor has a dedicated Mermaid block; the legacy Markdown editors render mermaid-tagged code blocks in their preview on a best-effort basis.',
          },
          {
            type: 'code',
            code: 'sequenceDiagram\n  participant You\n  participant App\n  participant Server\n  You->>App: Write a note\n  App->>App: Encrypt locally\n  App->>Server: Upload ciphertext',
          },
        ],
        related: ['editors/super', 'editors/markdown'],
      },
      {
        id: 'editors/checklists',
        title: 'Checklists & to-dos',
        summary: 'Track tasks with checkable items inside notes.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Use a checklist/tasks note, or a checklist block inside a Super note, to track to-dos. Check items off as you complete them; completed items can be grouped or hidden depending on the editor.',
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Combine a daily note with checklist blocks to build a lightweight calendar-style to-do system.',
          },
        ],
        related: ['editors/super', 'organization/smart-views'],
      },
    ],
  },
  {
    id: 'organization',
    title: 'Organizing notes',
    icon: 'menu-variant',
    description: 'Tags, nested folders, smart views, pinning, and search.',
    pages: [
      {
        id: 'organization/tags',
        title: 'Tags & nested folders',
        summary: 'Group notes with tags, and nest tags to build a folder hierarchy.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Tags group related notes. A note can have many tags. Tags can be nested to create a folder-like hierarchy — drag a tag onto another to nest it.',
          },
          {
            type: 'steps',
            items: [
              'Create a tag from the navigation panel’s add button.',
              'Drag a note onto a tag, or add tags from the note’s options.',
              'Drag one tag into another to nest it as a sub-folder.',
            ],
          },
        ],
        related: ['organization/smart-views', 'organization/search'],
      },
      {
        id: 'organization/smart-views',
        title: 'Smart views',
        summary: 'Saved filters that automatically collect matching notes.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Smart views are dynamic, saved filters. Instead of manually tagging, you define rules (for example notes with a certain tag, type, or that are starred) and the view always shows the matching notes.',
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Use smart views for things like “Untagged”, “Starred”, “Files”, or “Recently updated” without maintaining them by hand.',
          },
        ],
        related: ['organization/tags', 'organization/pinning'],
      },
      {
        id: 'organization/pinning',
        title: 'Pinning, starring, archiving & trash',
        summary: 'Keep important notes up top and tidy away the rest.',
        blocks: [
          {
            type: 'table',
            rows: [
              ['Pin', 'Keeps a note at the top of the list.'],
              ['Star', 'Marks a note as important; collect them in the Starred view.'],
              ['Archive', 'Removes a note from the main list without deleting it.'],
              ['Trash', 'Moves a note to Trash; empty the Trash to delete permanently.'],
            ],
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'Emptying the Trash is permanent. Once synced, deleted notes cannot be recovered unless they exist in a backup.',
          },
        ],
        related: ['organization/note-options', 'backups/restore'],
      },
      {
        id: 'organization/search',
        title: 'Searching notes',
        summary: 'Find notes fast across titles and contents.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Use the search box above the notes list to filter by title and content within the current view. Search runs locally against your decrypted data, so it is fast and private.',
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Combine search with a smart view or tag to scope results to a subset of your notes.',
          },
        ],
        related: ['organization/smart-views', 'organization/tags'],
      },
      {
        id: 'organization/note-options',
        title: 'Note options',
        summary: 'Per-note actions: type, pin, protect, preview, and more.',
        blocks: [
          {
            type: 'paragraph',
            text: 'The note options menu collects per-note actions in one place:',
          },
          {
            type: 'list',
            items: [
              'Change the note type / editor.',
              'Pin, star, or archive the note.',
              'Protect the note (require authentication to open).',
              'Toggle list preview, spell-check, and editor width.',
              'Duplicate, export, or move the note to Trash.',
            ],
          },
        ],
        related: ['editors/note-types', 'security/protected-notes', 'organization/pinning'],
      },
    ],
  },
  {
    id: 'files',
    title: 'Files & attachments',
    icon: 'attachment-file',
    description: 'Attach and manage end-to-end encrypted files.',
    pages: [
      {
        id: 'files/uploading',
        title: 'Uploading & attaching files',
        summary: 'Attach files to notes or keep them in the Files view.',
        blocks: [
          {
            type: 'steps',
            items: [
              'Drag a file into a note, or use the attach action in the editor toolbar / note options.',
              'The file is encrypted on your device and uploaded to your server.',
              'Find all uploads in the Files view; link them to one or more notes.',
            ],
          },
          {
            type: 'paragraph',
            text: 'Files are downloaded and decrypted locally when you open them, the same way notes are.',
          },
        ],
        related: ['files/encryption', 'self-hosting/overview'],
      },
      {
        id: 'files/encryption',
        title: 'File encryption & limits',
        summary: 'Files are encrypted like notes; limits depend on your server.',
        blocks: [
          {
            type: 'paragraph',
            text: 'File contents are end-to-end encrypted, so the server stores only ciphertext. Upload size and storage limits depend on your server’s configuration. On a self-hosted install you set these yourself.',
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'This build issues unlimited file tokens for free accounts, so uploads are not gated behind a subscription. Practical limits come from your own server and storage.',
          },
        ],
        related: ['files/uploading', 'self-hosting/architecture'],
      },
    ],
  },
  {
    id: 'sync',
    title: 'Sync & devices',
    icon: 'cloud-off',
    description: 'How sync works across devices, offline, and during conflicts.',
    pages: [
      {
        id: 'sync/how-it-works',
        title: 'How sync works',
        summary: 'Encrypted changes upload and download automatically.',
        blocks: [
          {
            type: 'paragraph',
            text: 'When you are signed in and online, the app continuously syncs encrypted changes with your server. Local edits are queued and uploaded; remote changes are downloaded and merged. Everything transits and rests as ciphertext.',
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'The first sync after signing in on a new device downloads your whole encrypted dataset, then keeps up incrementally.',
          },
        ],
        related: ['sync/multi-device', 'sync/offline', 'sync/conflicts'],
      },
      {
        id: 'sync/multi-device',
        title: 'Using multiple devices',
        summary: 'Sign in on each device with the same account and server.',
        blocks: [
          {
            type: 'steps',
            items: [
              'Install the app on the new device.',
              'Point it at the same sync server.',
              'Sign in with your email and password (and second factor, if enabled).',
            ],
          },
          {
            type: 'paragraph',
            text: 'Edits made on any device appear on the others within seconds while both are online.',
          },
        ],
        related: ['getting-started/account-setup', 'sync/conflicts'],
      },
      {
        id: 'sync/conflicts',
        title: 'Sync conflicts & resolution',
        summary: 'When the same note changes in two places, both versions are kept.',
        blocks: [
          {
            type: 'paragraph',
            text: 'If a note is edited on two devices before they sync (for example both were offline), the app keeps both versions rather than silently overwriting. You will see a conflicted copy alongside the original so you can merge and delete the extra.',
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Conflicts are a safety feature. Resolve them by copying anything you need from the conflicted copy into the main note, then trash the copy.',
          },
        ],
        related: ['sync/how-it-works', 'backups/restore'],
      },
      {
        id: 'sync/offline',
        title: 'Offline use',
        summary: 'Full functionality without a connection; sync resumes later.',
        blocks: [
          {
            type: 'paragraph',
            text: 'The app is offline-first. You can read and write everything while disconnected; changes are stored locally and sync automatically when a connection returns.',
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'While offline, your changes exist only on that device until it syncs. Avoid clearing local data before a successful sync.',
          },
        ],
        related: ['getting-started/no-account', 'sync/how-it-works'],
      },
    ],
  },
  {
    id: 'backups',
    title: 'Backups & export',
    icon: 'file-zip',
    description: 'Export, import, and protect yourself against data loss.',
    pages: [
      {
        id: 'backups/why-backups',
        title: 'Why backups matter',
        summary: 'There is no password reset — backups are your safety net.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Because your data is end-to-end encrypted and there is no password reset, encrypted backups are how you protect yourself against a forgotten password, a lost device, or an accidental deletion.',
          },
          {
            type: 'list',
            items: [
              'Export an encrypted backup regularly and store copies in more than one place.',
              'An encrypted backup can be restored on any device with your password.',
              'Verify occasionally that you can actually restore a backup.',
            ],
          },
        ],
        related: ['backups/export-import', 'backups/automatic', 'encryption/your-password'],
      },
      {
        id: 'backups/export-import',
        title: 'Exporting & importing data',
        summary: 'Export native (encrypted or decrypted) or Markdown; import native backups.',
        blocks: [
          {
            type: 'heading',
            text: 'Export',
          },
          {
            type: 'paragraph',
            text: 'From the account menu choose Export. You can export:',
          },
          {
            type: 'list',
            items: [
              'Native encrypted — a full, encrypted archive. Best for backups.',
              'Native decrypted — a full archive in readable form. Convenient but unprotected.',
              'Markdown — your notes as plain .md files for use in other tools.',
            ],
          },
          {
            type: 'heading',
            text: 'Import',
          },
          {
            type: 'paragraph',
            text: 'Use Import to bring in a native Standard Notes / Standard Red Notes backup. Encrypted backups prompt for the password that protects them; decrypted backups import directly.',
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Round-trip safely: export a native backup before importing, so you can roll back if an import does not look right.',
          },
        ],
        related: ['encryption/encrypted-vs-decrypted', 'backups/restore', 'backups/why-backups'],
      },
      {
        id: 'backups/automatic',
        title: 'Automatic backups',
        summary: 'Schedule recurring local or emailed backups where supported.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Under Preferences → Backups you can enable automatic backups so a fresh copy is written on a schedule without you remembering to do it. Available destinations depend on your platform (desktop can write to a local folder).',
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'Automatic backups complement, but do not replace, the occasional manual export you store off-device.',
          },
        ],
        related: ['backups/export-import', 'backups/why-backups'],
      },
      {
        id: 'backups/restore',
        title: 'Restoring from a backup',
        summary: 'Bring data back after loss, or recover a deleted note.',
        blocks: [
          {
            type: 'steps',
            items: [
              'Open Import from the account menu.',
              'Choose your backup file (native encrypted or decrypted).',
              'For an encrypted backup, enter the password that protected it.',
              'Review the imported notes; resolve any duplicates.',
            ],
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'Importing adds items; it does not wipe your current data. If you are recovering into a fresh account, import into an empty state to avoid mixing datasets.',
          },
        ],
        related: ['backups/export-import', 'sync/conflicts'],
      },
    ],
  },
  {
    id: 'self-hosting',
    title: 'Self-hosting',
    icon: 'code-tags',
    description: 'Run your own server, gateway, and database with full control.',
    pages: [
      {
        id: 'self-hosting/overview',
        title: 'Self-hosting overview',
        summary: 'Own the whole stack — even the sync metadata stays on your infrastructure.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Standard Red Notes is designed to be self-hosted. Running your own server means the encrypted data and the limited sync metadata both live on infrastructure you control, and you set your own limits with no subscriptions involved.',
          },
          {
            type: 'paragraph',
            text: 'The bundled deployment uses containers orchestrated together: the app (static web UI), the server (sync, auth, files), a realtime gateway, a database, and a cache.',
          },
        ],
        related: ['self-hosting/architecture', 'self-hosting/cookies-auth', 'self-hosting/smtp'],
      },
      {
        id: 'self-hosting/architecture',
        title: 'Architecture',
        summary: 'How the app, server, gateway, database, and cache fit together.',
        blocks: [
          {
            type: 'table',
            rows: [
              ['App', 'The static web client served over HTTP. Talks to the server’s API.'],
              ['Server', 'Auth, syncing, and files services. Stores ciphertext and authenticates you.'],
              ['Gateway', 'A WebSocket service for realtime push and collaboration relay.'],
              ['Database', 'Stores encrypted items and account metadata.'],
              ['Cache', 'Speeds up sessions and ephemeral state.'],
            ],
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'The app and server run on separate ports/origins by default, so the client is configured to send credentials cross-origin and the server allows it. See "How authentication works".',
          },
        ],
        related: ['self-hosting/cookies-auth', 'collaboration/realtime', 'automation/mcp-overview'],
      },
      {
        id: 'self-hosting/cookies-auth',
        title: 'How authentication works (cookies)',
        summary: 'Browser sessions are authenticated with cookies — configure them for your host.',
        blocks: [
          {
            type: 'paragraph',
            text: 'For browser sessions, the server authenticates requests using session cookies it sets at sign-in (an access-token and a refresh-token cookie). The client must send these cookies, and the server must accept them — both have to suit your deployment or every authenticated request will fail.',
          },
          {
            type: 'heading',
            text: 'Key settings',
          },
          {
            type: 'table',
            rows: [
              ['COOKIE_DOMAIN', 'Leave empty for a host-only cookie that works on localhost, a bare hostname, or an IP. Set it only for an HTTPS deployment behind a real domain.'],
              ['COOKIE_SECURE', 'false for plain HTTP self-hosting; true when serving over HTTPS.'],
              ['COOKIE_SAME_SITE', 'Lax is appropriate for a same-site app+API; None requires Secure.'],
              ['CORS', 'The server echoes your app’s origin and allows credentials so cookies flow across the app/API ports.'],
            ],
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'If you see repeated 401 “Invalid login credentials” and the browser console reports cookies “rejected for invalid domain”, the cookie domain does not match your host. Use an empty domain (host-only) for localhost/IP setups.',
          },
        ],
        related: ['self-hosting/architecture', 'troubleshooting/cant-sign-in', 'troubleshooting/not-syncing'],
      },
      {
        id: 'self-hosting/smtp',
        title: 'Email / SMTP for magic link',
        summary: 'Configure email so magic-link codes are delivered to inboxes.',
        blocks: [
          {
            type: 'paragraph',
            text: 'The email magic-link second factor needs an email transport (SMTP) to deliver codes. Configure your server’s SMTP settings to send mail from an address you control.',
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'Without SMTP configured, magic-link still works for a single-user/self-host scenario by showing the code on-screen instead of emailing it.',
          },
        ],
        related: ['security/magic-link', 'self-hosting/overview'],
      },
      {
        id: 'self-hosting/updating',
        title: 'Updating your server',
        summary: 'Rebuild and recreate containers to pick up changes.',
        blocks: [
          {
            type: 'paragraph',
            text: 'When you change configuration or pull new code, rebuild the affected image and recreate its container. Configuration-only changes usually need just a recreate; code changes need a rebuild first.',
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Recreate one service at a time (for example just the server, or just the app) to minimize disruption, and keep a recent backup before bigger upgrades.',
          },
        ],
        related: ['self-hosting/architecture', 'backups/why-backups'],
      },
    ],
  },
  {
    id: 'assistant',
    title: 'AI assistant',
    icon: 'star-variant-filled',
    description: 'Chat about and act on your notes, optionally fully local.',
    pages: [
      {
        id: 'assistant/overview',
        title: 'What the assistant can do',
        summary: 'Search, summarize, create, edit, and organize your notes from chat.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Open the assistant from the toolbar to chat about your notes and take actions on them — search, summarize, draft new notes, edit existing ones, and help with organization.',
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'The assistant operates within your account and acts on your decrypted notes locally in the browser session.',
          },
        ],
        related: ['assistant/providers', 'assistant/privacy'],
      },
      {
        id: 'assistant/providers',
        title: 'Configuring providers',
        summary: 'Use a local model or any OpenAI-compatible endpoint.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Under Preferences → Assistant, choose a connection and model. Supported options include local servers (LM Studio, Ollama) and any OpenAI-compatible endpoint (OpenAI, OpenRouter, or a custom server).',
          },
          {
            type: 'steps',
            items: [
              'Pick a provider/connection.',
              'Set the base URL (for a local server this points at your machine).',
              'Add an API key if the provider needs one (local servers usually do not).',
              'Select the model to use.',
            ],
          },
        ],
        related: ['assistant/overview', 'assistant/privacy'],
      },
      {
        id: 'assistant/privacy',
        title: 'Assistant & privacy',
        summary: 'With a local model, nothing leaves your machine.',
        blocks: [
          {
            type: 'paragraph',
            text: 'The assistant talks to whichever provider you configure. With a local provider such as LM Studio or Ollama, your prompts and note content never leave your computer. With a hosted provider, the content you send is processed by that third party under their terms.',
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'If privacy is the priority, use a local model. Be deliberate about which notes you share with a hosted provider.',
          },
        ],
        related: ['assistant/providers', 'encryption/how-it-works'],
      },
    ],
  },
  {
    id: 'collaboration',
    title: 'Collaboration',
    icon: 'user-switch',
    description: 'Shared vaults, contacts, and realtime co-editing.',
    pages: [
      {
        id: 'collaboration/vaults',
        title: 'Shared vaults',
        summary: 'Share a set of notes with other people, end-to-end encrypted.',
        blocks: [
          {
            type: 'paragraph',
            text: 'A shared vault is a collection of notes shared with other accounts. Membership and keys are managed so that only members can decrypt the vault’s contents — the server still never sees plaintext.',
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'Add people to a vault via contacts, then place the notes you want to share inside it.',
          },
        ],
        related: ['collaboration/contacts', 'collaboration/realtime'],
      },
      {
        id: 'collaboration/contacts',
        title: 'Contacts & trust',
        summary: 'Exchange and verify identities before sharing.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Contacts represent the other people you collaborate with. Establishing a contact exchanges the public information needed to share encrypted content with them. Verify a contact through a trusted channel before sharing anything sensitive.',
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Verification protects against impersonation. Confirm a contact’s identity out-of-band (in person or over another trusted channel).',
          },
        ],
        related: ['collaboration/vaults', 'collaboration/realtime'],
      },
      {
        id: 'collaboration/realtime',
        title: 'Realtime collaboration',
        summary: 'Co-edit notes live, with changes relayed end-to-end encrypted.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Realtime collaboration lets multiple people edit the same note together, with presence and live updates. Edits are encrypted and relayed through the self-hosted gateway, which forwards ciphertext between collaborators without being able to read it.',
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'Realtime co-editing is an advanced, experimental capability and is off by default. It builds on shared vaults and the WebSocket gateway.',
          },
        ],
        related: ['collaboration/vaults', 'self-hosting/architecture'],
      },
    ],
  },
  {
    id: 'automation',
    title: 'Automation (MCP)',
    icon: 'open-in',
    description: 'Let an AI agent work with your account through the MCP bridge.',
    pages: [
      {
        id: 'automation/mcp-overview',
        title: 'The MCP bridge',
        summary: 'A Model Context Protocol server that exposes your account to agents.',
        blocks: [
          {
            type: 'paragraph',
            text: 'The MCP bridge is a Model Context Protocol server that connects an AI agent to your Standard Red Notes account. It runs headless, signs in to your server, and exposes tools an agent can call to work with your notes.',
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'The bridge runs with the credentials you give it and is read-only by default; writing must be explicitly enabled.',
          },
        ],
        related: ['automation/mcp-setup', 'automation/capabilities'],
      },
      {
        id: 'automation/mcp-setup',
        title: 'Connecting an agent',
        summary: 'Point the bridge at your server and provide account credentials.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Configure the bridge with your server URL and account credentials (and a 2FA code if your account requires one). Enable writes only if you want the agent to make changes. Then connect your MCP-capable client to the bridge.',
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'Give the bridge a dedicated account or be deliberate about which account it uses. Keep writes disabled until you trust the workflow.',
          },
        ],
        related: ['automation/mcp-overview', 'automation/capabilities'],
      },
      {
        id: 'automation/capabilities',
        title: 'What an agent can do',
        summary: 'Read, search, create, edit, and organize within your account.',
        blocks: [
          {
            type: 'list',
            items: [
              'Read and search notes and tags.',
              'Create new notes and edit existing ones (when writes are enabled).',
              'Organize: tag, pin, and move notes.',
              'Sync continuously so it sees collaborators’ changes.',
            ],
          },
          {
            type: 'callout',
            variant: 'info',
            text: 'The agent works through the same encrypted sync as any client — it decrypts locally using the credentials you provide.',
          },
        ],
        related: ['automation/mcp-setup', 'assistant/overview'],
      },
    ],
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    icon: 'keyboard-close',
    description: 'Move faster with the keyboard.',
    pages: [
      {
        id: 'shortcuts/common',
        title: 'Common shortcuts',
        summary: 'Frequently used keyboard shortcuts; see Preferences → Shortcuts for the full, platform-specific list.',
        blocks: [
          {
            type: 'paragraph',
            text: 'The exact keys depend on your platform (the Ctrl key on Windows/Linux is usually Cmd on macOS). The most-used actions:',
          },
          {
            type: 'table',
            rows: [
              ['Create new note', 'Ctrl/Cmd + Alt + N'],
              ['Search notes', 'Ctrl/Cmd + F (within the notes list)'],
              ['Next / previous note', 'Arrow keys in the notes list'],
              ['Toggle focus / no-distraction mode', 'See Preferences → Shortcuts'],
              ['Pin / star / actions', 'Via the note options menu'],
            ],
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'Open Preferences → Shortcuts for the authoritative, customizable list for your platform.',
          },
        ],
        related: ['organization/search', 'organization/note-options'],
      },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    icon: 'details-block',
    description: 'Fix sign-in, sync, and recovery problems.',
    pages: [
      {
        id: 'troubleshooting/cant-sign-in',
        title: 'Can’t sign in / 401 errors',
        summary: 'Repeated “Invalid login credentials” usually means a cookie or password issue.',
        blocks: [
          {
            type: 'heading',
            text: 'Check your password',
          },
          {
            type: 'paragraph',
            text: 'There is no password reset. Make sure you are using the exact account password. If you genuinely forgot it, you must restore from a backup into a new account.',
          },
          {
            type: 'heading',
            text: 'Self-hosted: cookie problems',
          },
          {
            type: 'paragraph',
            text: 'On a self-host, repeated 401s right after signing in — especially with browser console messages about cookies “rejected for invalid domain” — mean the session cookie is not being stored or sent. Set an empty cookie domain (host-only) for localhost/IP, disable Secure for plain HTTP, and make sure the client sends credentials cross-origin.',
          },
          {
            type: 'callout',
            variant: 'tip',
            text: 'After fixing cookie settings, fully reload the app and sign in again so a fresh, valid cookie is stored.',
          },
        ],
        related: ['self-hosting/cookies-auth', 'troubleshooting/not-syncing', 'encryption/your-password'],
      },
      {
        id: 'troubleshooting/not-syncing',
        title: 'Notes not syncing',
        summary: 'Work through connection, sign-in, and conflict causes.',
        blocks: [
          {
            type: 'steps',
            items: [
              'Confirm you are online and signed in (not in an account-less/offline state).',
              'Check that the app points at the correct sync server.',
              'On a self-host, verify the server is healthy and authentication (cookies) is configured correctly.',
              'Look for conflicted copies, which indicate sync did happen but diverged.',
            ],
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'Do not clear local data to “fix” sync until you have confirmed a successful upload — unsynced local changes would be lost.',
          },
        ],
        related: ['troubleshooting/cant-sign-in', 'sync/conflicts', 'self-hosting/cookies-auth'],
      },
      {
        id: 'troubleshooting/lost-2fa',
        title: 'Lost two-factor access',
        summary: 'Use your saved secret/backup key, or fall back to magic link.',
        blocks: [
          {
            type: 'paragraph',
            text: 'If you lose your authenticator device, re-add the account in a new authenticator using the secret/backup key you saved when enabling 2FA. If you enabled email magic-link 2FA, you can complete sign-in via the emailed (or on-screen) code instead.',
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'Without the secret key and without an alternate factor, you may be unable to complete new sign-ins. This is why saving the secret key at setup is essential.',
          },
        ],
        related: ['security/two-factor', 'security/magic-link'],
      },
      {
        id: 'troubleshooting/reset',
        title: 'Clearing local data',
        summary: 'A last resort that wipes the on-device database.',
        blocks: [
          {
            type: 'paragraph',
            text: 'Clearing local data removes the app’s on-device encrypted database. For a synced account this is recoverable — sign in again and re-download from the server. For an account-less/offline setup, it is permanent.',
          },
          {
            type: 'callout',
            variant: 'warning',
            text: 'Always export a backup before clearing local data, and confirm your latest changes have synced.',
          },
        ],
        related: ['troubleshooting/not-syncing', 'backups/export-import', 'sync/offline'],
      },
    ],
  },
]

const PAGE_INDEX: Map<string, { page: DocPage; category: DocCategory }> = new Map()
for (const category of DOC_CATEGORIES) {
  for (const page of category.pages) {
    PAGE_INDEX.set(page.id, { page, category })
  }
}

export function getPage(id: string): { page: DocPage; category: DocCategory } | undefined {
  return PAGE_INDEX.get(id)
}

function blockText(block: DocBlock): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'callout':
      return block.text
    case 'list':
    case 'steps':
      return block.items.join(' ')
    case 'code':
      return block.code
    case 'table':
      return block.rows.map((row) => row.join(' ')).join(' ')
  }
}

export type DocSearchResult = { page: DocPage; category: DocCategory }

export function searchDocs(query: string): DocSearchResult[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
  if (terms.length === 0) {
    return []
  }

  const results: Array<{ entry: DocSearchResult; score: number }> = []
  for (const category of DOC_CATEGORIES) {
    for (const page of category.pages) {
      const title = page.title.toLowerCase()
      const summary = page.summary.toLowerCase()
      const body = page.blocks.map(blockText).join(' ').toLowerCase()
      let score = 0
      let matchedAll = true
      for (const term of terms) {
        const inTitle = title.includes(term)
        const inSummary = summary.includes(term)
        const inBody = body.includes(term)
        if (!inTitle && !inSummary && !inBody) {
          matchedAll = false
          break
        }
        score += (inTitle ? 5 : 0) + (inSummary ? 2 : 0) + (inBody ? 1 : 0)
      }
      if (matchedAll) {
        results.push({ entry: { page, category }, score })
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).map((result) => result.entry)
}
