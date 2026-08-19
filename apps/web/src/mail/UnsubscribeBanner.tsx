/**
 * The "get off this list" banner (M5.3, FR-RD-09; RFC 2369, RFC 8058).
 *
 * Shown above a message that advertises `List-Unsubscribe`. What it offers depends on what the
 * sender supports, and the wording is the careful part:
 *
 * - **One-click** (the sender opted in with `List-Unsubscribe-Post`): a POST leaves the browser and
 *   the reader is told it was **sent**. It cannot be called "unsubscribed" — a `no-cors` POST comes
 *   back opaque, so the one thing we cannot know is whether the list acted on it.
 * - **Open the page**: an ordinary link, through the same host gate every other link in a message
 *   goes through (FR-RD-08).
 * - **Write to the list**: a `mailto:` seeds a composer, which is the reader's own message and
 *   therefore the one path that is verifiable.
 */

import { MailMinus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui'
import styles from './reading.module.css'
import type { UnsubscribeOffer } from './unsubscribe'

export interface UnsubscribeBannerProps {
  readonly offer: UnsubscribeOffer
  /** Fires the RFC 8058 POST; resolves `true` when the request left the browser. */
  onOneClick: (endpoint: string) => Promise<boolean>
  /** Opens a URL through the reading pane's link gate. */
  onOpen: (url: string) => void
  /** Seeds a composer from a `mailto:` URI. */
  onCompose: (mailto: string) => void
}

type State = 'idle' | 'sending' | 'sent' | 'failed'

export function UnsubscribeBanner(props: UnsubscribeBannerProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<State>('idle')
  const { offer } = props

  const runOneClick = async (endpoint: string): Promise<void> => {
    setState('sending')
    setState((await props.onOneClick(endpoint)) ? 'sent' : 'failed')
  }

  return (
    <section className={styles.remoteBanner} aria-label={t('reading.unsubscribe.title')}>
      <MailMinus aria-hidden="true" className={styles.remoteIcon} />
      <div className={styles.remoteText}>
        <p className={styles.remoteTitle}>{t('reading.unsubscribe.title')}</p>
        <p className={styles.remoteNote}>
          {state === 'sent'
            ? // Deliberately "request sent", not "unsubscribed" — see the note at the top.
              t('reading.unsubscribe.sentNote')
            : state === 'failed'
              ? t('reading.unsubscribe.failedNote')
              : t('reading.unsubscribe.note')}
        </p>
      </div>
      {state !== 'sent' && (
        <div className={styles.remoteActions}>
          {offer.oneClick !== null && (
            <Button
              size="sm"
              variant="secondary"
              loading={state === 'sending'}
              onClick={() => void runOneClick(offer.oneClick as string)}
            >
              {t('reading.unsubscribe.oneClick')}
            </Button>
          )}
          {offer.url !== null && offer.oneClick === null && (
            <Button size="sm" variant="secondary" onClick={() => props.onOpen(offer.url as string)}>
              {t('reading.unsubscribe.open')}
            </Button>
          )}
          {offer.mailto !== null && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => props.onCompose(offer.mailto as string)}
            >
              {t('reading.unsubscribe.email')}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
