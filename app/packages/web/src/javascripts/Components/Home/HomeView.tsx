import { forwardRef, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType, isNote, SNNote, VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { HomeCard, HomeConfig, loadHomeConfig, pruneMissingTargets, saveHomeConfig } from './homeConfigStorage'
import {
  defaultIconForCard,
  defaultLabelForCard,
  openHomeNote,
  resolveHomeCardTarget,
  runHomeCard,
} from './runHomeCard'
import HomeCustomizeEditor from './HomeCustomizeEditor'

type Props = {
  application: WebApplication
  className?: string
  id: string
  children?: ReactNode
}

const RECOMPUTE_THROTTLE_MS = 1000

/** A single themed tile in the cards grid. Skips rendering if its target is gone. */
const HomeCardTile = observer(
  ({
    application,
    card,
    onActivate,
  }: {
    application: WebApplication
    card: HomeCard
    onActivate: (card: HomeCard) => void
  }) => {
    const target = resolveHomeCardTarget(application, card)
    if (!target) {
      // Deleted-target handling: silently skip so the grid stays clean.
      return null
    }
    const icon = (card.icon as VectorIconNameOrEmoji) || defaultIconForCard(card)
    const label = card.label || defaultLabelForCard(application, card)
    return (
      <button
        className="flex flex-col items-start gap-2 rounded-md border border-border bg-default p-4 text-left shadow-sm hover:bg-contrast focus:bg-contrast focus:outline-none"
        onClick={() => onActivate(card)}
      >
        <Icon type={icon} className="flex-shrink-0 text-info" size="medium" />
        <span className="truncate text-sm font-semibold text-text">{label}</span>
        <span className="text-xs text-passive-1">{card.kind === 'note' ? 'Note' : 'Tag / view'}</span>
      </button>
    )
  },
)
HomeCardTile.displayName = 'HomeCardTile'

const HomeView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const { presentPane, removePane } = useResponsiveAppPane()

  const [config, setConfig] = useState<HomeConfig>(() => loadHomeConfig())
  const [isEditing, setIsEditing] = useState(false)
  // Bumps to force a re-derive of resolved targets when items change.
  const [, setItemsRevision] = useState(0)

  // Persist any change live + keep local state in sync.
  const updateConfig = useCallback((next: HomeConfig) => {
    setConfig(next)
    saveHomeConfig(next)
  }, [])

  // Recompute derived data (and prune deleted targets) on item/sync changes, throttled.
  useEffect(() => {
    let throttleTimeout: ReturnType<typeof setTimeout> | undefined
    let pending = false

    const recompute = () => {
      pending = false
      setItemsRevision((revision) => revision + 1)
    }

    const schedule = () => {
      if (throttleTimeout) {
        pending = true
        return
      }
      recompute()
      throttleTimeout = setTimeout(() => {
        throttleTimeout = undefined
        if (pending) {
          recompute()
        }
      }, RECOMPUTE_THROTTLE_MS)
    }

    const removeItemObserver = application.items.streamItems(
      [ContentType.TYPES.Note, ContentType.TYPES.Tag, ContentType.TYPES.SmartView],
      () => schedule(),
    )
    const removeSyncObserver = application.addEventObserver(async () => {
      schedule()
    }, ApplicationEvent.CompletedFullSync)

    return () => {
      removeItemObserver()
      removeSyncObserver()
      if (throttleTimeout) {
        clearTimeout(throttleTimeout)
      }
    }
  }, [application])

  const homeNote = useMemo<SNNote | undefined>(() => {
    if (config.mode !== 'note' || !config.noteUuid) {
      return undefined
    }
    const item = application.items.findItem(config.noteUuid)
    return item && isNote(item) ? item : undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application, config.mode, config.noteUuid])

  const activateCard = useCallback(
    (card: HomeCard) => {
      // runHomeCard handles navigation + pane layout itself:
      // - note cards open the note (PaneLayout.Editing)
      // - tag cards select the tag/folder/view (PaneLayout.ItemSelection)
      // The Home pane is the rightmost main column, so it is naturally replaced.
      void runHomeCard(application, card)
    },
    [application],
  )

  const openHomeNoteInEditor = useCallback(
    (note: SNNote) => {
      void openHomeNote(application, note)
      presentPane(AppPaneId.Editor)
    },
    [application, presentPane],
  )

  const renderBody = () => {
    if (isEditing) {
      return (
        <HomeCustomizeEditor
          application={application}
          config={config}
          onChange={updateConfig}
          onDone={() => {
            // Prune any cards / home note whose target vanished while editing.
            const exists = (uuid: string) => application.items.findItem(uuid) !== undefined
            updateConfig(pruneMissingTargets(config, exists))
            setIsEditing(false)
          }}
        />
      )
    }

    if (config.mode === 'note') {
      if (!homeNote) {
        return (
          <div className="rounded-md border border-border bg-default px-4 py-8 text-center text-sm text-passive-1">
            No home note is set (or it was deleted). Use “Customize home” to pick one.
          </div>
        )
      }
      const text = homeNote.text || ''
      return (
        <article className="rounded-md border border-border bg-default p-6">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h1 className="truncate text-xl font-bold text-text">{homeNote.title || 'Untitled note'}</h1>
            <button
              className="flex flex-shrink-0 items-center gap-1.5 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:brightness-125"
              onClick={() => openHomeNoteInEditor(homeNote)}
            >
              <Icon type="pencil" size="small" />
              Open in editor
            </button>
          </div>
          {text.trim().length === 0 ? (
            <div className="text-sm text-passive-1">This note is empty.</div>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text">{text}</pre>
          )}
        </article>
      )
    }

    if (config.mode === 'cards') {
      if (config.cards.length === 0) {
        return (
          <div className="rounded-md border border-border bg-default px-4 py-8 text-center text-sm text-passive-1">
            No cards yet. Use “Customize home” to add note and tag cards.
          </div>
        )
      }
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {config.cards.map((card) => (
            <HomeCardTile key={card.id} application={application} card={card} onActivate={activateCard} />
          ))}
        </div>
      )
    }

    // default mode
    return (
      <div className="flex flex-col items-center justify-center rounded-md border border-border bg-default px-4 py-16 text-center">
        <Icon type="window" className="mb-3 text-info" size="large" />
        <h1 className="text-lg font-bold text-text">Welcome home</h1>
        <p className="mt-1 max-w-md text-sm text-passive-1">
          Make this page yours: pin a note as your landing page, or build a grid of cards that jump straight to your
          favorite notes, folders, and views.
        </p>
        <button
          className="mt-4 rounded bg-info px-4 py-2 text-sm font-semibold text-info-contrast hover:brightness-125"
          onClick={() => setIsEditing(true)}
        >
          Customize home
        </button>
      </div>
    )
  }

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'flex h-full flex-col overflow-hidden border-l border-border bg-default')}
    >
      <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="window" className="flex-shrink-0 text-info" />
          <span className="text-base font-bold">Home</span>
        </div>
        <div className="flex items-center gap-1">
          {!isEditing && (
            <button
              className="flex items-center gap-1.5 rounded px-2 py-1 text-sm hover:bg-default"
              onClick={() => setIsEditing(true)}
              title="Customize home"
            >
              <Icon type="tune" size="small" />
              Customize
            </button>
          )}
          <button
            className="rounded p-1 hover:bg-default"
            onClick={() => removePane(AppPaneId.Home)}
            aria-label="Close home"
            title="Close"
          >
            <Icon type="menu-close" />
          </button>
        </div>
      </div>

      <div className="flex-grow overflow-y-auto p-4">{renderBody()}</div>
      {children}
    </div>
  )
})

HomeView.displayName = 'HomeView'

export default observer(HomeView)
