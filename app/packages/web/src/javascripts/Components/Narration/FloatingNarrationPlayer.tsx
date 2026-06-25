import { observer } from 'mobx-react-lite'
import Icon from '../Icon/Icon'
import { narrationPlayerStore } from './NarrationPlayerStore'

/** mm:ss for a number of seconds; '--:--' for non-finite/unknown durations. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '--:--'
  }
  const total = Math.floor(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Tasteful fixed-position mini audio player for an in-progress narration. Mounted
 * once at the app root; renders nothing unless a narration is active. Reads its
 * state from {@link narrationPlayerStore}.
 */
const FloatingNarrationPlayer = () => {
  const store = narrationPlayerStore

  if (!store.active) {
    return null
  }

  const isPlaying = store.state === 'playing'
  const isPaused = store.state === 'paused'
  const isLoading = store.state === 'loading'
  const canSeek = store.canSeek

  const languageSuffix = store.meta.language ? ` · ${store.meta.language}` : ''
  const title = `${store.meta.noteTitle || 'Note'} — Narration${languageSuffix}`

  return (
    <div
      role="region"
      aria-label="Narration player"
      className="fixed bottom-4 right-4 z-footer-bar-item w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-default p-3 shadow-main"
    >
      <div className="flex items-start gap-2">
        <Icon type="file-music" className="mt-0.5 shrink-0 text-info" size="medium" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={title}>
            {title}
          </div>
          <div className="text-xs text-passive-0">
            {store.meta.backend === 'model' ? 'Model voice' : 'Device voice'}
            {isLoading ? ' · loading…' : ''}
          </div>
        </div>
        <button
          className="shrink-0 rounded p-1 text-passive-0 hover:bg-passive-3 hover:text-text"
          title="Stop narration"
          aria-label="Stop narration"
          onClick={() => store.dismiss()}
        >
          <Icon type="close" size="small" />
        </button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-info text-info-contrast disabled:opacity-50"
          title={isPaused ? 'Resume' : 'Pause'}
          aria-label={isPaused ? 'Resume narration' : 'Pause narration'}
          onClick={() => (isPaused ? store.resume() : store.pause())}
          disabled={isLoading || (!isPlaying && !isPaused)}
        >
          <Icon type={isPaused ? 'play' : 'pause'} size="small" />
        </button>

        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-passive-0">
          {formatTime(store.currentTime)}
        </span>

        <input
          type="range"
          className="min-w-0 flex-1"
          min={0}
          max={canSeek ? store.duration : 1}
          step="any"
          value={canSeek ? Math.min(store.currentTime, store.duration) : 0}
          onChange={(event) => store.seek(Number(event.target.value))}
          disabled={!canSeek}
          aria-label="Seek"
        />

        <span className="w-10 shrink-0 text-xs tabular-nums text-passive-0">
          {canSeek ? formatTime(store.duration) : '--:--'}
        </span>
      </div>

      {store.errorMessage && <p className="mt-2 text-xs text-danger">{store.errorMessage}</p>}
    </div>
  )
}

export default observer(FloatingNarrationPlayer)
