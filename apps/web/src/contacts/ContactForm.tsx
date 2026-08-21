/**
 * Contact editor (M4.2, stage 5b, FR-CON-02) — the create / edit form behind the detail pane's New
 * and Edit affordances. Progressive disclosure: Name, Emails and Phones are always visible; Address,
 * Company / Job title, Birthday, Notes and Photo appear only once revealed from the "Add field" bar
 * (or because the edited card already carries them).
 *
 * **Async-seam discipline (this project's top bug class).** The draft is initialised ONCE from the
 * card via a lazy `useState` initialiser and the diff base is captured ONCE in a ref. A later re-render
 * with a stale live-query echo of the card can therefore never reach in and reset a field the user is
 * mid-edit — the failure mode {@link VacationSection} was written to avoid. The form reads and writes
 * only its local draft until Save.
 *
 * The write is computed by {@link ../contacts/contact-card-mapping}: a full card for a create, a
 * minimal {@link PatchObject} for an edit, both preserving JSContact map-key identity and every
 * property the form does not surface. This component never touches the outbox itself — it hands the
 * result to `onSubmit`, which the screen wires to the stage-5a enqueue helpers.
 */

import type { ContactCard, ContactCardMedia, Id, PatchObject } from '@waxwing/jmap'
import { Plus, X } from 'lucide-react'
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { isPlausibleEmail } from '../compose/address-validation'
import { type ContactCardRow, useReplica } from '../sync'
import { Button, IconButton, SectionLabel, Select, TextInput } from '../ui'
import {
  type AddressEntry,
  type ContactFormModel,
  cardToForm,
  diffCardPatch,
  type EmailEntry,
  emptyFormModel,
  formToCard,
  type IdSource,
  newAddressEntry,
  newEmailEntry,
  newNoteEntry,
  newPhoneEntry,
  type PhoneEntry,
} from './contact-card-mapping'
import type { PhotoScaler, PhotoUploader } from './contact-photo-upload'
import { scalePhoto as defaultScalePhoto } from './contact-photo-upload'
import styles from './contacts.module.css'
import { useContactPhoto } from './use-contact-photo'

/** The result the form hands back — a whole card to create, or a minimal patch to update. */
export type ContactFormSubmit =
  | { readonly kind: 'create'; readonly card: ContactCard }
  | { readonly kind: 'update'; readonly cardId: Id; readonly patch: PatchObject }

export interface ContactFormProps {
  readonly mode: 'create' | 'edit'
  /** The card being edited (required for `mode === 'edit'`). */
  readonly card?: ContactCardRow
  /** Target book for a create / context book for an edit — a card must belong to at least one book. */
  readonly bookId: Id
  readonly onSubmit: (submit: ContactFormSubmit) => void
  readonly onCancel: () => void
  /** Defence in depth: `false` disables Save and shows a read-only notice. Default `true`. */
  readonly canWrite?: boolean
  /** Injected in tests; production builds one from the session (see the screen wiring). */
  readonly uploadPhoto?: PhotoUploader
  /** Injected in tests (jsdom has no canvas); defaults to the real downscaler. */
  readonly scalePhoto?: PhotoScaler
  /** Injected in tests for deterministic map keys. */
  readonly newId?: IdSource
}

type OptionalSection = 'address' | 'org' | 'birthday' | 'note' | 'photo'

const EMAIL_TYPE_OPTIONS = ['work', 'private', ''] as const
const PHONE_TYPE_OPTIONS = ['mobile', 'work', 'private', 'fax', 'pager', ''] as const
const ADDRESS_TYPE_OPTIONS = ['work', 'private', ''] as const

/**
 * Row edits address a row by its KEY, never by its render-time index.
 *
 * The index is a property of the last paint, and a handler can outlive it: double-clicking the X on
 * the first of three email rows removed two, because the second click carried the index the first
 * click had just vacated and the row that had slid up took the hit. Every row already owns a stable
 * JSContact map key (that is the point of `contact-card-mapping`), so the handlers use it.
 */
interface KeyedRow {
  readonly key: Id
}

function replaceByKey<T extends KeyedRow>(items: readonly T[], key: Id, partial: Partial<T>): T[] {
  return items.map((item) => (item.key === key ? { ...item, ...partial } : item))
}

