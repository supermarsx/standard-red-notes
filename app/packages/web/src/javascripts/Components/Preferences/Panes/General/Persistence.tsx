import { WebApplication } from '@/Application/WebApplication'
import StyledRadioInput from '@/Components/Radio/StyledRadioInput'
import { useState } from 'react'
import { Title } from '../../PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import {
  STARTUP_BEHAVIOR_KEY,
  STARTUP_VIEW_KEY,
  startupBehavior,
  startupView,
  StartupBehavior,
} from '@/Services/WorkspaceStartup/workspaceState'
import { TABBABLE_PANES } from '@/Controllers/PaneController/ViewTab'

type Props = {
  application: WebApplication
}

export const ShouldPersistNoteStateKey = 'ShouldPersistNoteState'

const Persistence = ({ application }: Props) => {
  const [behavior, setBehavior] = useState(startupBehavior(application.getValue(STARTUP_BEHAVIOR_KEY)))
  const [view, setView] = useState(startupView(application.getValue(STARTUP_VIEW_KEY)))

  const choose = (next: StartupBehavior) => {
    application.setValue(STARTUP_BEHAVIOR_KEY, next)
    application.setValue(ShouldPersistNoteStateKey, next === 'resume')
    setBehavior(next)
  }

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title className="mb-2">When opening the app, show...</Title>
        {(
          [
            ['resume', 'Resume my last work with all open tabs'],
            ['new-note', 'A new note'],
            ['view', 'A specific view'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="mb-2 flex items-center gap-2 text-base font-medium md:text-sm">
            <StyledRadioInput name="state-persistence" checked={behavior === value} onChange={() => choose(value)} />
            {label}
          </label>
        ))}
        {behavior === 'view' && (
          <label className="flex items-center gap-2">
            Startup view
            <select
              aria-label="Startup view"
              value={view}
              onChange={(event) => {
                const next = startupView(event.target.value)
                setView(next)
                application.setValue(STARTUP_VIEW_KEY, next)
              }}
            >
              {TABBABLE_PANES.map((pane) => (
                <option key={pane.paneId} value={pane.paneId}>
                  {pane.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default Persistence
