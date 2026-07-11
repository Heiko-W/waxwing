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

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss])

  const assertive = toasts.filter((toast) => toast.tone === 'danger')
  const polite = toasts.filter((toast) => toast.tone !== 'danger')

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Portal>
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