function removeByKey<T extends KeyedRow>(items: readonly T[], key: Id): T[] {
  return items.filter((item) => item.key !== key)
}

/**
 * The accessible name of one row's control.
 *
 * Numbered only when the section HAS several rows: with a single email row "Email" is exact and
 * "Email 1" is noise, while with three of them one name shared by three text boxes leaves a screen
 * reader user unable to say which one they are in — the same for the type pickers and the X buttons.
 */
function rowName(
  t: ReturnType<typeof useTranslation>['t'],
  field: string,
  index: number,
  total: number,
): string {
  return total > 1 ? t('contacts.form.a11y.numbered', { field, index: index + 1 }) : field
}

export function ContactForm(props: ContactFormProps) {
  const { mode, card, bookId, onSubmit, onCancel } = props
  const { t } = useTranslation()
  const canWrite = props.canWrite ?? true

  const newId = useMemo<IdSource>(() => props.newId ?? (() => crypto.randomUUID()), [props.newId])

  // Initialised ONCE (lazy) — never re-derived from a later `card` prop, so a stale live echo cannot
  // clobber an in-progress edit. A create starts with one empty email + phone row.
  const [draft, setDraft] = useState<ContactFormModel>(() => {
    if (card !== undefined) return cardToForm(card)
    const blank = emptyFormModel()
    return { ...blank, emails: [newEmailEntry(newId)], phones: [newPhoneEntry(newId)] }
  })
  // The diff base, captured once. `card` may change identity under us (another tab); the diff is
  // still taken against the version the user opened, and the outbox `ifInState` guard catches races.
  const baseRef = useRef<ContactCardRow | null>(card ?? null)

  const [revealed, setRevealed] = useState<ReadonlySet<OptionalSection>>(() => {
    const initial = new Set<OptionalSection>()
    if (draft.addresses.length > 0) initial.add('address')
    if (draft.organization !== '' || draft.title !== '') initial.add('org')
    if (draft.birthday !== '') initial.add('birthday')
    if (draft.notes.length > 0) initial.add('note')
    if (draft.photo !== null) initial.add('photo')
    return initial
  })

  const reveal = useCallback(
    (section: OptionalSection): void => {
      setRevealed((prev) => new Set(prev).add(section))
      if (section === 'address') {
        setDraft((prev) =>
          prev.addresses.length > 0 ? prev : { ...prev, addresses: [newAddressEntry(newId)] },
        )
      } else if (section === 'note') {
        setDraft((prev) =>
          prev.notes.length > 0 ? prev : { ...prev, notes: [newNoteEntry(newId)] },
        )
      }
    },
    [newId],
  )

  const ids = {
    prefix: useId(),
    given: useId(),
    given2: useId(),
    surname: useId(),
    suffix: useId(),
    company: useId(),
    jobTitle: useId(),
    birthday: useId(),
  }

  /*
   * Email addresses the last Save attempt refused, by row key.
   *
   * The form used to have NO validation of its own and relied on the browser's `type="email"`
   * constraint. That is a silent stop: Chrome refuses the submit, shows a bubble in the browser's UI
   * language, and the app itself says nothing, sets no `aria-invalid` and moves no focus — from the
   * app's side the Save button simply did nothing. Worse, the native constraint rejects perfectly
   * real addresses: `björn.müller@exämple.de` is a valid EAI address (RFC 6531) and an address book
   * must be able to hold one.
   *
   * So the form validates itself (`noValidate` below turns the native pass off) with the SAME check
   * the compose recipient fields use — deliberately lenient, and Unicode-safe.
   */
  const [invalidEmails, setInvalidEmails] = useState<ReadonlySet<Id>>(() => new Set())
  const fieldPrefix = useId()
  const valueDomId = useCallback((key: Id) => `${fieldPrefix}-value-${key}`, [fieldPrefix])
  const errorDomId = useCallback((key: Id) => `${fieldPrefix}-error-${key}`, [fieldPrefix])

  const handleSubmit = useCallback(
    (event: FormEvent): void => {
      event.preventDefault()
      if (!canWrite) return
      // A blank row is not an error — it is simply dropped by the mapping. Only something the user
      // actually typed can be wrong, and then the form says so, in place, and puts the caret there.
      const rejected = draft.emails.filter(
        (entry) => entry.address.trim() !== '' && !isPlausibleEmail(entry.address),
      )
      const firstRejected = rejected[0]
      if (firstRejected !== undefined) {
        setInvalidEmails(new Set(rejected.map((entry) => entry.key)))
        document.getElementById(valueDomId(firstRejected.key))?.focus()
        return
      }
      setInvalidEmails(new Set())
      const base: ContactCard = baseRef.current ?? {
        '@type': 'Card',
        version: '1.0',
        uid: newId(),
        id: newId(),
        addressBookIds: { [bookId]: true },
        kind: 'individual',
      }
      const next = formToCard(draft, base, newId)
      if (mode === 'create') {
        onSubmit({ kind: 'create', card: next })
        return
      }
      const current = baseRef.current
      if (current === null) return
      const patch = diffCardPatch(current, next)
      if (Object.keys(patch).length === 0) {
        onCancel()
        return
      }
      onSubmit({ kind: 'update', cardId: current.id, patch })
    },
    [canWrite, bookId, draft, mode, newId, onSubmit, onCancel, valueDomId],
  )

  const hiddenSections = (['address', 'org', 'birthday', 'note', 'photo'] as const).filter(
    (section) => !revealed.has(section),
  )

  return (
    <form
      className={styles.form}
      aria-label={t(mode === 'create' ? 'contacts.form.newTitle' : 'contacts.form.editTitle')}
      // The app validates, not the browser: see `invalidEmails` above. Without this the native pass
      // runs first and blocks the submit before `handleSubmit` is ever called.
      noValidate
      onSubmit={handleSubmit}
    >
      <div className={styles.formToolbar}>
        <Button variant="ghost" type="button" onClick={onCancel}>
          {t('contacts.form.cancel')}
        </Button>
        <h2 className={styles.formTitle}>
          {t(mode === 'create' ? 'contacts.form.newTitle' : 'contacts.form.editTitle')}
        </h2>
        <Button variant="primary" type="submit" disabled={!canWrite}>
          {t('contacts.form.save')}
        </Button>
      </div>

      {!canWrite && <p className={styles.formNotice}>{t('contacts.form.readOnly')}</p>}

      {/* ── Name (always visible) ── */}
      <FormSection title={t('contacts.form.sections.name')}>
        <div className={styles.nameGrid}>
          <Field id={ids.prefix} label={t('contacts.form.namePrefix')}>
            <TextInput
              id={ids.prefix}
              value={draft.name.prefix}
              autoComplete="honorific-prefix"
              onChange={(e) =>
                setDraft((p) => ({ ...p, name: { ...p.name, prefix: e.target.value } }))
              }
            />
          </Field>
          <Field id={ids.given} label={t('contacts.form.given')}>
            <TextInput
              id={ids.given}
              value={draft.name.given}
              autoComplete="given-name"
              onChange={(e) =>
                setDraft((p) => ({ ...p, name: { ...p.name, given: e.target.value } }))
              }
            />
          </Field>
          <Field id={ids.given2} label={t('contacts.form.given2')}>
            <TextInput
              id={ids.given2}
              value={draft.name.given2}
              autoComplete="additional-name"
              onChange={(e) =>
                setDraft((p) => ({ ...p, name: { ...p.name, given2: e.target.value } }))
              }
            />
          </Field>
          <Field id={ids.surname} label={t('contacts.form.surname')}>
            <TextInput
              id={ids.surname}
              value={draft.name.surname}
              autoComplete="family-name"
              onChange={(e) =>
                setDraft((p) => ({ ...p, name: { ...p.name, surname: e.target.value } }))
              }
            />
          </Field>
          <Field id={ids.suffix} label={t('contacts.form.nameSuffix')}>
            <TextInput
              id={ids.suffix}
              value={draft.name.suffix}
              autoComplete="honorific-suffix"
              onChange={(e) =>
                setDraft((p) => ({ ...p, name: { ...p.name, suffix: e.target.value } }))
              }
            />
          </Field>
        </div>
      </FormSection>

      {/* ── Emails (always visible) ── */}
      <FormSection title={t('contacts.form.sections.email')}>
        {draft.emails.map((entry, index) => (
          <CommRow
            key={entry.key}
            typeValue={entry.type}
            typeOptions={EMAIL_TYPE_OPTIONS}
            value={entry.address}
            name={rowName(t, t('contacts.form.fieldNames.email'), index, draft.emails.length)}
            valueType="email"
            valueId={valueDomId(entry.key)}
            errorId={errorDomId(entry.key)}
            {...(invalidEmails.has(entry.key)
              ? { error: t('contacts.form.invalidEmail') }
              : {})}
            onType={(type) =>
              setDraft((p) => ({ ...p, emails: replaceByKey(p.emails, entry.key, { type }) }))
            }
            onValue={(address) => {
              // Editing a rejected row clears its complaint straight away — a message that outlives
              // the mistake trains the reader to ignore messages.
              setInvalidEmails((prev) => {
                if (!prev.has(entry.key)) return prev
                const next = new Set(prev)
                next.delete(entry.key)
                return next
              })
              setDraft((p) => ({
                ...p,
                emails: replaceByKey<EmailEntry>(p.emails, entry.key, { address }),
              }))
            }}
            onRemove={() => setDraft((p) => ({ ...p, emails: removeByKey(p.emails, entry.key) }))}
          />
        ))}
        <AddRowButton
          label={t('contacts.form.addEmail')}
          onClick={() => setDraft((p) => ({ ...p, emails: [...p.emails, newEmailEntry(newId)] }))}
        />
      </FormSection>

      {/* ── Phones (always visible) ── */}
      <FormSection title={t('contacts.form.sections.phone')}>
        {draft.phones.map((entry, index) => (
          <CommRow
            key={entry.key}
            typeValue={entry.type}
            typeOptions={PHONE_TYPE_OPTIONS}
            value={entry.number}
            name={rowName(t, t('contacts.form.fieldNames.phone'), index, draft.phones.length)}
            valueType="tel"
            valueId={valueDomId(entry.key)}
            errorId={errorDomId(entry.key)}
            onType={(type) =>
              setDraft((p) => ({ ...p, phones: replaceByKey(p.phones, entry.key, { type }) }))
            }
            onValue={(number) =>
              setDraft((p) => ({
                ...p,
                phones: replaceByKey<PhoneEntry>(p.phones, entry.key, { number }),
              }))
            }
            onRemove={() => setDraft((p) => ({ ...p, phones: removeByKey(p.phones, entry.key) }))}
          />
        ))}
        <AddRowButton
          label={t('contacts.form.addPhone')}
          onClick={() => setDraft((p) => ({ ...p, phones: [...p.phones, newPhoneEntry(newId)] }))}
        />
      </FormSection>

      {/* ── Optional: Address ── */}
      {revealed.has('address') && (
        <FormSection title={t('contacts.form.sections.address')}>
          {draft.addresses.map((entry, index) => (
            <AddressRow
              key={entry.key}
              entry={entry}
              name={rowName(
                t,
                t('contacts.form.fieldNames.address'),
                index,
                draft.addresses.length,
              )}
              qualify={draft.addresses.length > 1}
              onChange={(partial) =>
                setDraft((p) => ({
                  ...p,
                  addresses: replaceByKey<AddressEntry>(p.addresses, entry.key, partial),
                }))
              }
              onRemove={() =>
                setDraft((p) => ({ ...p, addresses: removeByKey(p.addresses, entry.key) }))
              }
            />
          ))}
          <AddRowButton
            label={t('contacts.form.addAddress')}
            onClick={() =>
              setDraft((p) => ({ ...p, addresses: [...p.addresses, newAddressEntry(newId)] }))
            }
          />
        </FormSection>
      )}

      {/* ── Optional: Company / Job title ── */}
      {revealed.has('org') && (
        <FormSection title={t('contacts.form.sections.org')}>
          <Field id={ids.company} label={t('contacts.form.company')}>
            <TextInput
              id={ids.company}
              value={draft.organization}
              autoComplete="organization"
              onChange={(e) => setDraft((p) => ({ ...p, organization: e.target.value }))}
            />
          </Field>
          <Field id={ids.jobTitle} label={t('contacts.form.jobTitle')}>
            <TextInput
              id={ids.jobTitle}
              value={draft.title}
              autoComplete="organization-title"
              onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
            />
          </Field>
        </FormSection>
      )}

      {/* ── Optional: Birthday ── */}
      {revealed.has('birthday') && (
        <FormSection title={t('contacts.form.sections.birthday')}>
          <Field id={ids.birthday} label={t('contacts.form.sections.birthday')}>
            <TextInput
              id={ids.birthday}
              type="date"
              value={draft.birthday}
              onChange={(e) => setDraft((p) => ({ ...p, birthday: e.target.value }))}
            />
          </Field>
        </FormSection>
      )}

      {/* ── Optional: Notes ── */}
      {revealed.has('note') && (
        <FormSection title={t('contacts.form.sections.note')}>
          {draft.notes.map((entry, index) => {
            const name = rowName(t, t('contacts.form.fieldNames.note'), index, draft.notes.length)
            return (
              <div key={entry.key} className={styles.noteRow}>
                <textarea
                  className={styles.noteInput}
                  aria-label={name}
                  value={entry.text}
                  onChange={(e) =>
                    setDraft((p) => ({
                      ...p,
                      notes: replaceByKey(p.notes, entry.key, { text: e.target.value }),
                    }))
                  }
                />
                <IconButton
                  label={t('contacts.form.a11y.remove', { field: name })}
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => setDraft((p) => ({ ...p, notes: removeByKey(p.notes, entry.key) }))}
                >
                  <X />
                </IconButton>
              </div>
            )
          })}
          <AddRowButton
            label={t('contacts.form.addNote')}
            onClick={() => setDraft((p) => ({ ...p, notes: [...p.notes, newNoteEntry(newId)] }))}
          />
        </FormSection>
      )}

      {/* ── Optional: Photo ── */}
      {revealed.has('photo') && (
        <FormSection title={t('contacts.form.sections.photo')}>
          <PhotoField
            photo={draft.photo}
            uploader={props.uploadPhoto}
            scale={props.scalePhoto ?? defaultScalePhoto}
            newId={newId}
            onChange={(photo) => setDraft((p) => ({ ...p, photo }))}
          />
        </FormSection>
      )}

      {hiddenSections.length > 0 && (
        <fieldset className={styles.addField}>
          <legend className={styles.addFieldLegend}>{t('contacts.form.addField')}</legend>
          <div className={styles.addFieldButtons}>
            {hiddenSections.map((section) => (
              <Button
                key={section}
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => reveal(section)}
              >
                <Plus aria-hidden="true" />
                {t(ADD_FIELD_LABELS[section])}
              </Button>
            ))}
          </div>
        </fieldset>
      )}
    </form>
  )
}

