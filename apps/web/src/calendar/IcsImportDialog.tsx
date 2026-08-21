/**
 * Importing a `.ics` file (K-4, FR-CAL-01) — a lazy chunk of its own.
 *
 * Two steps, and the first one is not optional: **pick, preview, then import**. A calendar file
 * routinely holds more than one event — a whole year of a shared schedule arrives as one file — and
 * an importer that adds everything on the press of a button gives the reader no moment at which to
 * see what is about to happen. So the file is parsed first (by the SERVER: `CalendarEvent/parse`,
 * see `ics-import.ts`), every event in it is listed with its date, and each one can be unticked.
 *
 * **The list is the test.** A blob with two VEVENTs has to produce two rows; a client that reads the
 * parse answer as an object rather than an array shows one and loses the other with no error
 * anywhere. That is the failure this screen exists to make visible.
 *
 * **Importing the same file twice is not an error.** The server refuses a duplicate `uid` per
 * object — `"An event with UID … already exists."` — so the outcome is counted, not thrown: "3
 * added, 2 already in your calendar". Reporting that as a failure would teach the reader to
 * distrust an importer that is doing exactly the right thing.
 *
 * **There is no export beside it**, and that is measured rather than deferred: over JMAP an event
 * has no `iCalendar` property, no blob and no download URL, and `CalendarEvent/export` does not
 * exist. The only export possible here would be a serialiser written in this bundle, lossy in
 * precisely the properties this client does not model. See `ics-import.ts`.
 */

import type { Calendar } from '@waxwing/jmap'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '../i18n/formatters'
import { Button, Dialog, Select, useToast } from '../ui'
import styles from './calendar.module.css'
import { type CalendarClient, refusalReason } from './calendar-client'
import type { ImportCandidate } from './ics-import'
import { localToInstant } from './jscalendar-time'

export interface IcsImportDialogProps {
  readonly client: CalendarClient | null
  readonly calendars: readonly Calendar[]
  onClose: () => void
  onImported: () => void
}

export default function IcsImportDialog(props: IcsImportDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const fileId = useId()
  const calendarId = useId()
  const [candidates, setCandidates] = useState<readonly ImportCandidate[] | null>(null)
  /** Which rows are ticked. Everything the file held starts ticked — that is what "import" means. */
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [calendar, setCalendar] = useState(
    () => props.calendars.find((entry) => entry.isDefault)?.id ?? props.calendars[0]?.id ?? '',
  )

  async function read(file: File): Promise<void> {
    const client = props.client
    if (client === null) return
    setBusy(true)
    setProblem(null)
    try {
      const parsed = await client.parseIcs(file)
      setCandidates(parsed)
      setChosen(new Set(parsed.map((entry) => entry.key)))
      // An empty answer is a real outcome, not a crash: a `.ics` holding only a VTODO or a
      // VFREEBUSY parses fine and contains no event. Said plainly rather than shown as an empty box.
      if (parsed.length === 0) setProblem(t('calendar.import.empty'))
    } catch (error) {
      setProblem(refusalReason(error) ?? t('calendar.import.unreadable'))
      setCandidates(null)
    } finally {
      setBusy(false)
    }
  }

  async function run(): Promise<void> {
    const client = props.client
    if (client === null || candidates === null || calendar === '') return
    setBusy(true)
    try {
      const outcome = await client.importEvents(
        candidates.filter((entry) => chosen.has(entry.key)),
        calendar,
      )
      toast({
        tone: outcome.failed > 0 ? 'danger' : 'success',
        title: t('calendar.import.done', { count: outcome.added }),
        ...(outcome.duplicates > 0 || outcome.failed > 0
          ? {
              description: [
                outcome.duplicates > 0
                  ? t('calendar.import.duplicates', { count: outcome.duplicates })
                  : null,
                outcome.reason,
              ]
                .filter((line) => line !== null)
                .join(' '),
            }
          : {}),
      })
      props.onImported()
    } catch (error) {
      setProblem(refusalReason(error) ?? t('calendar.import.failed'))
    } finally {
      setBusy(false)
    }
  }

  const selected = candidates?.filter((entry) => chosen.has(entry.key)).length ?? 0

  return (
    <Dialog open onClose={props.onClose} size="md" title={t('calendar.import.title')}>
      <div className={styles.eventForm}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={fileId}>
            {t('calendar.import.file')}
          </label>
          <input
            id={fileId}
            type="file"
            // `.ics` AND the media type: a file picked from a cloud provider often arrives without
            // an extension, and one saved by a mail client often arrives without a type.
            accept=".ics,text/calendar"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file !== undefined) void read(file)
            }}
          />
        </div>

        {problem !== null && <p className={styles.fieldError}>{problem}</p>}

        {candidates !== null && candidates.length > 0 && (
          <>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={calendarId}>
                {t('calendar.event.calendar')}
              </label>
              <Select
                id={calendarId}
                value={calendar}
                onChange={(event) => setCalendar(event.target.value)}
              >
                {props.calendars.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            </div>

            <ul className={styles.participantList}>
              {candidates.map((entry) => {
                const at = localToInstant(entry.start, null)
                return (
                  <li key={entry.key} className={styles.participantRow}>
                    <label className={styles.checkboxRow}>
                      <input
                        type="checkbox"
                        checked={chosen.has(entry.key)}
                        onChange={(event) => {
                          const next = new Set(chosen)
                          if (event.target.checked) next.add(entry.key)
                          else next.delete(entry.key)
                          setChosen(next)
                        }}
                      />
                      <span className={styles.participantName}>
                        {entry.title || t('calendar.untitled')}
                        <span className={styles.participantNote}>
                          {at === null
                            ? entry.start
                            : formatDate(
                                at,
                                entry.allDay
                                  ? { dateStyle: 'medium' }
                                  : { dateStyle: 'medium', timeStyle: 'short' },
                              )}
                          {/* Said out loud, because "1 event" that is really a weekly meeting is a
                              surprise the reader should get before the import, not after. */}
                          {entry.repeats ? ` · ${t('calendar.import.repeats')}` : ''}
                        </span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <div className={styles.formActions}>
          <Button type="button" variant="secondary" onClick={props.onClose}>
            {t('calendar.event.cancel')}
          </Button>
          <Button
            type="button"
            loading={busy}
            disabled={selected === 0 || calendar === ''}
            onClick={() => void run()}
          >
            {t('calendar.import.action', { count: selected })}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
