import type { PrefKey } from '@standardnotes/snjs'
import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Switch from '@/Components/Switch/Switch'
import usePreference from '@/Hooks/usePreference'
import {
  CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY,
  CHECKLIST_GENERATE_CAP_MAX,
  CHECKLIST_GENERATE_CAP_MIN,
  CHECKLIST_GENERATE_CAP_PREF_KEY,
  normalizeChecklistGenerateCap,
  resolveChecklistBackfillSettings,
} from '@/Components/SuperEditor/Checklist/checklistBackfill'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'

type Props = {
  application: WebApplication
}

/**
 * The two recurrence-generation preference keys as `PrefKey`s.
 *
 * The STRINGS are imported from `checklistBackfill.ts` rather than re-typed, so
 * there is one spelling of each in the tree and this surface cannot drift onto a
 * different key than the editor's Checklists subsection writes. The cast is the
 * `todoFilters.ts:76-87` pin: web consumes `PrefKey`'s runtime value from the
 * generated models bundle, where both members are absent until it is rebuilt —
 * reading `PrefKey.ChecklistGenerateCap` yields `undefined` and the preference
 * silently falls to its default forever. It goes through `unknown` because web
 * type-checks `@standardnotes/snjs` against a `models/dist` artifact that predates
 * both members too, so the direct `as PrefKey.ChecklistGenerateCap` form does not
 * compile yet. Swap both for the plain enum members once models/snjs are rebuilt.
 */
const CHECKLIST_AUTO_GENERATE_PREF = CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY as unknown as PrefKey
const CHECKLIST_GENERATE_CAP_PREF = CHECKLIST_GENERATE_CAP_PREF_KEY as unknown as PrefKey

/**
 * Standard Red Notes: the recurring-checklist generation settings
 * (t111 §3 rows 5-6).
 *
 * A MIRROR of the "Recurring tasks" block inside the editor's Checklists
 * subsection (`SuperEditor/Plugins/ToolbarPlugin/ChecklistSubsection.tsx`). That
 * one is next to the checklist it acts on and carries the per-note "Generate now"
 * button; this one is where the two account-wide values are found by someone who
 * is not in a Super note at all.
 *
 * ONE STORED VALUE PER SETTING. Both surfaces read through the same two imported
 * key literals and the same `resolveChecklistBackfillSettings`, and write with
 * `application.setPreference` to those same keys. Nothing is duplicated, so a
 * change here is the change there.
 *
 * ## Defaults are literals, and the cap is clamped ON READ
 * `resolveChecklistBackfillSettings` supplies ON and 12 from `checklistBackfill.ts`
 * — never from `PrefDefaults`, which is `undefined` for both keys until the
 * generated bundle is rebuilt and would therefore render the toggle OFF while the
 * feature was ON. The cap is clamped into
 * {@link CHECKLIST_GENERATE_CAP_MIN}..{@link CHECKLIST_GENERATE_CAP_MAX} every time
 * it is read, because it is a SYNCED value another device running different code
 * may have written.
 *
 * ## Why the cap commits on blur rather than per keystroke
 * The field is a draft until it loses focus or takes Enter. Clamping per keystroke
 * would rewrite the number under the cursor — typing "150" would pass through 1
 * (clamped from "1") and 15 — and each intermediate value would be a synced write.
 */
const ChecklistRecurrence: FunctionComponent<Props> = ({ application }) => {
  const storedAutoGenerate = usePreference(CHECKLIST_AUTO_GENERATE_PREF)
  const storedCap = usePreference(CHECKLIST_GENERATE_CAP_PREF)

  const settings = useMemo(
    () => resolveChecklistBackfillSettings({ autoGenerate: storedAutoGenerate, cap: storedCap }),
    [storedAutoGenerate, storedCap],
  )

  const [capDraft, setCapDraft] = useState(() => String(settings.cap))

  // Follow the stored value when it changes elsewhere (the Checklists subsection,
  // or another device) — but never mid-edit, which is why the effect keys off the
  // resolved number rather than every keystroke.
  useEffect(() => {
    setCapDraft(String(settings.cap))
  }, [settings.cap])

  const setAutoGenerate = useCallback(
    (next: boolean) => {
      void Promise.resolve(application.setPreference(CHECKLIST_AUTO_GENERATE_PREF, next as never)).catch(console.error)
    },
    [application],
  )

  const commitCap = useCallback(() => {
    const parsed = Number.parseInt(capDraft, 10)
    // An unparseable or out-of-range draft resolves to the clamped value rather
    // than being rejected silently; `normalizeChecklistGenerateCap` turns NaN into
    // the default (12) and anything else into 1..200.
    const next = normalizeChecklistGenerateCap(Number.isNaN(parsed) ? undefined : parsed)
    setCapDraft(String(next))
    if (next !== settings.cap) {
      void Promise.resolve(application.setPreference(CHECKLIST_GENERATE_CAP_PREF, next as never)).catch(console.error)
    }
  }, [application, capDraft, settings.cap])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Recurring checklist tasks</Title>
        <div className="mt-2" data-test="checklist-recurrence-settings">
          <div className="flex justify-between gap-2 md:items-center">
            <div className="flex flex-col">
              <Subtitle>Auto-generate missed recurrences</Subtitle>
              <Text>
                A recurring task you fell behind on otherwise skips straight to its next occurrence and the ones it owed
                disappear. With this on, each owed occurrence is written down as a plain dated task beneath it.
              </Text>
            </div>
            <Switch onChange={setAutoGenerate} checked={settings.autoGenerate} />
          </div>
          <HorizontalSeparator classes="my-4" />
          <div>
            <Subtitle>Most occurrences to generate at once</Subtitle>
            <Text>
              An upper bound on one pass, between {CHECKLIST_GENERATE_CAP_MIN} and {CHECKLIST_GENERATE_CAP_MAX}. Older
              occurrences beyond it are not dropped silently — they are recorded as one summary task saying how many
              were missed and when.
            </Text>
            <div className="mt-2">
              <input
                type="number"
                min={CHECKLIST_GENERATE_CAP_MIN}
                max={CHECKLIST_GENERATE_CAP_MAX}
                aria-label="Most occurrences to generate at once"
                data-test="checklist-generate-cap"
                value={capDraft}
                onChange={(event) => setCapDraft(event.currentTarget.value)}
                onBlur={commitCap}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    commitCap()
                  }
                }}
                className="border-border bg-default focus:border-info h-8 w-24 rounded-md border px-2 text-sm focus:outline-none"
              />
            </div>
          </div>
          <Text className="text-passive-0 mt-4">
            Subtasks of a generated occurrence are <strong className="font-semibold">not</strong> reproduced: only the
            live task keeps its subtree, exactly as completing it by hand does. A month-end deadline keeps its own day —
            Jan 31 becomes Feb 28, then Mar 31 — but that intent is not passed down: a subtask that takes up its
            parent's cadence stays anchored on its own date.
          </Text>
          <Text className="text-passive-0 mt-2">
            Both settings are synced to your account, and the same two sit in the editor's Checklists panel, which also
            has a "Generate now" button for the note you are in.
          </Text>
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default ChecklistRecurrence
