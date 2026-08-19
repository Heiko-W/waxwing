/**
 * Picking a send time (M5.4, FR-CMP-11).
 *
 * Presets plus a free choice, because the presets cover what people actually pick ("tomorrow
 * morning") and the free field covers the rest. Both go through the same check, and the dialog
 * refuses rather than rounds: a time in the past or beyond the server's window is rejected here so
 * the user learns it now, not from a submission error after the composer has closed.
 *
 * The `datetime-local` input is deliberately the native control — it carries the platform's own
 * locale, calendar and accessibility behaviour, all of which a hand-rolled picker has to re-earn.
 * Its value is LOCAL time with no zone, which is exactly what someone means by "eight tomorrow";
 * the conversion to an absolute instant happens once, here.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, TextInput } from '../ui'
import styles from './composer.module.css'
import { checkScheduleTime, type ScheduleProblem } from './scheduled-send'

export interface ScheduleSendDialogProps {
  /** How far ahead this account may schedule. */
  readonly maxMs: number
  /** Injected in tests; defaults to the current time. */
  readonly now?: number
  onCancel: () => void
  onConfirm: (at: Date) => void
}

/** A named offset from now. */
interface Preset {
  readonly id: string
  readonly at: (now: Date) => Date
}

/** Tomorrow at 08:00 local time. */
function tomorrowMorning(now: Date): Date {
  const at = new Date(now)
  at.setDate(at.getDate() + 1)
  at.setHours(8, 0, 0, 0)
  return at
}

const PRESETS: readonly Preset[] = [
  {
    id: 'inOneHour',
    at: (now) => new Date(now.getTime() + 60 * 60 * 1000),
  },
  {
    id: 'thisEvening',
    at: (now) => {
      const at = new Date(now)
      at.setHours(18, 0, 0, 0)
      // Past six already — "this evening" has gone, so the next one that means anything is tomorrow.
      return at.getTime() <= now.getTime() ? tomorrowMorning(now) : at
    },
  },
  { id: 'tomorrowMorning', at: tomorrowMorning },
  {
    id: 'nextWeek',
    at: (now) => {
      const at = new Date(now)
      at.setDate(at.getDate() + 7)
      at.setHours(8, 0, 0, 0)
      return at
    },
  },
]

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in LOCAL time, which `toISOString` does not give. */
function toLocalInputValue(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** Spelled out, not computed: the i18n guard only sees literal keys. */
function problemText(t: (key: string) => string, problem: ScheduleProblem): string {
  switch (problem) {
    case 'past':
      return t('compose.schedule.error.past')
    case 'tooFar':
      return t('compose.schedule.error.tooFar')
    case 'unsupported':
      return t('compose.schedule.error.unsupported')
  }
}

/** Spelled out for the same reason. */
function presetLabel(t: (key: string) => string, id: string): string {
  switch (id) {
    case 'inOneHour':
      return t('compose.schedule.preset.inOneHour')
    case 'thisEvening':
      return t('compose.schedule.preset.thisEvening')
    case 'tomorrowMorning':
      return t('compose.schedule.preset.tomorrowMorning')
    default:
      return t('compose.schedule.preset.nextWeek')
  }
}

export default function ScheduleSendDialog(props: ScheduleSendDialogProps) {
  const { t } = useTranslation()
  const fieldId = useId()
  const now = props.now ?? Date.now()
  const [custom, setCustom] = useState(() => toLocalInputValue(tomorrowMorning(new Date(now))))
  const [problem, setProblem] = useState<ScheduleProblem | null>(null)

  const choose = (at: Date): void => {
    const verdict = checkScheduleTime(at, now, props.maxMs)
    if (verdict !== null) {
      setProblem(verdict)
      return
    }
    props.onConfirm(at)
  }

  return (
    <Dialog
      open
      onClose={props.onCancel}
      size="sm"
      title={t('compose.schedule.title')}
      footer={
        <Button variant="secondary" onClick={props.onCancel}>
          {t('compose.schedule.cancel')}
        </Button>
      }
    >
      <div className={styles.scheduleBody}>
        <div className={styles.schedulePresets}>
          {PRESETS.map((preset) => {
            const at = preset.at(new Date(now))
            // A preset beyond the server's window is not offered at all — better than offering it
            // and refusing the click.
            if (checkScheduleTime(at, now, props.maxMs) !== null) return null
            return (
              <Button key={preset.id} variant="secondary" onClick={() => choose(at)}>
                {presetLabel(t, preset.id)}
              </Button>
            )
          })}
        </div>

        <div className={styles.scheduleCustom}>
          <label className={styles.scheduleLabel} htmlFor={fieldId}>
            {t('compose.schedule.custom')}
          </label>
          <TextInput
            id={fieldId}
            type="datetime-local"
            value={custom}
            min={toLocalInputValue(new Date(now + 60_000))}
            max={toLocalInputValue(new Date(now + props.maxMs))}
            invalid={problem !== null}
            onChange={(event) => {
              setCustom(event.target.value)
              setProblem(null)
            }}
          />
          <Button
            onClick={() => {
              // An empty or half-typed value parses to Invalid Date; treat it as "in the past"
              // rather than sending something unintelligible to the server.
              const at = new Date(custom)
              if (Number.isNaN(at.getTime())) {
                setProblem('past')
                return
              }
              choose(at)
            }}
          >
            {t('compose.schedule.confirm')}
          </Button>
        </div>

        {problem !== null && (
          <p className={styles.scheduleError} role="alert">
            {problemText(t, problem)}
          </p>
        )}
      </div>
    </Dialog>
  )
}
