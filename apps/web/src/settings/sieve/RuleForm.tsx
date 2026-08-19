/**
 * The rule editor behind Settings → Filters (M5.2, FR-SIEVE-01).
 *
 * A rule is conditions plus actions, and the form is deliberately a small closed vocabulary rather
 * than a Sieve expression builder: everything it can express, `rule-model.ts` can compile AND read
 * back from its own metadata. Widening the form without widening both directions is what turns a
 * rule editor into something that quietly rewrites rules it did not understand.
 *
 * Labelling follows the house pattern rather than the controls: `TextInput` and `Select` are the
 * bare elements, so every field pairs one with a `<label htmlFor>` of its own.
 */

import type { TFunction } from 'i18next'
import { type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MailboxRow } from '../../sync'
import { Button, Dialog, Select, TextInput } from '../../ui'
import settings from '../settings.module.css'
import styles from './filters.module.css'
import type {
  SieveAction,
  SieveCondition,
  SieveMatch,
  SieveRule,
  SieveTextField,
} from './rule-model'

export interface RuleFormProps {
  /** The rule being edited, or `null` to create one. */
  readonly rule: SieveRule | null
  readonly mailboxes: readonly MailboxRow[]
  readonly busy: boolean
  onSubmit(rule: SieveRule): void
  onCancel(): void
}

const TEXT_FIELDS: readonly SieveTextField[] = ['from', 'to', 'cc', 'subject', 'body']
const MATCHES: readonly SieveMatch[] = ['contains', 'is', 'startsWith', 'endsWith']

function blankCondition(): SieveCondition {
  return { kind: 'text', field: 'from', match: 'contains', value: '' }
}

function blankRule(): SieveRule {
  return {
    // Available in every browser the app supports (spec §1.4 rules out non-evergreen ones) and in
    // the secure context OAuth already requires.
    id: crypto.randomUUID(),
    name: '',
    enabled: true,
    match: 'all',
    conditions: [blankCondition()],
    actions: [{ kind: 'addFlag', flag: '\\Seen' }],
    stop: false,
  }
}

/** A labelled field, matching the shape the other settings sections use. */
function Field(props: { readonly label: string; readonly children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className={settings.field}>
      <label className={settings.label} htmlFor={id}>
        {props.label}
      </label>
      {props.children(id)}
    </div>
  )
}

