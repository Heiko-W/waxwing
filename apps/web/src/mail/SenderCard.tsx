/**
 * Sender hover-card (M4.3-b, FR-CON-05) — a lightweight interactive popover raised from the reading
 * pane's sender avatar. Deliberately NEITHER of two nearby primitives:
 *
 *  - NOT `ui/Tooltip`: a tooltip is an `aria-describedby` hint and per APG may hold no interactive
 *    control — this card carries links/buttons, so it is a `dialog`.
 *  - NOT `contacts/ContactDetail`: that would pull the Contacts detail graph (and its edit form) into
 *    the eager mail bundle. This shows only the sender's photo, name and primary address plus the two
 *    or three actions a reader wants, built from the contacts area's PURE helpers/hooks only.
 *
 * a11y (APG dialog): rendered through a {@link Portal} as a `role="dialog"` labelled by the sender's
 * name, with `aria-modal` while focus is trapped inside ({@link useFocusTrap}). Escape or an outside
 * press closes it, and closing returns focus to the trigger (the focus trap restores it on unmount).
 * The trigger itself is a real `button` carrying `aria-haspopup="dialog"`/`aria-expanded` — see
 * {@link MessageView}.
 *
 * Async-seam discipline (this project's top bug class): `useAccountContactCards` is a liveQuery that
 * is briefly `undefined`; the add-vs-edit action is WITHHELD until the cards resolve, so it can never
 * flicker from "Add" to "Edit" (or crash reading `undefined`) as they load. The "Last conversation"
 * link needs no card and is always present.
 */

import type { Id } from '@waxwing/jmap'
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { contactsPath, mailPath, useNavigate } from '../app/route'
import { contactDisplayName, contactPhoto } from '../contacts/contact-fields'
import { useContactActions } from '../contacts/use-contact-actions'
import { useAccountContactCards } from '../contacts/use-contact-groups'
import { useContactPhoto } from '../contacts/use-contact-photo'
import { useAddressBooks } from '../sync'
import { Avatar, Button, Portal, useFocusTrap, useToast } from '../ui'
import styles from './SenderCard.module.css'
import {
  findCardByEmail,
  pickWritableBook,
  type SenderIdentity,
  senderToContactCard,
} from './sender-contact'

export interface SenderCardProps {
  readonly from: SenderIdentity
  readonly accountId: Id
  /** The mailbox being read in, for the "Last conversation" search route; `undefined` = all mail. */
  readonly mailboxId: string | undefined
  /** The trigger the popover positions against and returns focus to on close. */
  readonly anchorRef: RefObject<HTMLElement | null>
  readonly onClose: () => void
}

export function SenderCard({ from, accountId, mailboxId, anchorRef, onClose }: SenderCardProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { toast } = useToast()
  const actions = useContactActions()
  const cards = useAccountContactCards()
  const books = useAddressBooks()

  const panelRef = useRef<HTMLDivElement>(null)
  const nameId = useId()
  const [coords, setCoords] = useState({ top: 0, left: 0 })

  // `undefined` while the cards liveQuery is loading — keep it distinct from "loaded, no match".
  const match = cards === undefined ? undefined : findCardByEmail(cards, from.email)
  const contactName = match !== undefined ? contactDisplayName(match).trim() : ''
  const displayName = contactName !== '' ? contactName : from.name?.trim() || from.email
  const photoSrc = useContactPhoto(accountId, match !== undefined ? contactPhoto(match) : undefined)
  const targetBook = pickWritableBook(books)

  // Position against the anchor on mount (same fixed-coords approach as the label popover).
  useEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) setCoords({ top: rect.bottom + 4, left: rect.left })
  }, [anchorRef])

  // Focus in on open, trap Tab while open, and restore focus to the trigger on unmount (APG dialog).
  useFocusTrap(true, panelRef)

  // Escape and outside-pointer dismissal. Focus restoration is the trap's job on unmount; the anchor
  // counts as "inside" so its own toggle click just closes rather than immediately re-opening.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node | null
      if (target === null) return
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [anchorRef, onClose])

  const onAdd = useCallback(async () => {
    if (targetBook === undefined) return
    // The seed round-trips as-is: `create` overwrites `id` with the outbox creation id and the server
    // assigns the `uid` (see `senderToContactCard`). Undo removes the just-created card (M4.2 outbox).
    const newId = await actions.create(senderToContactCard(from, targetBook.id))
    onClose()
    toast({
      title: t('reading.senderCard.added'),
      action: { label: t('list.undo'), onAction: () => actions.remove(newId) },
    })
  }, [actions, from, targetBook, onClose, toast, t])

  const onEdit = useCallback(() => {
    if (match === undefined) return
    onClose()
    navigate(contactsPath(Object.keys(match.addressBookIds)[0], match.id))
  }, [match, navigate, onClose])

  const onLastConversation = useCallback(() => {
    // Same param names the search box uses (`use-search.ts` → `goto`): `q` holds a `from:` operator
    // token and `scope=all` searches every folder, newest first — the last conversation at the top.
    const params = new URLSearchParams()
    params.set('q', `from:${from.email}`)
    params.set('scope', 'all')
    onClose()
    navigate(`${mailPath(mailboxId)}?${params.toString()}`)
  }, [from.email, mailboxId, navigate, onClose])

  return (
    <Portal>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={nameId}
        tabIndex={-1}
        className={styles.senderCard}
        style={{ position: 'fixed', top: coords.top, left: coords.left }}
      >
        <div className={styles.head}>
          <Avatar name={displayName} size="lg" {...(photoSrc !== undefined ? { photoSrc } : {})} />
          <div className={styles.identity}>
            <p id={nameId} className={styles.name}>
              {displayName}
            </p>
            <p className={styles.email}>{from.email}</p>
          </div>
        </div>
        <div className={styles.actions}>
          {cards !== undefined &&
            (match !== undefined ? (
              <Button variant="ghost" size="sm" onClick={onEdit}>
                {t('reading.senderCard.edit')}
              </Button>
            ) : (
              <Button variant="ghost" size="sm" disabled={targetBook === undefined} onClick={onAdd}>
                {t('reading.senderCard.add')}
              </Button>
            ))}
          <Button variant="ghost" size="sm" onClick={onLastConversation}>
            {t('reading.senderCard.lastConversation')}
          </Button>
        </div>
      </div>
    </Portal>
  )
}
