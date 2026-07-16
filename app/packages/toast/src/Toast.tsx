import type { Toast as ToastPropType } from './types'
import { CheckCircleFilledIcon, ClearCircleFilledIcon, CloseIcon, InfoIcon } from '@standardnotes/icons'
import { dismissToast } from './toastStore'
import { ToastType } from './enums'
import {
  CSSProperties,
  ForwardedRef,
  forwardRef,
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  computeReleaseVelocity,
  dampenDx,
  DragSample,
  dragOpacity,
  DRAG_SETTLE_MS,
  isDragActivated,
  shouldDismissOnRelease,
} from './dragToDismiss'

const prefersReducedMotion = () => {
  const mediaQuery = matchMedia('(prefers-reduced-motion: reduce)')
  return mediaQuery.matches
}

const colorForToastType = (type: ToastType) => {
  switch (type) {
    case ToastType.Success:
      return 'bg-success text-info-contrast md:text-success'
    case ToastType.Error:
      return 'bg-danger text-info-contrast md:text-danger'
    default:
      return 'bg-info text-info-contrast md:text-info'
  }
}

const iconForToastType = (type: ToastType) => {
  switch (type) {
    case ToastType.Success:
      return <CheckCircleFilledIcon className="text-success h-5 w-5" />
    case ToastType.Error:
      return <ClearCircleFilledIcon className="text-danger h-5 w-5" />
    case ToastType.Progress:
    case ToastType.Loading:
      return <div className="border-info h-4 w-4 animate-spin rounded-full border border-solid border-r-transparent" />
    default:
      return <InfoIcon className="fill-text h-5 w-5" />
  }
}

type Props = {
  toast: ToastPropType
  index: number
}

type DragPhase = 'idle' | 'dragging' | 'springing' | 'exiting'

type DragState = {
  phase: DragPhase
  dx: number
  opacity: number
}

type GestureState = {
  pointerId: number
  startX: number
  width: number
  activated: boolean
  samples: DragSample[]
}

const IDLE_DRAG: DragState = { phase: 'idle', dx: 0, opacity: 1 }

