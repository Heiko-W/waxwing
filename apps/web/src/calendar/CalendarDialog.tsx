/**
 * Making and editing a calendar (K-1, FR-CAL-01) — a name and a colour, and nothing else.
 *
 * **The colour is a named row of swatches, not `<input type="color">`.** That control hands the
 * choice to an operating-system dialog: no say over its appearance, poor keyboard handling, wildly
 * different on every platform, and it offers sixteen million values where a calendar wants eight.
 * Apple offers a fixed palette for the same reason — and a fixed palette can be NAMED, which is
 * what makes it pass WCAG 1.4.1. Every swatch is a real radio button labelled with its colour name,
 * so a screen reader hears "Red" and not "button"; the chosen one carries a tick and its name is
 * spelled out under the row, so colour is never the only thing saying which one is on.
 *
 * **A colour the server already holds and this palette does not is kept, not overwritten.** It
 * appears as a ninth swatch, selected, labelled "Current colour". A CalDAV client or another
 * webmail chose it deliberately; silently snapping it to the nearest of our eight on the next
 * rename would be the same class of damage as dropping an alert we do not model.
 *
 * The delete confirmation lives here too, because it is the same object under the same name — see
 * `CalendarList` for why deleting a calendar is the one control on this screen that asks first.
 */

import type { Calendar } from '@waxwing/jmap'
import type { TFunction } from 'i18next'
import { Check } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Spinner, TextInput } from '../ui'
import styles from './calendar.module.css'
import type { CalendarDraft } from './calendar-client'

/**
 * The eight colours a calendar may be given here.
 *
 * Literal hex, and deliberately not `--waxwing-*` tokens: this value is **stored on the server** and
 * read by Apple Calendar, Thunderbird and whatever else touches the account. A token resolves to a
 * different colour under a different theme and to nothing at all outside this app, so writing one
 * to the wire would store a string no other client can render. The white-label promise covers the
 * app's own chrome; it cannot cover data the app does not own.
 *
 * Each carries a translation key rather than a name, so "Rot" is not "Red" spelled in English on a
 * German screen. The values are mid-range hues that stay distinguishable side by side in both
 * themes, and every one of them carries at least 4.5:1 against white — which is the constraint that
 * shaped them, because the TICK is white and has to be legible on whichever swatch is chosen. It is
 * also why the yellow is an ochre: a true yellow cannot hold a white glyph, and a swatch labelled
 * "yellow" that is not one is a worse answer than a swatch labelled what it is.
 *
 * The dot's own edge against the page comes from its 1px `--waxwing-border`, not from the fill, so a
 * value with low contrast against a dark surface is still a visible control (WCAG 1.4.11).
 */
export const CALENDAR_COLORS: readonly { readonly value: string; readonly key: string }[] = [
  { value: '#c2372f', key: 'red' },
  { value: '#c05621', key: 'orange' },
  { value: '#8a6d1f', key: 'ochre' },
  { value: '#2f7a3e', key: 'green' },
  { value: '#0f7a76', key: 'teal' },
  { value: '#2761c4', key: 'blue' },
  { value: '#6b4bc0', key: 'purple' },
  { value: '#7a5245', key: 'brown' },
]

/** The colour name to show, or `null` when the value is not one of ours. */
export function colorName(value: string | null, t: TFunction): string | null {
  const known = CALENDAR_COLORS.find((entry) => entry.value.toLowerCase() === value?.toLowerCase())
  return known === undefined ? null : t(`calendar.colors.${known.key}`)
}

export interface CalendarDialogProps {
  /** The calendar being edited, or `null` to create one. */
  readonly calendar: Calendar | null
  readonly busy: boolean
  onCancel: () => void
  onSubmit: (draft: CalendarDraft) => void
}

