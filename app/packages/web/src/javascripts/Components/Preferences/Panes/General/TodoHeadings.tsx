import { FunctionComponent, useCallback, useMemo } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Switch from '@/Components/Switch/Switch'
import usePreference from '@/Hooks/usePreference'
import {
  TODO_HEADING_DESCRIPTIONS_PREF_KEY,
  TODO_HEADING_LEVELS_PREF_KEY,
  normalizeTodoHierarchyOptions,
  type TodoHierarchyOptions,
} from '@/Components/TodoAggregate/todoHierarchy'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'

type Props = {
  application: WebApplication
}

/**
 * Standard Red Notes: the two heading-derived Todos settings (t111 §3 rows 1-2).
 *
 * A MIRROR of the pair of checkboxes in the Todos filter bar
 * (`Components/TodoAggregate/TodoFilterBar.tsx`, driven by `TodoView`). That bar
 * is where you flip them while looking at the todos they reshape; this card is
 * where you find them when you are not in the Todos view and only remember that
 * such a setting exists.
 *
 * ONE STORED VALUE PER SETTING, NOT TWO. Both surfaces read through the same
 * imported key constants and the same `normalizeTodoHierarchyOptions`, and write
 * with `application.setPreference` to those same keys, so this card holds no
 * state of its own and a change on either surface is the change on both.
 *
 * ## Why the defaults are literals
 * Both ship ON, and both defaults come from `todoHierarchy.ts`
 * (`DEFAULT_TODO_HEADING_LEVELS` / `DEFAULT_TODO_HEADING_DESCRIPTIONS`) by way of
 * the normalizer — never from `PrefDefaults[PrefKey.TodoHeadingLevels]`, which is
 * `undefined` at runtime until the generated models bundle is rebuilt. `undefined`
 * is falsy, so a default read from that table would render both switches OFF
 * while the feature was ON: a control lying about the state it controls.
 *
 * ## Why the second switch can be disabled
 * A description is a property OF a heading section, so with sublevels off there is
 * no section for one to belong to. That dependency is the same one the filter bar
 * enforces, and it is SAID in the copy rather than left as a switch that silently
 * does nothing.
 */
const TodoHeadings: FunctionComponent<Props> = ({ application }) => {
  // Raw stored values; `usePreference`'s own default is `PrefDefaults[key]`, which
  // is `undefined` for both of these, so the normalizer below is what supplies the
  // real (ON) defaults — exactly as `TodoView` does it.
  const storedHeadingLevels = usePreference(TODO_HEADING_LEVELS_PREF_KEY)
  const storedHeadingDescriptions = usePreference(TODO_HEADING_DESCRIPTIONS_PREF_KEY)

  const options = useMemo(
    () =>
      normalizeTodoHierarchyOptions({
        headingLevels: storedHeadingLevels,
        headingDescriptions: storedHeadingDescriptions,
      }),
    [storedHeadingLevels, storedHeadingDescriptions],
  )

  const write = useCallback(
    (next: TodoHierarchyOptions) => {
      void Promise.resolve(application.setPreference(TODO_HEADING_LEVELS_PREF_KEY, next.headingLevels)).catch(
        console.error,
      )
      void Promise.resolve(
        application.setPreference(TODO_HEADING_DESCRIPTIONS_PREF_KEY, next.headingDescriptions),
      ).catch(console.error)
    },
    [application],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Todos from headings</Title>
        <div className="mt-2" data-test="todo-heading-settings">
          <div className="flex justify-between gap-2 md:items-center">
            <div className="flex flex-col">
              <Subtitle>Headings create todo sublevels</Subtitle>
              <Text>
                In the Todos view, a heading in a note opens a section and the tasks under it are nested inside it, up
                to six levels deep. With this off, headings contribute nothing and tasks are listed exactly as the
                checklist nests them.
              </Text>
            </div>
            <Switch
              onChange={(headingLevels) => write({ ...options, headingLevels })}
              checked={options.headingLevels}
            />
          </div>
          <HorizontalSeparator classes="my-4" />
          <div className="flex justify-between gap-2 md:items-center">
            <div className="flex flex-col">
              <Subtitle>Text after a heading is its description</Subtitle>
              <Text>
                The paragraphs immediately following a heading become that section's description, shown as a second
                muted line. A section with no text under it shows no second line at all.
              </Text>
              {!options.headingLevels && (
                // `data-test` on a wrapper, not on <Text>: the shared content
                // primitives take only `className` and `children`.
                <div data-test="todo-heading-descriptions-dependency">
                  <Text className="text-passive-0 mt-1">
                    Turn "Headings create todo sublevels" on first — a description belongs to a heading section, so
                    there is nothing for one to attach to while that is off.
                  </Text>
                </div>
              )}
            </div>
            <Switch
              disabled={!options.headingLevels}
              onChange={(headingDescriptions) => write({ ...options, headingDescriptions })}
              checked={options.headingDescriptions}
            />
          </div>
          <Text className="text-passive-0 mt-2">
            The same two switches sit in the Todos view's filter bar. Both are synced to your account.
          </Text>
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default TodoHeadings