/** Reveal-button label per optional section (explicit — `org`'s label key is `addCompany`). */
const ADD_FIELD_LABELS: Record<OptionalSection, string> = {
  address: 'contacts.form.addAddress',
  org: 'contacts.form.addCompany',
  birthday: 'contacts.form.addBirthday',
  note: 'contacts.form.addNote',
  photo: 'contacts.form.addPhoto',
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  // No aria-label: the <h3> is the section's identity — a named <section> would add a region landmark
  // per field group, and there are many.
  return (
    <section className={styles.formSection}>
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className={styles.formField}>
      <label className={styles.formLabel} htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  )
}

function AddRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" type="button" onClick={onClick} className={styles.addRow}>
      <Plus aria-hidden="true" />
      {label}
    </Button>
  )
}

interface CommRowProps {
  readonly typeValue: string
  readonly typeOptions: readonly string[]
  readonly value: string
  /** What this row is called — "Email", or "Email 2" once the section has more than one. */
  readonly name: string
  readonly valueType: 'email' | 'tel'
  /** DOM id of the value field, so a rejected row can be focused by the submit handler. */
  readonly valueId: string
  readonly errorId: string
  /** The reason this row was refused, if it was. Shown in place and tied to the field. */
  readonly error?: string | undefined
  readonly onType: (type: string) => void
  readonly onValue: (value: string) => void
  readonly onRemove: () => void
}

