/**
 * Group editor (M4.2, stage 6a) — the create / edit form for a contact GROUP. A reduced
 * {@link ./ContactForm}: only a name and a member set, because a group card carries nothing else the
 * user edits. Membership is a picker over the account's existing cards; each pick stores that card's
 * JSContact **`uid`** (not its JMAP `id`) in the group's `members` set.
 *
 * **Async-seam discipline (this project's top bug class).** The draft is initialised ONCE from the
 * card via a lazy `useState` initialiser and the diff base is captured ONCE in a ref — a later stale
 * live-query echo of the card can never reach in and reset the name a user is mid-typing or a member
 * they just added. The form reads and writes only its local draft until Save.
 *
 * The write is computed by {@link ./contact-group-mapping}: a full `kind: 'group'` card for a create,
 * a minimal {@link PatchObject} for an edit, both preserving `uid`, `addressBookIds`, `vCardProps` and
 * every property the form does not surface. This component never touches the outbox — it hands the
 * result to `onSubmit`, which the screen wires to the stage-5a enqueue helpers.
 */

import type { ContactCard, Id, PatchObject } from '@waxwing/jmap'
import { Plus, X } from 'lucide-react'
import { type FormEvent, useCallback, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactCardRow } from '../sync'
import { Avatar, Button, IconButton, TextInput } from '../ui'
import { contactDisplayName, contactMatches } from './contact-fields'
import {
  createGroupCard,
  diffGroupPatch,
  type GroupDraft,
  groupToDraft,
  type IdSource,
} from './contact-group-mapping'
import styles from './contacts.module.css'

/** The result the form hands back — a whole card to create, or a minimal patch to update. */
export type GroupFormSubmit =
  | { readonly kind: 'create'; readonly card: ContactCard }
  | { readonly kind: 'update'; readonly cardId: Id; readonly patch: PatchObject }

export interface GroupFormProps {
  readonly mode: 'create' | 'edit'
  /** The group card being edited (required for `mode === 'edit'`). */
  readonly card?: ContactCardRow
  /** Target book for a create / context book for an edit — the group must belong to a book. */
  readonly bookId: Id
  /** The cards the picker offers as members (groups are filtered out by the caller). */
  readonly candidates: readonly ContactCardRow[]
  readonly onSubmit: (submit: GroupFormSubmit) => void
  readonly onCancel: () => void
  /** Defence in depth: `false` disables Save and shows a read-only notice. Default `true`. */
  readonly canWrite?: boolean
  /** Injected in tests for deterministic uids. */
  readonly newId?: IdSource
}

function displayName(card: ContactCardRow, fallback: string): string {
  const name = contactDisplayName(card).trim()
  return name === '' ? fallback : name
}

