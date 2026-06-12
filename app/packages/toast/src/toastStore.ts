import { nanoid } from 'nanoid'
import { atom } from 'nanostores'
import { Toast, ToastOptions, ToastUpdateOptions } from './types'

export const toastStore = atom<Toast[]>([])

export const updateToast = (toastId: Toast['id'], options: ToastUpdateOptions): void => {
  const existingToasts = toastStore.get()
  toastStore.set(
    existingToasts.map((toast) => {
      if (toast.id === toastId) {
        return {
          ...toast,
          ...options,
        }
      } else {
        return toast
      }
    }),
  )
}

const removeToast = (toastId: Toast['id']): void => {
  const existingToasts = toastStore.get()
  toastStore.set(existingToasts.filter((toast) => toast.id !== toastId))
}

const DelayBeforeRemovingToast = 175

export const dismissToast = (toastId: Toast['id']): void => {
  const existingToasts = toastStore.get()
  toastStore.set(
    existingToasts.map((toast) => {
      if (toast.id === toastId) {
        return {
          ...toast,
          dismissed: true,
        }
      } else {
        return toast
      }
    }),
  )
  setTimeout(() => {
    removeToast(toastId)
  }, DelayBeforeRemovingToast)
}

export const addToast = (options: ToastOptions): Toast['id'] => {
  const existingToasts = toastStore.get()
  const isToastIdDuplicate = existingToasts.findIndex((toast) => toast.id === options.id) > -1

  const id = options.id && !isToastIdDuplicate ? options.id : nanoid()

  if (isToastIdDuplicate) {
    console.warn(`Generated new ID for toast instead of overriding toast of ID "${options.id}".
If you want to update an existing toast, use the \`updateToast()\` function instead.`)
  }

  const toast: Toast = {
    ...options,
    id,
    dismissed: false,
    pauseOnWindowBlur: options.pauseOnWindowBlur ?? true,
  }

  toastStore.set([...existingToasts, toast])

  return id
}