function CommRow(props: CommRowProps) {
  const { t } = useTranslation()
  const invalid = props.error !== undefined
  return (
    <div className={styles.commField}>
      <div className={styles.commRow}>
        <TypeSelect
          value={props.typeValue}
          options={props.typeOptions}
          label={t('contacts.form.a11y.type', { field: props.name })}
          onChange={props.onType}
        />
        <TextInput
          id={props.valueId}
          className={styles.commValue}
          type={props.valueType}
          aria-label={props.name}
          {...(invalid ? { invalid: true, 'aria-describedby': props.errorId } : {})}
          value={props.value}
          onChange={(e) => props.onValue(e.target.value)}
        />
        <IconButton
          label={t('contacts.form.a11y.remove', { field: props.name })}
          variant="ghost"
          size="sm"
          type="button"
          onClick={props.onRemove}
        >
          <X />
        </IconButton>
      </div>
      {/* Named by `aria-describedby` rather than announced as an alert: the submit handler moves
          focus to the field, so the reason is read out on arrival — once, in context, and with the
          caret already where the fix has to happen. */}
      {invalid && (
        <p id={props.errorId} className={styles.formNotice}>
          {props.error}
        </p>
      )}
    </div>
  )
}

function TypeSelect({
  value,
  options,
  label,
  onChange,
}: {
  value: string
  options: readonly string[]
  /** Names the picker after the row it belongs to — "Type of Email 2", never a bare "Type". */
  label: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  // Keep an unusual stored type (e.g. a vCard `home`) selectable so a round-trip never drops it.
  const all = options.includes(value) ? options : [...options, value]
  return (
    // The width lives on this wrapper, not on the `Select`: `Select`'s `className` lands on the inner
    // `<select>`, while the flex child of the row is the wrapper `Select` renders around it (which is
    // `inline-size: 100%`). See the note on `.commType`. Sizing the shared component from outside
    // would mean changing it for its eight other callers, so the box that needs the width gets one.
    <div className={styles.commType}>
      <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {all.map((option) => (
          <option key={option} value={option}>
            {t(`contacts.labels.${option === '' ? 'other' : option}`, { defaultValue: option })}
          </option>
        ))}
      </Select>
    </div>
  )
}

function AddressRow({
  entry,
  name,
  qualify,
  onChange,
  onRemove,
}: {
  entry: AddressEntry
  /** "Address", or "Address 2" once there is more than one. */
  name: string
  /** True when several addresses are on screen and the inner fields need telling apart. */
  qualify: boolean
  onChange: (partial: Partial<AddressEntry>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  /*
   * "Street", "City", … are exact inside ONE address card and ambiguous across two. They are
   * qualified by the card rather than numbered: German "Straße 2" reads as a house number, while
   * "Straße (Adresse 2)" says what it means. The plain label is kept in the single-address case, so
   * the common form is not made noisier to solve a problem it does not have.
   */
  const fieldLabel = (label: string): string =>
    qualify ? t('contacts.form.a11y.inGroup', { field: label, group: name }) : label
  return (
    <div className={styles.addressRow}>
      <div className={styles.addressHead}>
        <TypeSelect
          value={entry.type}
          options={ADDRESS_TYPE_OPTIONS}
          label={t('contacts.form.a11y.type', { field: name })}
          onChange={(type) => onChange({ type })}
        />
        <IconButton
          label={t('contacts.form.a11y.remove', { field: name })}
          variant="ghost"
          size="sm"
          type="button"
          onClick={onRemove}
        >
          <X />
        </IconButton>
      </div>
      <TextInput
        aria-label={fieldLabel(t('contacts.form.street'))}
        placeholder={t('contacts.form.street')}
        autoComplete="address-line1"
        value={entry.street}
        onChange={(e) => onChange({ street: e.target.value })}
      />
      <div className={styles.addressGrid}>
        <TextInput
          aria-label={fieldLabel(t('contacts.form.postcode'))}
          placeholder={t('contacts.form.postcode')}
          autoComplete="postal-code"
          value={entry.postcode}
          onChange={(e) => onChange({ postcode: e.target.value })}
        />
        <TextInput
          aria-label={fieldLabel(t('contacts.form.city'))}
          placeholder={t('contacts.form.city')}
          autoComplete="address-level2"
          value={entry.locality}
          onChange={(e) => onChange({ locality: e.target.value })}
        />
      </div>
      <div className={styles.addressGrid}>
        <TextInput
          aria-label={fieldLabel(t('contacts.form.region'))}
          placeholder={t('contacts.form.region')}
          autoComplete="address-level1"
          value={entry.region}
          onChange={(e) => onChange({ region: e.target.value })}
        />
        <TextInput
          aria-label={fieldLabel(t('contacts.form.country'))}
          placeholder={t('contacts.form.country')}
          autoComplete="country-name"
          value={entry.country}
          onChange={(e) => onChange({ country: e.target.value })}
        />
      </div>
    </div>
  )
}

interface PhotoFieldProps {
  readonly photo: ContactFormModel['photo']
  readonly uploader: PhotoUploader | undefined
  readonly scale: PhotoScaler
  readonly newId: IdSource
  readonly onChange: (photo: ContactFormModel['photo']) => void
}

function PhotoField({ photo, uploader, scale, newId, onChange }: PhotoFieldProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const previewRef = useRef<string | null>(null)

  const setPreview = useCallback((url: string | null): void => {
    if (previewRef.current !== null) URL.revokeObjectURL(previewRef.current)
    previewRef.current = url
  }, [])

  // Revoke a still-live preview object URL when the form closes, so a picked-then-cancelled photo leaks nothing.
  useEffect(() => {
    return () => {
      if (previewRef.current !== null) URL.revokeObjectURL(previewRef.current)
    }
  }, [])

  const onPick = useCallback(
    async (file: File): Promise<void> => {
      if (uploader === undefined) return
      setBusy(true)
      setError(false)
      const previewUrl = URL.createObjectURL(file)
      setPreview(previewUrl)
      try {
        const prepared = await scale(file)
        const uploaded = await uploader(prepared.blob, prepared.mediaType)
        onChange({
          key: photo?.key ?? newId(),
          blobId: uploaded.blobId,
          mediaType: uploaded.mediaType,
          previewUrl,
        })
      } catch {
        setPreview(null)
        setError(true)
      } finally {
        setBusy(false)
      }
    },
    [uploader, scale, onChange, photo?.key, newId, setPreview],
  )

  const remove = useCallback((): void => {
    setPreview(null)
    onChange(null)
  }, [onChange, setPreview])

  return (
    <div className={styles.photoField}>
      {photo !== null && <PhotoPreview photo={photo} />}
      <div className={styles.photoActions}>
        <label className={styles.photoPick}>
          <span>
            {photo !== null ? t('contacts.form.changePhoto') : t('contacts.form.choosePhoto')}
          </span>
          <input
            type="file"
            accept="image/*"
            disabled={uploader === undefined || busy}
            aria-label={
              photo !== null ? t('contacts.form.changePhoto') : t('contacts.form.choosePhoto')
            }
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file !== undefined) void onPick(file)
              e.target.value = ''
            }}
          />
        </label>
        {photo !== null && (
          <Button variant="ghost" size="sm" type="button" onClick={remove}>
            {t('contacts.form.removePhoto')}
          </Button>
        )}
      </div>
      {busy && <p className={styles.formHint}>{t('contacts.form.photoUploading')}</p>}
      {error && (
        <p role="alert" className={styles.formNotice}>
          {t('contacts.form.photoError')}
        </p>
      )}
    </div>
  )
}

function PhotoPreview({ photo }: { photo: NonNullable<ContactFormModel['photo']> }) {
  const { t } = useTranslation()
  const { accountId } = useReplica()
  const media = useMemo<ContactCardMedia>(
    () => ({
      '@type': 'Media',
      kind: 'photo',
      ...(photo.blobId !== undefined ? { blobId: photo.blobId } : {}),
      ...(photo.uri !== undefined ? { uri: photo.uri } : {}),
      ...(photo.mediaType !== undefined ? { mediaType: photo.mediaType } : {}),
    }),
    [photo.blobId, photo.uri, photo.mediaType],
  )
  const fetched = useContactPhoto(accountId, media)
  const url = photo.previewUrl ?? fetched
  if (url === undefined) return null
  return <img src={url} alt={t('contacts.form.photoAlt')} className={styles.photoImg} />
}
