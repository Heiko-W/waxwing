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

function replaceAt<T>(items: readonly T[], index: number, partial: Partial<T>): T[] {
  return items.map((item, i) => (i === index ? { ...item, ...partial } : item))
}

function removeAt<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, i) => i !== index)
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

  const handleSubmit = useCallback(
    (event: FormEvent): void => {
      event.preventDefault()
      if (!canWrite) return
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
    [canWrite, bookId, draft, mode, newId, onSubmit, onCancel],
  )

  const hiddenSections = (['address', 'org', 'birthday', 'note', 'photo'] as const).filter(
    (section) => !revealed.has(section),
  )

  return (
    <form
      className={styles.form}
      aria-label={t(mode === 'create' ? 'contacts.form.newTitle' : 'contacts.form.editTitle')}
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
            valueLabel={t('contacts.form.sections.email')}
            valueType="email"
            removeLabel={t('contacts.form.removeEmail')}
            onType={(type) =>
              setDraft((p) => ({ ...p, emails: replaceAt(p.emails, index, { type }) }))
            }
            onValue={(address) =>
              setDraft((p) => ({
                ...p,
                emails: replaceAt<EmailEntry>(p.emails, index, { address }),
              }))
            }
            onRemove={() => setDraft((p) => ({ ...p, emails: removeAt(p.emails, index) }))}
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
            valueLabel={t('contacts.form.sections.phone')}
            valueType="tel"
            removeLabel={t('contacts.form.removePhone')}
            onType={(type) =>
              setDraft((p) => ({ ...p, phones: replaceAt(p.phones, index, { type }) }))
            }
            onValue={(number) =>
              setDraft((p) => ({
                ...p,
                phones: replaceAt<PhoneEntry>(p.phones, index, { number }),
              }))
            }
            onRemove={() => setDraft((p) => ({ ...p, phones: removeAt(p.phones, index) }))}
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
              onChange={(partial) =>
                setDraft((p) => ({
                  ...p,
                  addresses: replaceAt<AddressEntry>(p.addresses, index, partial),
                }))
              }
              onRemove={() => setDraft((p) => ({ ...p, addresses: removeAt(p.addresses, index) }))}
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
          {draft.notes.map((entry, index) => (
            <div key={entry.key} className={styles.noteRow}>
              <textarea
                className={styles.noteInput}
                aria-label={t('contacts.form.sections.note')}
                value={entry.text}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    notes: replaceAt(p.notes, index, { text: e.target.value }),
                  }))
                }
              />
              <IconButton
                label={t('contacts.form.removeNote')}
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setDraft((p) => ({ ...p, notes: removeAt(p.notes, index) }))}
              >
                <X />
              </IconButton>
            </div>
          ))}
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
  readonly valueLabel: string
  readonly valueType: 'email' | 'tel'
  readonly removeLabel: string
  readonly onType: (type: string) => void
  readonly onValue: (value: string) => void
  readonly onRemove: () => void
}

function CommRow(props: CommRowProps) {
  return (
    <div className={styles.commRow}>
      <TypeSelect value={props.typeValue} options={props.typeOptions} onChange={props.onType} />
      <TextInput
        className={styles.commValue}
        type={props.valueType}
        aria-label={props.valueLabel}
        value={props.value}
        onChange={(e) => props.onValue(e.target.value)}
      />
      <IconButton
        label={props.removeLabel}
        variant="ghost"
        size="sm"
        type="button"
        onClick={props.onRemove}
      >
        <X />
      </IconButton>
    </div>
  )
}

function TypeSelect({
  value,
  options,
  onChange,
}: {
  value: string
  options: readonly string[]
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
      <Select
        aria-label={t('contacts.form.type')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
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
  onChange,
  onRemove,
}: {
  entry: AddressEntry
  onChange: (partial: Partial<AddressEntry>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className={styles.addressRow}>
      <div className={styles.addressHead}>
        <TypeSelect
          value={entry.type}
          options={ADDRESS_TYPE_OPTIONS}
          onChange={(type) => onChange({ type })}
        />
        <IconButton
          label={t('contacts.form.removeAddress')}
          variant="ghost"
          size="sm"
          type="button"
          onClick={onRemove}
        >
          <X />
        </IconButton>
      </div>
      <TextInput
        aria-label={t('contacts.form.street')}
        placeholder={t('contacts.form.street')}
        autoComplete="address-line1"
        value={entry.street}
        onChange={(e) => onChange({ street: e.target.value })}
      />
      <div className={styles.addressGrid}>
        <TextInput
          aria-label={t('contacts.form.postcode')}
          placeholder={t('contacts.form.postcode')}
          autoComplete="postal-code"
          value={entry.postcode}
          onChange={(e) => onChange({ postcode: e.target.value })}
        />
        <TextInput
          aria-label={t('contacts.form.city')}
          placeholder={t('contacts.form.city')}
          autoComplete="address-level2"
          value={entry.locality}
          onChange={(e) => onChange({ locality: e.target.value })}
        />
      </div>
      <div className={styles.addressGrid}>
        <TextInput
          aria-label={t('contacts.form.region')}
          placeholder={t('contacts.form.region')}
          autoComplete="address-level1"
          value={entry.region}
          onChange={(e) => onChange({ region: e.target.value })}
        />
        <TextInput
          aria-label={t('contacts.form.country')}
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