export const Toast = forwardRef(({ toast, index }: Props, ref: ForwardedRef<HTMLDivElement>) => {
  const icon = toast.icon ?? iconForToastType(toast.type)
  const hasActions = toast.actions && toast.actions.length > 0
  const hasProgress = toast.type === ToastType.Progress && toast.progress !== undefined && toast.progress > -1

  const shouldReduceMotion = prefersReducedMotion()
  const enterAnimation = shouldReduceMotion ? 'fade-in-animation' : 'slide-in-right-animation'
  const exitAnimation = shouldReduceMotion ? 'fade-out-animation' : 'slide-out-left-animation'
  const currentAnimation = toast.dismissed ? exitAnimation : enterAnimation

  // --- drag-right-to-dismiss (pointer events; math lives in dragToDismiss.ts) --
  const gestureRef = useRef<GestureState | null>(null)
  const suppressClickRef = useRef(false)
  const springTimerRef = useRef<number | undefined>(undefined)
  const [drag, setDrag] = useState<DragState>(IDLE_DRAG)
  /**
   * Once a drag has begun we permanently neutralize the CSS enter/exit
   * animations for this toast (their `fill-mode: forwards` transform/opacity
   * would override the inline drag transform) and own opacity inline instead.
   */
  const [hasDragged, setHasDragged] = useState(false)

  const getElement = (): HTMLDivElement | null => {
    return ref && typeof ref !== 'function' ? (ref as RefObject<HTMLDivElement>).current : null
  }

  useEffect(() => {
    return () => {
      if (springTimerRef.current) {
        clearTimeout(springTimerRef.current)
      }
    }
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gestureRef.current) {
      return
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }
    // A new gesture starts clean: never let a stale suppression (e.g. a capture
    // that produced no click) swallow this gesture's click.
    suppressClickRef.current = false
    const element = getElement()
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      width: element ? element.offsetWidth : 0,
      activated: false,
      samples: [{ x: event.clientX, t: event.timeStamp }],
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return
    }
    const dx = event.clientX - gesture.startX
    gesture.samples.push({ x: event.clientX, t: event.timeStamp })
    if (gesture.samples.length > 20) {
      gesture.samples.splice(0, gesture.samples.length - 20)
    }
    if (!gesture.activated) {
      if (!isDragActivated(dx)) {
        return
      }
      gesture.activated = true
      suppressClickRef.current = true
      setHasDragged(true)
      // Capture only once an actual drag begins so plain clicks/taps on the
      // toast body and action buttons keep their normal event targets.
      try {
        getElement()?.setPointerCapture(event.pointerId)
      } catch {
        // Capture is an enhancement; the drag still works without it.
      }
    }
    const dampened = dampenDx(dx)
    setDrag({ phase: 'dragging', dx: dampened, opacity: dragOpacity(dampened, gesture.width) })
  }

  const settleAfterSpring = () => {
    springTimerRef.current = window.setTimeout(() => {
      setDrag((current) => (current.phase === 'springing' ? IDLE_DRAG : current))
    }, DRAG_SETTLE_MS)
  }

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const gesture = gestureRef.current
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return
    }
    gestureRef.current = null
    if (!gesture.activated) {
      return
    }
    const dx = event.clientX - gesture.startX
    const velocity = computeReleaseVelocity(gesture.samples, event.timeStamp)

    if (!cancelled && shouldDismissOnRelease(dx, gesture.width, velocity)) {
      const exitDx = gesture.width > 0 ? gesture.width + 48 : dx + 160
      setDrag({ phase: 'exiting', dx: shouldReduceMotion ? dampenDx(dx) : exitDx, opacity: 0 })
      dismissToast(toast.id)
      return
    }

    if (shouldReduceMotion) {
      setDrag(IDLE_DRAG)
    } else {
      setDrag({ phase: 'springing', dx: 0, opacity: 1 })
      settleAfterSpring()
    }
  }

  const onPointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Before activation there is no pointer capture, so a pointer that leaves
    // the toast would otherwise strand the pending gesture (its pointerup is
    // never delivered here). Once activated, capture keeps events flowing.
    const gesture = gestureRef.current
    if (gesture && !gesture.activated && event.pointerId === gesture.pointerId) {
      gestureRef.current = null
    }
  }

  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    // A completed drag must not double as a click on the body or its buttons.
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
    }
  }

  useEffect(() => {
    if (!ref) {
      return
    }

    const element = (ref as RefObject<HTMLDivElement>).current

    if (element && toast.dismissed) {
      const { scrollHeight, style } = element

      requestAnimationFrame(() => {
        style.minHeight = 'initial'
        style.height = scrollHeight + 'px'
        style.transition = 'all 200ms'

        requestAnimationFrame(() => {
          style.height = '0'
          style.padding = '0'
          style.margin = '0'
        })
      })
    }
  }, [ref, toast.dismissed])

  const isDragActive = drag.phase !== 'idle'
  const dragStyle: CSSProperties = {}
  if (hasDragged) {
    // Neutralize the class-based enter/exit animations (see hasDragged above).
    dragStyle.animation = 'none'
    dragStyle.opacity = toast.dismissed ? 0 : 1
  }
  if (isDragActive) {
    dragStyle.transform = `translateX(${drag.dx}px)`
    dragStyle.opacity = drag.opacity
  }
  const transition =
    drag.phase === 'dragging'
      ? 'none'
      : drag.phase === 'springing' || drag.phase === 'exiting'
        ? shouldReduceMotion
          ? 'none'
          : `transform ${DRAG_SETTLE_MS}ms ease, opacity ${DRAG_SETTLE_MS}ms ease`
        : shouldReduceMotion
          ? undefined
          : 'all 0.2s ease'

  return (
    <div
      data-index={index}
      role="status"
      className={`bg-passive-5 animation-fill-forwards relative mt-3 flex min-w-full select-none flex-col rounded opacity-0 md:min-w-max ${currentAnimation}`}
      style={{
        boxShadow: '0px 4px 12px rgba(0, 0, 0, 0.16)',
        transition,
        animationDelay: !toast.dismissed ? '50ms' : undefined,
        touchAction: 'pan-y',
        ...dragStyle,
      }}
      onClick={() => {
        if (toast.type !== ToastType.Loading && toast.type !== ToastType.Progress) {
          dismissToast(toast.id)
        }
      }}
      onClickCapture={onClickCapture}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endGesture(event, false)}
      onPointerCancel={(event) => endGesture(event, true)}
      onPointerLeave={onPointerLeave}
      ref={ref}
    >
      <button
        type="button"
        aria-label="Dismiss notification"
        className="text-passive-1 hover:bg-passive-3 hover:text-text absolute right-1 top-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded border-0 bg-transparent p-0"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          dismissToast(toast.id)
        }}
      >
        <CloseIcon className="h-3.5 w-3.5 fill-current" />
      </button>
      <div className="grid grid-cols-[min-content_auto] gap-x-2.5 gap-y-1 overflow-hidden py-2.5 pl-3 pr-7">
        {icon ? <div className="sn-icon flex items-center justify-center">{icon}</div> : null}
        {toast.title && <div className="text-text col-start-2 text-sm font-semibold">{toast.title}</div>}
        <div className="text-text col-start-2 text-sm [word-wrap:anywhere]">{toast.message}</div>
        {hasActions && (
          <div className="col-start-2 -mx-1.5 -mb-0.5">
            {toast.actions?.map((action, index) => (
              <button
                className={`hover:bg-passive-3 cursor-pointer rounded border-0 px-[0.45rem] py-1 text-sm font-semibold md:bg-transparent ${colorForToastType(
                  toast.type,
                )} ${index !== 0 ? 'ml-2' : ''}`}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  action.handler(toast.id)
                }}
                key={index}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {hasProgress && (
        <div className="bg-default w-full overflow-hidden rounded rounded-tl-none rounded-tr-none">
          <div
            className="bg-info h-2 rounded rounded-tl-none transition-[width] duration-100"
            role="progressbar"
            style={{
              width: `${toast.progress}%`,
              ...(toast.progress === 100 ? { borderTopRightRadius: 0 } : {}),
            }}
            aria-valuenow={toast.progress}
          />
        </div>
      )}
    </div>
  )
})