export function RuleForm(props: RuleFormProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<SieveRule>(props.rule ?? blankRule())

  const setCondition = (index: number, condition: SieveCondition) => {
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.map((existing, i) => (i === index ? condition : existing)),
    }))
  }

  const setAction = (index: number, action: SieveAction) => {
    setDraft((current) => ({
      ...current,
      actions: current.actions.map((existing, i) => (i === index ? action : existing)),
    }))
  }

  const nameMissing = draft.name.trim() === ''

  return (
    <Dialog
      open
      onClose={props.onCancel}
      size="md"
      title={
        props.rule === null
          ? t('settings.filters.form.createTitle')
          : t('settings.filters.form.editTitle')
      }
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          if (nameMissing) return
          props.onSubmit({ ...draft, name: draft.name.trim() })
        }}
      >
        <Field label={t('settings.filters.form.name')}>
          {(id) => (
            <TextInput
              id={id}
              value={draft.name}
              required
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          )}
        </Field>

        <fieldset className={settings.fieldset}>
          <legend className={settings.label}>{t('settings.filters.form.conditions')}</legend>

          <Field label={t('settings.filters.form.matchMode')}>
            {(id) => (
              <Select
                id={id}
                value={draft.match}
                onChange={(event) =>
                  setDraft({ ...draft, match: event.target.value === 'any' ? 'any' : 'all' })
                }
              >
                <option value="all">{t('settings.filters.form.matchAll')}</option>
                <option value="any">{t('settings.filters.form.matchAny')}</option>
              </Select>
            )}
          </Field>

          {draft.conditions.map((condition, index) => (
            <ConditionRow
              // Conditions carry no identity of their own and are only ever added or removed, so
              // the index is the identity here.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              condition={condition}
              onChange={(next) => setCondition(index, next)}
              onRemove={
                draft.conditions.length > 1
                  ? () =>
                      setDraft({
                        ...draft,
                        conditions: draft.conditions.filter((_, i) => i !== index),
                      })
                  : undefined
              }
            />
          ))}

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              setDraft({ ...draft, conditions: [...draft.conditions, blankCondition()] })
            }
          >
            {t('settings.filters.form.addCondition')}
          </Button>
        </fieldset>

        <fieldset className={settings.fieldset}>
          <legend className={settings.label}>{t('settings.filters.form.actions')}</legend>

          {draft.actions.map((action, index) => (
            <ActionRow
              // biome-ignore lint/suspicious/noArrayIndexKey: actions carry no identity either
              key={index}
              action={action}
              mailboxes={props.mailboxes}
              onChange={(next) => setAction(index, next)}
              onRemove={
                draft.actions.length > 1
                  ? () =>
                      setDraft({ ...draft, actions: draft.actions.filter((_, i) => i !== index) })
                  : undefined
              }
            />
          ))}

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              setDraft({
                ...draft,
                actions: [...draft.actions, { kind: 'addFlag', flag: '\\Seen' }],
              })
            }
          >
            {t('settings.filters.form.addAction')}
          </Button>
        </fieldset>

        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={draft.stop}
            onChange={(event) => setDraft({ ...draft, stop: event.target.checked })}
          />
          {t('settings.filters.form.stop')}
        </label>

        <div className={styles.formActions}>
          <Button type="button" variant="secondary" onClick={props.onCancel}>
            {t('settings.filters.form.cancel')}
          </Button>
          <Button type="submit" loading={props.busy} disabled={nameMissing}>
            {t('settings.filters.form.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

interface ConditionRowProps {
  readonly condition: SieveCondition
  onChange(condition: SieveCondition): void
  onRemove?: (() => void) | undefined
}

function ConditionRow(props: ConditionRowProps) {
  const { t } = useTranslation()
  const { condition } = props

  return (
    <div className={styles.row}>
      <Field label={t('settings.filters.form.field')}>
        {(id) => (
          <Select
            id={id}
            value={condition.kind === 'text' ? condition.field : condition.kind}
            onChange={(event) => {
              const value = event.target.value
              // The three condition kinds share no fields, so switching kind rebuilds the row.
              if (value === 'size')
                props.onChange({ kind: 'size', operator: 'over', bytes: 1_048_576 })
              else if (value === 'hasAttachment') props.onChange({ kind: 'hasAttachment' })
              else if (condition.kind === 'text')
                props.onChange({ ...condition, field: value as SieveTextField })
              else
                props.onChange({
                  kind: 'text',
                  field: value as SieveTextField,
                  match: 'contains',
                  value: '',
                })
            }}
          >
            {TEXT_FIELDS.map((field) => (
              <option key={field} value={field}>
                {fieldLabel(t, field)}
              </option>
            ))}
            <option value="size">{t('settings.filters.field.size')}</option>
            <option value="hasAttachment">{t('settings.filters.field.hasAttachment')}</option>
          </Select>
        )}
      </Field>

      {condition.kind === 'text' && (
        <>
          <Field label={t('settings.filters.form.match')}>
            {(id) => (
              <Select
                id={id}
                value={condition.match}
                onChange={(event) =>
                  props.onChange({ ...condition, match: event.target.value as SieveMatch })
                }
              >
                {MATCHES.map((match) => (
                  <option key={match} value={match}>
                    {matchLabel(t, match)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('settings.filters.form.value')}>
            {(id) => (
              <TextInput
                id={id}
                value={condition.value}
                onChange={(event) => props.onChange({ ...condition, value: event.target.value })}
              />
            )}
          </Field>
        </>
      )}

      {condition.kind === 'size' && (
        <>
          <Field label={t('settings.filters.form.match')}>
            {(id) => (
              <Select
                id={id}
                value={condition.operator}
                onChange={(event) =>
                  props.onChange({
                    ...condition,
                    operator: event.target.value === 'under' ? 'under' : 'over',
                  })
                }
              >
                <option value="over">{t('settings.filters.match.over')}</option>
                <option value="under">{t('settings.filters.match.under')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('settings.filters.form.sizeKb')}>
            {(id) => (
              <TextInput
                id={id}
                type="number"
                min={0}
                value={String(Math.round(condition.bytes / 1024))}
                onChange={(event) =>
                  props.onChange({ ...condition, bytes: Number(event.target.value) * 1024 })
                }
              />
            )}
          </Field>
        </>
      )}

      {props.onRemove !== undefined && (
        <Button type="button" variant="ghost" size="sm" onClick={props.onRemove}>
          {t('settings.filters.form.remove')}
        </Button>
      )}
    </div>
  )
}

interface ActionRowProps {
  readonly action: SieveAction
  readonly mailboxes: readonly MailboxRow[]
  onChange(action: SieveAction): void
  onRemove?: (() => void) | undefined
}

function ActionRow(props: ActionRowProps) {
  const { t } = useTranslation()
  const { action, mailboxes } = props
  const firstMailbox = mailboxes[0]

  return (
    <div className={styles.row}>
      <Field label={t('settings.filters.form.action')}>
        {(id) => (
          <Select
            id={id}
            value={action.kind}
            onChange={(event) => {
              const kind = event.target.value
              if (kind === 'fileInto')
                props.onChange({
                  kind: 'fileInto',
                  mailboxId: firstMailbox?.id ?? '',
                  mailboxName: firstMailbox?.name ?? '',
                })
              else if (kind === 'redirect') props.onChange({ kind: 'redirect', address: '' })
              else if (kind === 'discard') props.onChange({ kind: 'discard' })
              else props.onChange({ kind: 'addFlag', flag: '\\Seen' })
            }}
          >
            <option value="fileInto">{t('settings.filters.action.fileInto')}</option>
            <option value="addFlag">{t('settings.filters.action.addFlag')}</option>
            <option value="redirect">{t('settings.filters.action.redirect')}</option>
            <option value="discard">{t('settings.filters.action.discard')}</option>
          </Select>
        )}
      </Field>

      {action.kind === 'fileInto' && (
        <Field label={t('settings.filters.form.mailbox')}>
          {(id) => (
            <Select
              id={id}
              value={action.mailboxId}
              onChange={(event) => {
                const mailbox = mailboxes.find((row) => row.id === event.target.value)
                // Both are stored: the id survives a rename, the name keeps the script readable and
                // gives the server a fallback if the id no longer resolves.
                props.onChange({
                  kind: 'fileInto',
                  mailboxId: event.target.value,
                  mailboxName: mailbox?.name ?? '',
                })
              }}
            >
              {mailboxes.map((mailbox) => (
                <option key={mailbox.id} value={mailbox.id}>
                  {mailbox.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      {action.kind === 'addFlag' && (
        <Field label={t('settings.filters.form.flag')}>
          {(id) => (
            <Select
              id={id}
              value={action.flag}
              onChange={(event) =>
                props.onChange({
                  kind: 'addFlag',
                  flag: event.target.value === '\\Flagged' ? '\\Flagged' : '\\Seen',
                })
              }
            >
              <option value="\\Seen">{t('settings.filters.flag.seen')}</option>
              <option value="\\Flagged">{t('settings.filters.flag.flagged')}</option>
            </Select>
          )}
        </Field>
      )}

      {action.kind === 'redirect' && (
        <Field label={t('settings.filters.form.address')}>
          {(id) => (
            <TextInput
              id={id}
              type="email"
              value={action.address}
              onChange={(event) =>
                props.onChange({ kind: 'redirect', address: event.target.value })
              }
            />
          )}
        </Field>
      )}

      {props.onRemove !== undefined && (
        <Button type="button" variant="ghost" size="sm" onClick={props.onRemove}>
          {t('settings.filters.form.remove')}
        </Button>
      )}
    </div>
  )
}

/** Spelled out rather than computed: the i18n key guard only sees literal keys. */
function fieldLabel(t: TFunction, field: SieveTextField): string {
  switch (field) {
    case 'from':
      return t('settings.filters.field.from')
    case 'to':
      return t('settings.filters.field.to')
    case 'cc':
      return t('settings.filters.field.cc')
    case 'subject':
      return t('settings.filters.field.subject')
    case 'body':
      return t('settings.filters.field.body')
  }
}

function matchLabel(t: TFunction, match: SieveMatch): string {
  switch (match) {
    case 'contains':
      return t('settings.filters.match.contains')
    case 'is':
      return t('settings.filters.match.is')
    case 'startsWith':
      return t('settings.filters.match.startsWith')
    case 'endsWith':
      return t('settings.filters.match.endsWith')
    case 'matches':
      return t('settings.filters.match.matches')
  }
}
