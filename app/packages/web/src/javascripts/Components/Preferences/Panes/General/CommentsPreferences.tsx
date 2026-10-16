import { useApplication } from '@/Components/ApplicationProvider'
import usePreference from '@/Hooks/usePreference'
import Switch from '@/Components/Switch/Switch'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import {
  COMMENT_INDICATORS_PREF_KEY,
  COMMENT_NOTIFY_DEFAULT_PREF_KEY,
  showCommentIndicators,
  notifyOthersByDefault,
} from '@/Comments/CommentPreferences'

export default function CommentsPreferences() {
  const application = useApplication()
  const indicators = showCommentIndicators(usePreference(COMMENT_INDICATORS_PREF_KEY))
  const notify = notifyOthersByDefault(usePreference(COMMENT_NOTIFY_DEFAULT_PREF_KEY))
  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Comments</Title>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <Subtitle>Show comment indicators</Subtitle>
            <Text>Show comment markers in the editor. Comments remain available in the sidebar when hidden.</Text>
          </div>
          <Switch
            checked={indicators}
            onChange={(value) => {
              void application.setPreference(COMMENT_INDICATORS_PREF_KEY, value).catch(console.error)
            }}
          >
            <span className="sr-only">Show comment indicators</span>
          </Switch>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div>
            <Subtitle>Notify other users by default</Subtitle>
            <Text>
              Preselect “Notify other users” for new shared comments and replies. You can change it for each comment.
              Private comments never notify anyone.
            </Text>
          </div>
          <Switch
            checked={notify}
            onChange={(value) => {
              void application.setPreference(COMMENT_NOTIFY_DEFAULT_PREF_KEY, value).catch(console.error)
            }}
          >
            <span className="sr-only">Notify other users by default</span>
          </Switch>
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}
