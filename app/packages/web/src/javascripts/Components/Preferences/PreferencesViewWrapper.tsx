import { FunctionComponent, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import PreferencesView from './PreferencesView'
import { PreferencesViewWrapperProps } from './PreferencesViewWrapperProps'
import { OPEN_PREFERENCES_COMMAND } from '@standardnotes/ui-services'
import ModalOverlay from '../Modal/ModalOverlay'
import { usePaneSwipeGesture } from '../Panes/usePaneGesture'
import { performSafariAnimationFix } from '../Panes/PaneAnimator'
import { IosModalAnimationEasing } from '../Modal/useModalAnimation'

/**
 * The Preferences dialog's overrides of the shared modal box.
 *
 * The first three make it the full viewport instead of a centred panel. The
 * fourth is a PERFORMANCE fix, not a styling one, and it only makes sense
 * because of the first three.
 *
 * ModalOverlay gives every dialog the translucent-UI backdrop filter, which with
 * that preference on — it is on by default — is a twelve pixel blur plus
 * saturate, contrast and brightness. On an ordinary modal that is a glass panel
 * over the app behind it. On THIS one the box is the whole viewport and every one
 * of its children paints opaquely: the header, the menu column and the content
 * column all carry a solid theme background. So the filter resamples 1.4
 * megapixels of a backdrop nobody can ever see, on every frame of every scroll.
 *
 * Measured in real headless Chrome against this shell and the freshly compiled
 * stylesheets (t116), with the lightest pane the shell can host — twenty cards of a
 * heading and two paragraphs, no data fetching, no timers, no tables — and the same
 * 3600px wheel scroll:
 *
 *   filter present   13.6 fps, 100ms median frame, 23 dropped frames
 *   filter absent    60.0 fps, 16.7ms median frame, 0 dropped frames
 *
 * Scripting, style recalculation and layout were all ~0ms in both, and the scroll
 * forced zero synchronous layout reads either way, so this was never a React or a
 * list-size cost: a 261 element pane and a 2074 element pane both reach 60fps once
 * the filter is gone, and neither does with it. Screenshots taken with and without
 * it differ by 2 pixels out of 1,433,520, maximum channel delta 2 — which is what
 * "a backdrop nobody can ever see" means, measured. (That headless browser
 * rasterizes in software, so the size of the win on a GPU-composited desktop is
 * not what is claimed here; what is claimed is that the cost is paint, that it is
 * independent of the pane, and that removing it changes nothing on screen.)
 *
 * Deliberately scoped to this dialog. Smaller modals really do show their glass,
 * and this changes nothing for them.
 */
const PREFERENCES_DIALOG_CLASSES = 'md:h-full md:!max-h-full md:!w-full md:!border-0 md:!backdrop-filter-none'

const PreferencesViewWrapper: FunctionComponent<PreferencesViewWrapperProps> = ({ application }) => {
  useEffect(() => {
    return application.commands.addWithShortcut(
      OPEN_PREFERENCES_COMMAND,
      'General',
      'Open preferences',
      () => application.preferencesController.openPreferences(),
      'tune',
    )
  }, [application.commands, application.preferencesController])

  const [setElement] = usePaneSwipeGesture('right', async (element) => {
    const animation = element.animate(
      [
        {
          transform: 'translateX(100%)',
          opacity: 0,
        },
      ],
      {
        easing: IosModalAnimationEasing,
        duration: 250,
        fill: 'both',
      },
    )

    await animation.finished

    performSafariAnimationFix(element)

    animation.finish()

    application.preferencesController.closePreferences()
  })

  return (
    <ModalOverlay
      isOpen={application.preferencesController.isOpen}
      ref={setElement}
      animate="mobile"
      animationVariant="horizontal"
      close={application.preferencesController.closePreferences}
      className={PREFERENCES_DIALOG_CLASSES}
    >
      <PreferencesView
        closePreferences={application.preferencesController.closePreferences}
        application={application}
      />
    </ModalOverlay>
  )
}

export default observer(PreferencesViewWrapper)
