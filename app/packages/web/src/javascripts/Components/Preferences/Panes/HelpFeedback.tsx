import { Title, Subtitle, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import PreferencesPane from '../PreferencesComponents/PreferencesPane'
import PreferencesGroup from '../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../PreferencesComponents/PreferencesSegment'

const Documentation = () => {
  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Getting started</Title>
          <div className="h-2 w-full" />
          <Text>
            Standard Red Notes is a private, end-to-end encrypted notes app. Create a note with the “+” button, organize
            with tags and nested folders, and switch note types (rich text, Super, code, markdown, spreadsheet, and
            more) from the note options menu. Everything is unlocked — there are no paid tiers.
          </Text>
        </PreferencesSegment>
        <HorizontalSeparator classes="my-4" />
        <PreferencesSegment>
          <Subtitle>Who can read my notes?</Subtitle>
          <Text>
            Only you. Notes are encrypted on your device before they ever reach the server, so the server stores only
            ciphertext. As long as your account password is strong and kept safe, you are the only person able to
            decrypt your notes.
          </Text>
        </PreferencesSegment>
        <HorizontalSeparator classes="my-4" />
        <PreferencesSegment>
          <Subtitle>Working offline</Subtitle>
          <Text>
            The app works fully offline — with or without an account. Your data lives in your local encrypted database
            and syncs to your server when a connection is available. You can use it with no account at all and add one
            later to enable sync across devices.
          </Text>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Two-factor authentication</Title>
          <Text>
            Open Preferences → Security to enable two-factor authentication. Two methods are available: an authenticator
            app (TOTP — scan the QR code with any authenticator), and email magic link, which sends a one-time code to
            your email at sign-in (when the server has SMTP configured) or shows an on-screen code otherwise. Keep your
            backup/secret key somewhere safe — without it, losing your second factor can lock you out.
          </Text>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Backups &amp; export</Title>
          <Text>
            Use Preferences → Backups to export your data as an encrypted or decrypted archive, and to configure
            automatic local/email backups where supported. Because your data is end-to-end encrypted, there is no
            password reset — your encrypted backups are your safety net, so export them regularly.
          </Text>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>AI Assistant</Title>
          <Text>
            Open the Assistant from the toolbar to chat about and act on your notes (search, summarize, create, edit,
            organize). Configure it under Preferences → Assistant: pick a connection (LM Studio, Ollama, OpenRouter,
            OpenAI, or any OpenAI-compatible endpoint), set the base URL, optional API key, and model. The assistant
            talks to your chosen provider directly from the browser; with a local provider like LM Studio or Ollama,
            nothing leaves your machine.
          </Text>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Keyboard shortcuts</Title>
          <Text>
            See Preferences → Shortcuts for the full list of keyboard shortcuts, including creating notes, searching,
            and navigating between panes.
          </Text>
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default Documentation
