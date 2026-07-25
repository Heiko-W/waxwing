/**
 * Contact import / export dialog (M4.3, FR-CON-06). A lazy chunk (loaded from
 * {@link ./ContactsScreen}) — and the jscontact conversion runtime it drives lives in a SEPARATE lazy
 * chunk still, reached only through {@link ./contact-io}'s dynamic import, so neither the entry nor
 * `ContactsPage` carries it.
 *
 * Two jobs behind one modal:
 *
 *  - **Import** (toolbar only): choose format + target book, pick a `.vcf`/`.json` file, see a summary
 *    (`X to import, Y duplicates, Z skipped lines`) and confirm. Duplicates (preferred email, then
 *    `uid`) are SKIPPED by default; a checkbox keeps both. The skipped-line count from `fromVCard` is
 *    always shown — a partial import must say what it dropped. Each imported card is one `create`.
 *  - **Export**: choose format and download the cards handed in (`exportCards` — the visible list from
 *    the toolbar, or a single card from the detail overflow). The download uses the same object-URL
 *    idiom as the .eml saver ({@link ../mail/use-message-source}).
 *
 * Dependency-injected (books, existing cards, `createCard`) rather than hook-bound, so it is decoupled
 * from the engine and testable in isolation. The two live queries it reads (books, existing cards) are
 * `undefined` until they resolve; every read guards for that (async-seam safety).
 */

import type { ContactCard, Id } from '@waxwing/jmap'
import { type ChangeEvent, useCallback, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AddressBookRow } from '../sync'
import { Button, Checkbox, Dialog, Select } from '../ui'
import type { CardLike } from './contact-fields'
import {
  type ContactFormat,
  ContactImportError,
  type DedupeResult,
  dedupeAgainst,
  exportFilename,
  exportMimeType,
  MAX_IMPORT_CARDS,
  type ParsedImport,
  parseImport,
  serializeExport,
  toContactCard,
} from './contact-io'
import styles from './contacts.module.css'

export interface ContactImportExportDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  /** Address books to choose an import target from; `undefined` while the live query resolves. */
  readonly books: readonly AddressBookRow[] | undefined
  /** All account cards — the dedup source; `undefined` while the live query resolves. */
  readonly existingCards: readonly CardLike[] | undefined
  /** The cards to export: the visible list (toolbar) or a single card (detail overflow). */
  readonly exportCards: readonly ContactCard[]
  /** Filename stem for the download (no extension), e.g. `contacts` or a contact's display name. */
  readonly exportFilenameStem: string
  /** Whether the Import section is offered (toolbar: yes; single-card export: no). */
  readonly allowImport: boolean
  /** The selected/target import book id (used as the default when it is writable). */
  readonly defaultBookId?: Id | undefined
  /** Create one card (Outbox intent). Injected so the dialog stays engine-decoupled. */
  readonly createCard: (card: ContactCard) => Promise<Id> | Id
}

type ParseState =
  | { readonly status: 'idle' }
  | { readonly status: 'parsing' }
  | { readonly status: 'error'; readonly reason: 'invalid' | 'failed' }
  | { readonly status: 'ready'; readonly parsed: ParsedImport; readonly dedupe: DedupeResult }

/** Download a text string as a file, mirroring the .eml saver's deferred-revoke object-URL idiom. */
function downloadText(content: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  // Revoke on the next task, not synchronously — activating `<a download>` only QUEUES the fetch.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function detectFormat(filename: string, fallback: ContactFormat): ContactFormat {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.json')) return 'jscontact'
  if (lower.endsWith('.vcf') || lower.endsWith('.vcard')) return 'vcard'
  return fallback
}