export function GroupForm(props: GroupFormProps) {
  const { mode, card, bookId, candidates, onSubmit, onCancel } = props
  const { t } = useTranslation()
  const canWrite = props.canWrite ?? true
  const nameId = useId()
  const pickerId = useId()

  const newId = useMemo<IdSource>(() => props.newId ?? (() => crypto.randomUUID()), [props.newId])

  // Initialised ONCE (lazy) — never re-derived from a later `card` prop.
  const [draft, setDraft] = useState<GroupDraft>(() =>
    card !== undefined ? groupToDraft(card) : { name: '', memberUids: [] },
  )
  const baseRef = useRef<ContactCardRow | null>(card ?? null)
  const [filter, setFilter] = useState('')

  const unknownMember = t('contacts.groups.unknownMember')

  // uid → card, for resolving the current members to names and excluding the edited group itself.
  const byUid = useMemo(() => {
    const index = new Map<string, ContactCardRow>()
    for (const candidate of candidates) index.set(candidate.uid, candidate)
    return index
  }, [candidates])

  const memberSet = useMemo(() => new Set(draft.memberUids), [draft.memberUids])
  const ownUid = baseRef.current?.uid

  const addMember = useCallback((uid: string): void => {
    setDraft((prev) =>
      prev.memberUids.includes(uid) ? prev : { ...prev, memberUids: [...prev.memberUids, uid] },
    )
  }, [])

  const removeMember = useCallback((uid: string): void => {
    setDraft((prev) => ({ ...prev, memberUids: prev.memberUids.filter((id) => id !== uid) }))
  }, [])

  // Candidates offered to ADD: not already a member, not the group itself, matching the filter.
  const needle = filter.trim().toLowerCase()
  const pickable = useMemo(
    () =>
      candidates.filter(
        (candidate) =>
          candidate.uid !== ownUid &&
          !memberSet.has(candidate.uid) &&
          contactMatches(candidate, needle),
      ),
    [candidates, ownUid, memberSet, needle],
  )

  const handleSubmit = useCallback(
    (event: FormEvent): void => {
      event.preventDefault()
      if (!canWrite || draft.name.trim() === '') return
      if (mode === 'create') {
        onSubmit({ kind: 'create', card: createGroupCard(draft, bookId, newId) })
        return
      }
      const current = baseRef.current
      if (current === null) return
      const patch = diffGroupPatch(current, draft)
      if (Object.keys(patch).length === 0) {
        onCancel()
        return
      }
      onSubmit({ kind: 'update', cardId: current.id, patch })
    },
    [canWrite, draft, mode, bookId, newId, onSubmit, onCancel],
  )

  const title = t(mode === 'create' ? 'contacts.groups.newTitle' : 'contacts.groups.editTitle')

  return (
    <form className={styles.form} aria-label={title} onSubmit={handleSubmit}>
      <div className={styles.formToolbar}>
        <Button variant="ghost" type="button" onClick={onCancel}>
          {t('contacts.form.cancel')}
        </Button>
        <h2 className={styles.formTitle}>{title}</h2>
        <Button variant="primary" type="submit" disabled={!canWrite || draft.name.trim() === ''}>
          {t('contacts.form.save')}
        </Button>
      </div>

      {!canWrite && <p className={styles.formNotice}>{t('contacts.form.readOnly')}</p>}

      <section className={styles.formSection}>
        <h3 className={styles.detailSectionTitle}>{t('contacts.groups.sections.name')}</h3>
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={nameId}>
            {t('contacts.groups.name')}
          </label>
          <TextInput
            id={nameId}
            value={draft.name}
            autoComplete="off"
            onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
          />
        </div>
      </section>

      <section className={styles.formSection}>
        <h3 className={styles.detailSectionTitle}>
          {t('contacts.groups.membersCount', { count: draft.memberUids.length })}
        </h3>
        {draft.memberUids.length === 0 ? (
          <p className={styles.groupMemberEmpty}>{t('contacts.groups.noMembers')}</p>
        ) : (
          <ul className={styles.groupMembers}>
            {draft.memberUids.map((uid) => {
              const member = byUid.get(uid)
              const name = member ? displayName(member, unknownMember) : unknownMember
              return (
                <li key={uid} className={styles.groupMemberRow}>
                  <span aria-hidden="true">
                    <Avatar name={name} size="sm" />
                  </span>
                  <span className={styles.groupMemberName}>{name}</span>
                  <IconButton
                    label={t('contacts.groups.removeMember', { name })}
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => removeMember(uid)}
                  >
                    <X />
                  </IconButton>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className={styles.formSection}>
        <h3 className={styles.detailSectionTitle}>{t('contacts.groups.addMembers')}</h3>
        <div className={styles.searchBox}>
          <TextInput
            id={pickerId}
            type="search"
            className={styles.commValue}
            aria-label={t('contacts.groups.searchMembers')}
            placeholder={t('contacts.groups.searchMembers')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {pickable.length === 0 ? (
          <p className={styles.groupMemberEmpty}>{t('contacts.groups.noCandidates')}</p>
        ) : (
          <ul className={styles.groupPicker}>
            {pickable.map((candidate) => {
              const name = displayName(candidate, t('contacts.noName'))
              return (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className={styles.groupPickerItem}
                    aria-label={t('contacts.groups.addNamed', { name })}
                    onClick={() => addMember(candidate.uid)}
                  >
                    <span aria-hidden="true">
                      <Avatar name={name} size="sm" />
                    </span>
                    <span className={styles.groupMemberName}>{name}</span>
                    <Plus aria-hidden="true" className={styles.bookIcon} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </form>
  )
}
