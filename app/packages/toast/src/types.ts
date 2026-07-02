import type { ReactNode } from 'react'
import { ToastType } from './enums'

export type ToastAction = {
  label: string
  handler: (toastId: Toast['id']) => void
}

type CommonToastProperties = {
  type: ToastType
  title?: string
  message: string
  /**
   * Optional custom icon rendered in place of the default type-derived icon.
   * Additive: when omitted, the toast keeps its standard icon for `type`.
   */
  icon?: ReactNode
  actions?: ToastAction[]
  progress?: number
  autoClose?: boolean
  duration?: number
  pauseOnWindowBlur?: boolean
}

export type Toast = CommonToastProperties & {
  id: string
  dismissed: boolean
}

export type ToastOptions = CommonToastProperties & {
  id?: string
}

export type ToastUpdateOptions = Omit<Partial<ToastOptions>, 'id'>

export type ToastState = {
  toasts: Toast[]
}