export default function ContactImportExportDialog({
  open,
  onClose,
  books,
  existingCards,
  exportCards,
  exportFilenameStem,
  allowImport,
  defaultBookId,
  createCard,
}: ContactImportExportDialogProps) {
  const { t } = useTranslation()
  const importFormatId = useId()
  const exportFormatId = useId()
  const bookSelectId = useId()

  const writableBooks = useMemo(
    () => (books ?? []).filter((book) => book.myRights.mayWrite),
    [books],
  )

  const [importFormat, setImportFormat] = useState<ContactFormat>('vcard')
  const [exportFormat, setExportFormat] = useState<ContactFormat>('vcard')
  const [targetBookId, setTargetBookId] = useState<Id | undefined>(defaultBookId)
  const [keepDuplicates, setKeepDuplicates] = useState(false)
  const [parseState, setParseState] = useState<ParseState>({ status: 'idle' })
  const [importing, setImporting] = useState(false)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)

  const effectiveBookId = targetBookId ?? writableBooks[0]?.id
  const targetBook = writableBooks.find((book) => book.id === effectiveBookId)

  const ready = parseState.status === 'ready' ? parseState : null
  const willImport = ready
    ? keepDuplicates
      ? ready.dedupe.toCreate.length + ready.dedupe.duplicates.length
      : ready.dedupe.toCreate.length
    : 0
  const cappedImport = Math.min(willImport, MAX_IMPORT_CARDS)

  const onFilePicked = useCallback(
    async (file: File): Promise<void> => {
      const format = detectFormat(file.name, importFormat)
      setImportFormat(format)
      setImportedCount(null)
      setParseState({ status: 'parsing' })
      try {
        const text = await file.text()
        const parsed = await parseImport(text, format)
        const dedupe = dedupeAgainst(parsed.cards, existingCards ?? [])
        setParseState({ status: 'ready', parsed, dedupe })
      } catch (error) {
        setParseState({
          status: 'error',
          reason: error instanceof ContactImportError ? 'invalid' : 'failed',
        })
      }
    },
    [importFormat, existingCards],
  )

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0]
      if (file !== undefined) void onFilePicked(file)
      event.target.value = ''
    },
    [onFilePicked],
  )

  const onConfirmImport = useCallback(async (): Promise<void> => {
    if (ready === null || targetBook === undefined) return
    const chosen = keepDuplicates
      ? [...ready.dedupe.toCreate, ...ready.dedupe.duplicates]
      : ready.dedupe.toCreate
    const cards = chosen.slice(0, MAX_IMPORT_CARDS)
    setImporting(true)
    try {
      for (const card of cards) {
        await createCard(toContactCard(card, targetBook.id))
      }
      setImportedCount(cards.length)
      setParseState({ status: 'idle' })
    } finally {
      setImporting(false)
    }
  }, [ready, targetBook, keepDuplicates, createCard])

  const onExport = useCallback(async (): Promise<void> => {
    setExporting(true)
    try {
      const content = await serializeExport(exportCards, exportFormat)
      downloadText(
        content,
        exportFilename(exportFilenameStem, exportFormat),
        exportMimeType(exportFormat),
      )
    } finally {
      setExporting(false)
    }
  }, [exportCards, exportFormat, exportFilenameStem])

  const formatOptions = (
    <>
      <option value="vcard">{t('contacts.io.format.vcard')}</option>
      <option value="jscontact">{t('contacts.io.format.jscontact')}</option>
    </>
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t(allowImport ? 'contacts.io.title' : 'contacts.io.exportTitle')}
      size="md"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('ui.dialog.close')}
        </Button>
      }
    >
      <div className={styles.io}>
        {allowImport && (
          <section className={styles.ioSection} aria-label={t('contacts.io.import.heading')}>
            <h3 className={styles.ioSectionTitle}>{t('contacts.io.import.heading')}</h3>

            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor={importFormatId}>
                {t('contacts.io.format.label')}
              </label>
              <Select
                id={importFormatId}
                value={importFormat}
                onChange={(event) => setImportFormat(event.target.value as ContactFormat)}
              >
                {formatOptions}
              </Select>
            </div>

            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor={bookSelectId}>
                {t('contacts.io.book.label')}
              </label>
              {writableBooks.length === 0 ? (
                <p className={styles.formHint}>{t('contacts.io.book.none')}</p>
              ) : (
                <Select
                  id={bookSelectId}
                  value={effectiveBookId ?? ''}
                  onChange={(event) => setTargetBookId(event.target.value)}
                >
                  {writableBooks.map((book) => (
                    <option key={book.id} value={book.id}>
                      {book.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>

            <label className={styles.ioFilePick}>
              <span className={styles.formLabel}>{t('contacts.io.import.choose')}</span>
              <input
                type="file"
                accept=".vcf,.vcard,text/vcard,.json,application/json"
                aria-label={t('contacts.io.import.choose')}
                disabled={writableBooks.length === 0 || importing}
                onChange={onFileChange}
              />
            </label>

            {parseState.status === 'parsing' && (
              <p className={styles.formHint}>{t('contacts.io.import.parsing')}</p>
            )}

            {parseState.status === 'error' && (
              <p role="alert" className={styles.formNotice}>
                {t(`contacts.io.error.${parseState.reason}`)}
              </p>
            )}

            {ready !== null &&
              (ready.parsed.cards.length === 0 ? (
                <p className={styles.formHint}>
                  {ready.parsed.skipped > 0
                    ? t('contacts.io.result.skipped', { count: ready.parsed.skipped })
                    : t('contacts.io.result.empty')}
                </p>
              ) : (
                <>
                  <ul className={styles.ioSummary}>
                    <li>{t('contacts.io.result.willImport', { count: willImport })}</li>
                    {ready.dedupe.duplicates.length > 0 && (
                      <li>
                        {t('contacts.io.result.duplicates', {
                          count: ready.dedupe.duplicates.length,
                        })}
                      </li>
                    )}
                    {ready.parsed.skipped > 0 && (
                      <li>{t('contacts.io.result.skipped', { count: ready.parsed.skipped })}</li>
                    )}
                    {willImport > MAX_IMPORT_CARDS && (
                      <li className={styles.formNotice}>
                        {t('contacts.io.result.capped', { max: MAX_IMPORT_CARDS })}
                      </li>
                    )}
                  </ul>

                  {ready.dedupe.duplicates.length > 0 && (
                    <Checkbox
                      label={t('contacts.io.keepBoth')}
                      checked={keepDuplicates}
                      onChange={(event) => setKeepDuplicates(event.target.checked)}
                    />
                  )}

                  <div className={styles.ioActions}>
                    <Button
                      variant="primary"
                      onClick={onConfirmImport}
                      disabled={cappedImport === 0 || targetBook === undefined || importing}
                    >
                      {t('contacts.io.import.confirm', { count: cappedImport })}
                    </Button>
                  </div>
                </>
              ))}

            {importedCount !== null && (
              <p role="status" className={styles.formHint}>
                {t('contacts.io.result.imported', { count: importedCount })}
              </p>
            )}
          </section>
        )}

        {allowImport && <hr className={styles.ioDivider} />}

        <section className={styles.ioSection} aria-label={t('contacts.io.export.heading')}>
          <h3 className={styles.ioSectionTitle}>{t('contacts.io.export.heading')}</h3>
          {exportCards.length === 0 ? (
            <p className={styles.formHint}>{t('contacts.io.export.empty')}</p>
          ) : (
            <>
              <div className={styles.formField}>
                <label className={styles.formLabel} htmlFor={exportFormatId}>
                  {t('contacts.io.format.label')}
                </label>
                <Select
                  id={exportFormatId}
                  value={exportFormat}
                  onChange={(event) => setExportFormat(event.target.value as ContactFormat)}
                >
                  {formatOptions}
                </Select>
              </div>
              <p className={styles.formHint}>
                {t('contacts.io.export.scope', { count: exportCards.length })}
              </p>
              <div className={styles.ioActions}>
                <Button variant="primary" onClick={onExport} disabled={exporting}>
                  {t('contacts.io.export.button')}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </Dialog>
  )
}
