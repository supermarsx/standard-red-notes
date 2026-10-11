import { FunctionComponent, useCallback } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import Switch from '@/Components/Switch/Switch'
import usePreference from '@/Hooks/usePreference'
import {
  MERMAID_SOURCE_HIGHLIGHT_PREF_KEY,
  normalizeMermaidSourceHighlighting,
} from '@/Components/SuperEditor/Lexical/Nodes/MermaidSourceHighlightPreference'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'

type Props = {
  application: WebApplication
}

/**
 * Standard Red Notes: the global switch for MERMAID SOURCE HIGHLIGHTING.
 *
 * ONE STORED VALUE, and one place that knows its name: the key literal and the
 * default both come from `MermaidSourceHighlightPreference.ts`, which is also
 * what the diagram block itself reads. So this control cannot drift onto a
 * different key, and it cannot disagree with the pane about what "unset" means.
 * See that module for why the key is a pinned literal rather than
 * `PrefKey.SuperMermaidSourceHighlighting` and why the default is applied on
 * read rather than taken from `PrefDefaults`.
 *
 * TAKES EFFECT LIVE. `application.setPreference` emits
 * `ApplicationEvent.PreferencesChanged`, which both `usePreference` here and
 * `useMermaidSourceHighlightingEnabled` in the block subscribe to, so every open
 * diagram re-renders at once with no reload.
 *
 * NOT MIRRORED INTO THE PER-BLOCK MERMAID SETTINGS PANEL, on purpose. That panel
 * (`MermaidSettingsPanel`) configures ONE DIAGRAM's appearance — its mermaid
 * theme, fit mode, background, zoom, size — and every value it holds is stored
 * in that node and travels with the note. This is neither: it is an editor
 * chrome preference, it is account-wide, and it changes nothing a reader of the
 * note would ever see. Putting it there would also invite the obvious confusion
 * with that panel's `theme` control, which selects one of mermaid's OWN diagram
 * themes. The user asked for it "in user settings", and this is where the
 * other Super-editor display preferences already live.
 */
const MermaidSourceHighlighting: FunctionComponent<Props> = ({ application }) => {
  const stored = usePreference(MERMAID_SOURCE_HIGHLIGHT_PREF_KEY)
  const enabled = normalizeMermaidSourceHighlighting(stored)

  const toggle = useCallback(
    (next: boolean) => {
      void Promise.resolve(application.setPreference(MERMAID_SOURCE_HIGHLIGHT_PREF_KEY, next)).catch(console.error)
    },
    [application],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Mermaid diagrams</Title>
        <div className="mt-2" data-test="mermaid-source-highlighting-settings">
          <div className="flex justify-between gap-2 md:items-center">
            <div className="flex flex-col">
              <Subtitle>Highlight mermaid source</Subtitle>
              <Text>
                Colours the diagram code in a Super note's mermaid block — keywords, arrows, labels, comments and{' '}
                <code>
                  %%{'{'}init{'}'}%%
                </code>{' '}
                directives — using your app theme's own colours. Affects the Code and Split views only; the rendered
                diagram is unchanged. Turn it off for a plain, single-colour editor.
              </Text>
            </div>
            {/* `Switch` takes only `checked`/`onChange`/`className`; the
                accessible name comes from the <label> it renders around the
                visually-hidden checkbox, as every other switch in Preferences
                does. */}
            <Switch onChange={toggle} checked={enabled} className="mermaid-source-highlighting-switch" />
          </div>
          <Text className="text-passive-0 mt-4">
            This is not the same as a diagram's <strong className="font-semibold">theme</strong>, which is set per
            diagram in the editor's Mermaid panel and colours the chart itself.
          </Text>
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default MermaidSourceHighlighting
