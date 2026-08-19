/**
 * Importing `.eml` files into a folder (M5.3, FR-MBX-06).
 *
 * A lazy chunk: restoring an archived message is a rare, deliberate act, and nobody should carry
 * the code for it at first paint.
 *
 * Files are imported one at a time rather than in one batch call. It costs a round trip per file
 * and buys the thing that matters when a restore goes wrong: a per-file result. A batch that
 * half-fails leaves the reader knowing only that "something" did not import.
 */

import { useCallback, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog } from '../ui'
import type { EmlImporter, ImportFailure, ImportOutcome } from './eml-import'
import { looksLikeEml, MAX_EML_BYTES } from './eml-import'
import styles from './reading.module.css'

export interface EmlImportDialogProps {
  readonly folderName: string
  readonly mailboxId: string
  readonly importer: EmlImporter
  onClose: () => void
}

type Phase = 'picking' | 'importing' | 'done'

/** Spelled out, not computed: the i18n guard only sees literal keys. */
function failureText(t: (key: string) => string, failure: ImportFailure): string {
  switch (failure) {
    case 'tooLarge':
      return t('mailbox.import.error.tooLarge')
    case 'alreadyExists':
      return t('mailbox.import.error.alreadyExists')
    case 'invalidEmail':
      return t('mailbox.import.error.invalidEmail')
    case 'overQuota':
      return t('mailbox.import.error.overQuota')
    case 'notFound':
      return t('mailbox.import.error.notFound')
    case 'uploadFailed':
      return t('mailbox.import.error.uploadFailed')
    case 'rejected':
      return t('mailbox.import.error.rejected')
  }
}

export default function EmlImportDialog(props: EmlImportDialogProps) {
  const { t } = useTranslation()
  const inputId = useId()
  const [phase, setPhase] = useState<Phase>('picking')
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const abortRef = useRef(new AbortController())

  const onFiles = useCallback(
    async (fileList: FileList): Promise<void> => {
      const files = [...fileList]
      // A file that is plainly not a message is rejected here rather than uploaded and refused by
      // the server — same answer, one round trip and several megabytes cheaper.
      const usable = files.filter(looksLikeEml)
      setSkipped(files.filter((file) => !looksLikeEml(file)).map((file) => file.name))
      if (usable.length === 0) {
        setPhase('done')
        return
      }

      setPhase('importing')
      const results: ImportOutcome[] = []
      for (const file of usable) {
        results.push(await props.importer.importOne(file, props.mailboxId, abortRef.current.signal))
        // Reported as they land, so a long restore shows progress rather than a frozen dialog.
        setOutcomes([...results])
      }
      setPhase('done')
    },
    [props.importer, props.mailboxId],
  )

  const imported = outcomes.filter((outcome) => outcome.failure === null)
  const failed = outcomes.filter((outcome) => outcome.failure !== null)

  return (
    <Dialog
      open
      onClose={() => {
        abortRef.current.abort()
        props.onClose()
      }}
      size="md"
      title={t('mailbox.import.title', { folder: props.folderName })}
      footer={
        <Button
          variant={phase === 'done' ? 'primary' : 'secondary'}
          onClick={() => {
            abortRef.current.abort()
            props.onClose()
          }}
        >
          {phase === 'done' ? t('mailbox.import.close') : t('mailbox.import.cancel')}
        </Button>
      }
    >
      <div className={styles.importBody}>
        {phase === 'picking' && (
          <>
            <label className={styles.importPick} htmlFor={inputId}>
              {t('mailbox.import.pick')}
            </label>
            <input
              id={inputId}
              type="file"
              accept=".eml,message/rfc822"
              multiple
              onChange={(event) => {
                const files = event.target.files
                if (files !== null && files.length > 0) void onFiles(files)
                // Cleared so picking the same file again re-fires `change`.
                event.target.value = ''
              }}
            />
            <p className={styles.importHint}>
              {t('mailbox.import.hint', { size: Math.round(MAX_EML_BYTES / (1024 * 1024)) })}
            </p>
          </>
        )}

        {phase === 'importing' && (
          <p role="status" className={styles.importHint}>
            {t('mailbox.import.progress', { done: outcomes.length })}
          </p>
        )}

        {phase === 'done' && (
          <div role="status">
            <p className={styles.importHint}>
              {t('mailbox.import.imported', { count: imported.length })}
            </p>
            {skipped.length > 0 && (
              <p className={styles.importHint}>
                {t('mailbox.import.skipped', { files: skipped.join(', ') })}
              </p>
            )}
            {failed.length > 0 && (
              <ul className={styles.importFailures}>
                {failed.map((outcome) => (
                  <li key={outcome.filename}>
                    {outcome.filename} — {failureText(t, outcome.failure as ImportFailure)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
