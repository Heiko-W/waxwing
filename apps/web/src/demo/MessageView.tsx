import { useTranslation } from 'react-i18next'
import { formatBytes } from '../i18n/formatters'
import styles from './demo.module.css'

/** A flattened attachment row (mapped from an EmailBodyPart in the container). */
export interface AttachmentRow {
  key: string
  blobId: string | null
  type: string
  name: string | null
  size: number
  /** `type === 'message/rfc822'` — offers the Email/parse button (the SP.5 answer). */
  isMessage: boolean
}

/** The result of an Email/parse call on a message/rfc822 attachment. */
export interface ParsedMessage {
  subject: string | null
  from: string
  text: string
}

export interface MessageViewProps {
  subject: string | null
  from: string
  to: string
  /** Localized received date. */
  date: string
  textBody: string
  htmlBody: string
  mode: 'html' | 'text'
  onToggleMode: (mode: 'html' | 'text') => void
  attachments: AttachmentRow[]
  onDownload: (attachment: AttachmentRow) => void
  onParse: (attachment: AttachmentRow) => void
  /** Parsed results keyed by AttachmentRow.key. */
  parsed: Record<string, ParsedMessage>
  /** Pretty-printed raw Email JSON. */
  rawJson: string
  busy: boolean
}

/** Presentational message view. */
export function MessageView(props: MessageViewProps) {
  const { t } = useTranslation()
  const hasHtml = props.htmlBody.length > 0
  const hasText = props.textBody.length > 0

  return (
    <article className={styles.message} aria-labelledby="demo-message-subject">
      <header className={styles.messageHead}>
        <h2 id="demo-message-subject" className={styles.cardHeading}>
          {props.subject || t('demo.list.noSubject')}
        </h2>
        <dl className={styles.headers}>
          <dt>{t('demo.message.from')}</dt>
          <dd>{props.from || t('demo.list.noSender')}</dd>
          <dt>{t('demo.message.to')}</dt>
          <dd>{props.to}</dd>
          <dt>{t('demo.message.date')}</dt>
          <dd>{props.date}</dd>
        </dl>
      </header>

      <fieldset className={styles.modeToggle} aria-label={t('demo.message.bodyMode')}>
        <button
          type="button"
          className={styles.secondary}
          aria-pressed={props.mode === 'html'}
          disabled={!hasHtml}
          onClick={() => props.onToggleMode('html')}
        >
          {t('demo.message.showHtml')}
        </button>
        <button
          type="button"
          className={styles.secondary}
          aria-pressed={props.mode === 'text'}
          disabled={!hasText}
          onClick={() => props.onToggleMode('text')}
        >
          {t('demo.message.showText')}
        </button>
      </fieldset>

      {props.mode === 'html' ? (
        hasHtml ? (
          // NAIVE isolation only — the real sanitizer + iframe renderer is @waxwing/mail-html
          // (WP M1.7): DOMPurify pipeline, remote-content blocking, cid: rewriting, per-frame
          // CSP. Here we merely drop the raw server HTML into a maximally-sandboxed iframe:
          // sandbox="" means NO allow-scripts and NO allow-same-origin, so scripts never run
          // and the frame cannot reach this origin. Do NOT copy this for production reading.
          <iframe
            className={styles.htmlFrame}
            sandbox=""
            srcDoc={props.htmlBody}
            title={t('demo.message.htmlBody')}
          />
        ) : (
          <p className={styles.hint}>{t('demo.message.noBody')}</p>
        )
      ) : hasText ? (
        <pre className={styles.textBody}>{props.textBody}</pre>
      ) : (
        <p className={styles.hint}>{t('demo.message.noBody')}</p>
      )}

      {props.attachments.length > 0 && (
        <section className={styles.attachments} aria-label={t('demo.message.attachments')}>
          <h3 className={styles.cardHeading}>{t('demo.message.attachments')}</h3>
          <ul className={styles.plainList}>
            {props.attachments.map((attachment) => {
              const parsed = props.parsed[attachment.key]
              return (
                <li key={attachment.key} className={styles.attachment}>
                  <div className={styles.attachmentRow}>
                    <span className={styles.attachmentName}>
                      {attachment.name || attachment.type}
                    </span>
                    <span className={styles.tag}>{attachment.type}</span>
                    <span className={styles.attachmentSize}>{formatBytes(attachment.size)}</span>
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() => props.onDownload(attachment)}
                      disabled={props.busy || attachment.blobId === null}
                    >
                      {t('demo.message.download')}
                    </button>
                    {attachment.isMessage && (
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => props.onParse(attachment)}
                        disabled={props.busy || attachment.blobId === null}
                      >
                        {t('demo.message.parse')}
                      </button>
                    )}
                  </div>
                  {parsed && (
                    <div className={styles.parsed}>
                      <h4 className={styles.parsedHeading}>{t('demo.message.parsedHeading')}</h4>
                      <dl className={styles.headers}>
                        <dt>{t('demo.message.parsedSubject')}</dt>
                        <dd>{parsed.subject || t('demo.list.noSubject')}</dd>
                        <dt>{t('demo.message.from')}</dt>
                        <dd>{parsed.from || t('demo.list.noSender')}</dd>
                      </dl>
                      <pre className={styles.textBody}>{parsed.text}</pre>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <details className={styles.raw}>
        <summary>{t('demo.message.raw')}</summary>
        <pre className={styles.rawJson}>{props.rawJson}</pre>
      </details>
    </article>
  )
}