export default function CalendarDialog(props: CalendarDialogProps) {
  const { t } = useTranslation()
  const nameId = useId()
  const groupId = useId()

  const existing = props.calendar
  const [name, setName] = useState(existing?.name ?? '')
  const [color, setColor] = useState<string | null>(
    existing?.color ?? CALENDAR_COLORS[0]?.value ?? null,
  )

  /** A stored colour this palette does not offer — shown, selected, and never quietly replaced. */
  const foreign =
    existing?.color !== null &&
    existing?.color !== undefined &&
    colorName(existing.color, t) === null
      ? existing.color
      : null

  // Measured: `Calendar/set` refuses an empty name outright (`"Field could not be set."`), so the
  // dialog refuses it first rather than turning a typo into a server error.
  const canSubmit = name.trim() !== ''
  const chosen = colorName(color, t) ?? t('calendar.colors.custom')

  return (
    <Dialog
      open
      onClose={props.onCancel}
      size="sm"
      title={
        existing === null ? t('calendar.calendars.createTitle') : t('calendar.calendars.editTitle')
      }
    >
      <form
        className={styles.eventForm}
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSubmit) return
          props.onSubmit({ name: name.trim(), color })
        }}
      >
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={nameId}>
            {t('calendar.calendars.name')}
          </label>
          <TextInput
            id={nameId}
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        {/* A real radio group: arrow keys move between swatches and only one is a tab stop, which
            is what a set of mutually exclusive choices means to a keyboard. Buttons with
            `aria-pressed` would put eight stops in the Tab order and say "eight toggles". */}
        <fieldset className={styles.field}>
          <legend className={styles.fieldLabel}>{t('calendar.calendars.color')}</legend>
          <div className={styles.swatches}>
            {[
              ...(foreign === null ? [] : [{ value: foreign, label: t('calendar.colors.custom') }]),
              ...CALENDAR_COLORS.map((entry) => ({
                value: entry.value,
                label: t(`calendar.colors.${entry.key}`),
              })),
            ].map((entry) => (
              <label key={entry.value} className={styles.swatch}>
                <input
                  type="radio"
                  name={groupId}
                  className={styles.swatchInput}
                  value={entry.value}
                  checked={color?.toLowerCase() === entry.value.toLowerCase()}
                  onChange={() => setColor(entry.value)}
                />
                <span className={styles.swatchDot} style={{ backgroundColor: entry.value }}>
                  {/* The tick, not the fill, is what says "this one" — the fill is the thing being
                      chosen and cannot also be the indicator that it was (WCAG 1.4.1). */}
                  <Check aria-hidden="true" className={styles.swatchTick} />
                </span>
                <span className={styles.swatchLabel}>{entry.label}</span>
              </label>
            ))}
          </div>
          {/* The chosen colour, in words. The row above is legible to anyone who can see it; this
              line is what makes the choice legible to anyone who cannot. */}
          <p className={styles.swatchChosen}>{t('calendar.calendars.colorChosen', { chosen })}</p>
        </fieldset>

        <div className={styles.formActions}>
          <Button type="button" variant="secondary" onClick={props.onCancel}>
            {t('calendar.event.cancel')}
          </Button>
          <Button type="submit" loading={props.busy} disabled={!canSubmit}>
            {t('calendar.event.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export interface CalendarDeleteDialogProps {
  readonly calendar: Calendar
  /** How many events go with it; `null` while the count is still being fetched. */
  readonly eventCount: number | null
  readonly busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * "Delete this calendar?" — with the name and the number of events that go with it.
 *
 * The count is fetched rather than guessed from the month on screen, because the month on screen is
 * six weeks and the calendar is a lifetime. It arrives after the dialog opens; until it does, the
 * dialog says so instead of showing a zero it does not know to be true, and Delete stays out of
 * reach — agreeing to lose "some events" is not consent.
 */
export function CalendarDeleteDialog(props: CalendarDeleteDialogProps) {
  const { t } = useTranslation()
  const count = props.eventCount

  return (
    <Dialog
      open
      onClose={props.onCancel}
      size="sm"
      title={t('calendar.calendars.deleteTitle', { name: props.calendar.name })}
    >
      <p className={styles.readOnlyNote}>
        {count === null ? (
          <Spinner size="sm" label={t('calendar.calendars.counting')} />
        ) : (
          t('calendar.calendars.deleteBody', { name: props.calendar.name, count })
        )}
      </p>
      <div className={styles.formActions}>
        <Button type="button" variant="secondary" onClick={props.onCancel}>
          {t('calendar.event.cancel')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          loading={props.busy}
          disabled={count === null}
          onClick={props.onConfirm}
        >
          {t('calendar.calendars.delete')}
        </Button>
      </div>
    </Dialog>
  )
}
