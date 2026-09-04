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
import { type ChangeEvent, useCallback, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AddressBookRow } from '../sync'
import { Button, Checkbox, Dialog, SectionLabel, Select } from '../ui'
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
  /**
   * Create a BLOCK of cards (one Outbox intent each). Injected so the dialog stays engine-decoupled.
   *
   * A block and not a card, because it was a card: 500 separate creates meant 500 Dexie
   * transactions, and every commit re-ran the shared whole-table contact-card subscription (R-21).
   * Measured on fake-indexeddb, importing 500 cards into a book that already held 500 took 15.4 s;
   * in blocks of {@link IMPORT_BLOCK} it takes 450 ms (N-04). The dispatcher still writes one
   * outbox row per card, so a card the server refuses is refused alone.
   */
  readonly createCards: (cards: readonly ContactCard[]) => Promise<readonly Id[]> | readonly Id[]
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

/**
 * How many cards go into one replica commit.
 *
 * Fifty rather than "all of them", and the reason is the progress bar. One commit for the whole
 * import is the fastest thing measured (180 ms for 500) but it moves the bar once, from nothing to
 * done, and a Cancel during it can only be honoured after everything is already written. Fifty
 * costs about 45 ms per block on the slowest fixture measured, so the bar advances twenty times
 * over a full 1 000-card import and a Cancel lands within a frame or two — while still collapsing
 * 500 live-query reruns into ten (N-04).
 */
const IMPORT_BLOCK = 50

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
  createCards,
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
  /*
   * How far the import has got, and a way to stop it.
   *
   * The loop below creates one card per round trip and used to report only afterwards, so a 500-card
   * vCard file was a spinner for a minute or more with no way to tell a slow import from a stalled
   * one and no way out of it. HIG `progress-indicators`: "When possible, use a determinate progress
   * indicator. An indeterminate progress indicator shows that a process is occurring, but it doesn't
   * help people estimate how long a task will take"; and "When it's feasible, let people halt
   * processing. If people can interrupt a process without causing negative side effects, include a
   * Cancel button."
   *
   * The side effect here is real and is therefore SAID rather than hidden: the cards already created
   * stay created. Cancel means "stop", not "undo".
   */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  /*
   * An import that STOPPED, and how far it had got.
   *
   * `onConfirmImport` was a `try/finally` with no `catch` — the same shape `onExport` had before
   * R-55 and for the same cost: a throw from the dispatch (the replica transaction failing, the
   * engine gone) left an unhandled rejection in the console, `importedCount` unset, and NOTHING on
   * screen. The reader watched a progress bar disappear and was told neither that it had stopped
   * nor how many of their contacts had arrived.
   *
   * The cards already written STAY written — this is not rolled back. A block is one replica
   * commit (N-04), so the count below is exact rather than approximate, and rolling back work the
   * server may already have accepted would be a second, larger failure dressed as tidiness. The
   * file is spent (`parseState` goes back to idle), and picking it again is a real way forward:
   * every card written carries its source `uid` and emails, so `dedupeAgainst` classifies it as a
   * duplicate and the second pass offers only the remainder.
   */
  const [importFailed, setImportFailed] = useState<{ done: number; total: number } | null>(null)
  const cancelledRef = useRef(false)
  const [exporting, setExporting] = useState(false)
  /*
   * Whether the last Download attempt failed.
   *
   * `onExport` used to be a `try/finally` with no `catch`, so a throw anywhere below it — the
   * converter hitting a card the server had left without a `uid` was the real one — became an
   * unhandled rejection in the console and NOTHING on screen. The reader pressed Download and the
   * dialog sat there unchanged. A failure the app cannot explain is still a failure it has to name.
   */
  const [exportFailed, setExportFailed] = useState(false)

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
      setImportFailed(null)
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
    cancelledRef.current = false
    setImportedCount(null)
    setImportFailed(null)
    setProgress({ done: 0, total: cards.length })
    let done = 0
    try {
      for (let at = 0; at < cards.length; at += IMPORT_BLOCK) {
        // Checked BEFORE the write, so Cancel never leaves a half-written BLOCK and the count the
        // dialog reports is the count the address book actually holds. A block is one replica
        // commit, so this is the finest grain at which that promise can still be kept.
        if (cancelledRef.current) break
        const block = cards.slice(at, at + IMPORT_BLOCK).map((c) => toContactCard(c, targetBook.id))
        await createCards(block)
        done += block.length
        setProgress({ done, total: cards.length })
        // Back to the event loop between blocks: the progress bar has to actually move, and a
        // Cancel has to be able to arrive. Without it the whole import is one uninterrupted task.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      setImportedCount(done)
      setParseState({ status: 'idle' })
    } catch {
      // Said, not swallowed, and said with the two numbers that matter. `done` counts COMMITTED
      // blocks only — the block that threw rolled back whole — so "X of Y" is a fact about the
      // address book and not an estimate.
      setImportFailed({ done, total: cards.length })
      setParseState({ status: 'idle' })
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }, [ready, targetBook, keepDuplicates, createCards])

  const onExport = useCallback(async (): Promise<void> => {
    setExporting(true)
    setExportFailed(false)
    try {
      const content = await serializeExport(exportCards, exportFormat)
      downloadText(
        content,
        exportFilename(exportFilenameStem, exportFormat),
        exportMimeType(exportFormat),
      )
    } catch {
      setExportFailed(true)
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
            <SectionLabel>{t('contacts.io.import.heading')}</SectionLabel>

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

                  {/* Determinate, because the total IS known: the loop is one round trip per card
                      over a list it already holds. `<progress>` rather than a bar of our own — it
                      carries the value to assistive tech without an ARIA translation, and it is the
                      element the two storage readouts in this app already use. */}
                  {progress !== null && (
                    <div className={styles.importProgress}>
                      <progress
                        value={progress.done}
                        max={progress.total}
                        aria-label={t('contacts.io.import.progressLabel')}
                      />
                      <span className={styles.formHint}>
                        {t('contacts.io.import.progress', {
                          done: progress.done,
                          total: progress.total,
                        })}
                      </span>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          cancelledRef.current = true
                        }}
                      >
                        {t('contacts.io.import.cancel')}
                      </Button>
                    </div>
                  )}
                </>
              ))}

            {importedCount !== null && (
              <p role="status" className={styles.formHint}>
                {t('contacts.io.result.imported', { count: importedCount })}
              </p>
            )}

            {/* `alert`, not `status`: this contradicts what the reader asked for, and the next step
                (choose the file again) is theirs to take. */}
            {importFailed !== null && (
              <p role="alert" className={styles.formNotice}>
                {t('contacts.io.result.importFailed', {
                  done: importFailed.done,
                  total: importFailed.total,
                })}
              </p>
            )}
          </section>
        )}

        {allowImport && <hr className={styles.ioDivider} />}

        <section className={styles.ioSection} aria-label={t('contacts.io.export.heading')}>
          <SectionLabel>{t('contacts.io.export.heading')}</SectionLabel>
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
                  onChange={(event) => {
                    // Changing the format is the next step the message offers, so it retires it.
                    setExportFailed(false)
                    setExportFormat(event.target.value as ContactFormat)
                  }}
                >
                  {formatOptions}
                </Select>
              </div>
              <p className={styles.formHint}>
                {t('contacts.io.export.scope', { count: exportCards.length })}
              </p>
              {exportFailed && (
                <p role="alert" className={styles.formNotice}>
                  {t('contacts.io.error.export')}
                </p>
              )}
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
