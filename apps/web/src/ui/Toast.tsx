import { X } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button'
import { IconButton } from './IconButton'
import { cx } from './internal/cx'
import { Portal } from './internal/Portal'
import styles from './Toast.module.css'

export type ToastTone = 'neutral' | 'success' | 'danger' | 'warning'

export interface ToastOptions {
  title: ReactNode
  description?: ReactNode
  tone?: ToastTone
  /** Auto-dismiss after ms; `0` keeps it until dismissed. Default 5000. */
  duration?: number
  /** An inline action (e.g. Undo); running it also dismisses the toast (M2.8). */
  action?: { readonly label: ReactNode; readonly onAction: () => void }
}

interface ToastRecord extends ToastOptions {
  id: string
}

interface ToastApi {
  /** Show a toast; returns its id. */
  toast: (options: ToastOptions) => string
  dismiss: (id: string) => void
  /**
   * Run the newest pending toast action and dismiss it; `false` when there is none (M4.7).
   *
   * The keyboard route to Undo. The toast region is portalled to the END of the document, so
   * reaching an Undo button by Tab means traversing the rest of the shell — and before this it
   * meant doing so within five seconds. WCAG 2.2.1 either way; this is the half that makes the
   * action reachable at all, and `duration: 0` on action-bearing toasts is the half that removes
   * the time limit.
   */
  runNewestAction: () => boolean
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast must be used within a <ToastProvider>')
  return api
}

const DEFAULT_DURATION = 5000

/**
 * App-wide toast host. Wrap the app once; children call `useToast().toast(...)`. The two live
 * regions (polite for status tones, assertive for danger) are ALWAYS mounted — even with no
 * toasts — because a screen reader only announces a live region whose contents change if the
 * region already existed in the DOM; injecting the region and its text together leaves polite
 * (status) toasts silent on NVDA/JAWS. Auto-dismiss pauses while the pointer is over or focus
 * is within a toast (WCAG 2.2.1), and every toast has a manual dismiss.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const toast = useCallback((options: ToastOptions) => {
    nextId.current += 1
    const id = `toast-${nextId.current}`
    setToasts((current) => [...current, { ...options, id }])
    return id
  }, [])

  /**
   * Newest first: with several toasts on screen the last one raised is the one the user just caused,
   * and so the one an Undo means. Read from a ref rather than state so the shortcut layer can call
   * it without subscribing to every toast render.
   */
  const toastsRef = useRef<ToastRecord[]>([])
  toastsRef.current = toasts

  const runNewestAction = useCallback(() => {
    const withAction = [...toastsRef.current]
      .reverse()
      .find((record) => record.action !== undefined)
    if (withAction?.action === undefined) return false
    withAction.action.onAction()
    dismiss(withAction.id)
    return true
  }, [dismiss])

  const api = useMemo<ToastApi>(
    () => ({ toast, dismiss, runNewestAction }),
    [toast, dismiss, runNewestAction],
  )

  const assertive = toasts.filter((toast) => toast.tone === 'danger')
  const polite = toasts.filter((toast) => toast.tone !== 'danger')

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Portal>
        {/* "Status messages", NOT "Notifications" (B13): the settings screen renders a landmark
            called Notifications for the push preferences, and two landmarks with the same name are
            indistinguishable in a rotor. This region is also not about notifications — it is the
            app talking about what just happened. */}
        <section className={styles.region} aria-label={t('ui.toast.region')}>
          <div className={styles.stack} aria-live="assertive">
            {assertive.map((record) => (
              <ToastItem key={record.id} record={record} onDismiss={dismiss} />
            ))}
          </div>
          <div className={styles.stack} aria-live="polite">
            {polite.map((record) => (
              <ToastItem key={record.id} record={record} onDismiss={dismiss} />
            ))}
          </div>
        </section>
      </Portal>
    </ToastContext.Provider>
  )
}

function ToastItem({
  record,
  onDismiss,
}: {
  record: ToastRecord
  onDismiss: (id: string) => void
}) {
  const { t } = useTranslation()
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const duration = record.duration ?? DEFAULT_DURATION
  const tone = record.tone ?? 'neutral'

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const start = useCallback(() => {
    clear()
    if (duration > 0) timerRef.current = setTimeout(() => onDismiss(record.id), duration)
  }, [clear, duration, onDismiss, record.id])

  useEffect(() => {
    start()
    return clear
  }, [start, clear])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus only pause the auto-dismiss timer (WCAG 2.2.1); announcement is owned by the parent live region
    <div
      className={cx(styles.toast, styles[tone])}
      onMouseEnter={clear}
      onMouseLeave={start}
      onFocus={clear}
      onBlur={start}
    >
      <div className={styles.content}>
        <p className={styles.title}>{record.title}</p>
        {record.description ? <p className={styles.description}>{record.description}</p> : null}
      </div>
      {record.action ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.action}
          onClick={() => {
            record.action?.onAction()
            onDismiss(record.id)
          }}
        >
          {record.action.label}
        </Button>
      ) : null}
      <IconButton
        label={t('ui.toast.dismiss')}
        variant="ghost"
        size="sm"
        className={styles.dismiss}
        onClick={() => onDismiss(record.id)}
      >
        <X aria-hidden="true" />
      </IconButton>
    </div>
  )
}
