/**
 * Contact detail (M4.2) — a single {@link ContactCard} rendered read-only. Loads the card via
 * {@link useContactCard} and lays out the common JSContact fields (name, emails, phones, addresses,
 * organization / title, birthday, notes) the way Apple Contacts groups them. The photo comes from the
 * card's media blob ({@link useContactPhoto}) with an initials fallback.
 *
 * READ-ONLY this stage: the Edit affordance is present but disabled — the seam for stage 5 (create /
 * edit), which is where its handler and the field editors land. Nothing here writes.
 */

import type { ContactCardMedia, Id } from '@waxwing/jmap'
import { Mail as MailIcon, Pencil, Phone as PhoneIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { type ContactCardRow, useContactCard, useReplica } from '../sync'
import { Avatar, Button, Spinner } from '../ui'
import {
  communicationTypeKey,
  contactBirthday,
  contactDisplayName,
  contactOrganization,
  contactPhoto,
  contactTitle,
  formatAddressLines,
  formatBirthday,
  preferredEntries,
} from './contact-fields'
import styles from './contacts.module.css'
import { useContactPhoto } from './use-contact-photo'

export interface ContactDetailProps {
  /** The card to show, or `undefined` when nothing is selected (renders the empty state). */
  readonly cardId: Id | undefined
}

export function ContactDetail({ cardId }: ContactDetailProps) {
  const { t } = useTranslation()
  const card = useContactCard(cardId ?? '')

  if (cardId === undefined) {
    return <p className={styles.detailEmpty}>{t('contacts.detail.empty')}</p>
  }
  if (card === undefined) {
    return (
      <div className={styles.detailLoading}>
        <Spinner label={t('contacts.detail.loading')} />
      </div>
    )
  }
  return <ContactCardView card={card} />
}

function ContactCardView({ card }: { card: ContactCardRow }) {
  const { t, i18n } = useTranslation()
  const name = contactDisplayName(card) || t('contacts.noName')
  const organization = contactOrganization(card)
  const title = contactTitle(card)
  const birthday = contactBirthday(card)
  const emails = preferredEntries(card.emails)
  const phones = preferredEntries(card.phones)
  const addresses = preferredEntries(card.addresses)
  const notes = preferredEntries(card.notes)

  return (
    <article className={styles.detail} aria-label={name}>
      <header className={styles.detailHeader}>
        <ContactPhoto card={card} name={name} />
        <div className={styles.detailIdentity}>
          <h2 className={styles.detailName}>{name}</h2>
          {(title || organization) && (
            <p className={styles.detailOrg}>{[title, organization].filter(Boolean).join(' · ')}</p>
          )}
        </div>
        {/* Read-only this stage: the create/edit editors (and this button's handler) land in stage 5. */}
        <Button variant="ghost" disabled>
          <Pencil aria-hidden="true" />
          {t('contacts.detail.edit')}
        </Button>
      </header>

      {emails.length > 0 && (
        <DetailSection title={t('contacts.detail.sections.email')}>
          {emails.map(([id, email]) => (
            <FieldRow
              key={id}
              label={typeLabel(t, email)}
              icon={<MailIcon aria-hidden="true" className={styles.fieldIcon} />}
            >
              <a href={`mailto:${email.address}`} className={styles.fieldLink}>
                {email.address}
              </a>
            </FieldRow>
          ))}
        </DetailSection>
      )}

      {phones.length > 0 && (
        <DetailSection title={t('contacts.detail.sections.phone')}>
          {phones.map(([id, phone]) => (
            <FieldRow
              key={id}
              label={typeLabel(t, phone)}
              icon={<PhoneIcon aria-hidden="true" className={styles.fieldIcon} />}
            >
              <a href={`tel:${phone.number}`} className={styles.fieldLink}>
                {phone.number}
              </a>
            </FieldRow>
          ))}
        </DetailSection>
      )}

      {addresses.length > 0 && (
        <DetailSection title={t('contacts.detail.sections.address')}>
          {addresses.map(([id, address]) => (
            <FieldRow key={id} label={typeLabel(t, address)}>
              <address className={styles.fieldAddress}>
                {formatAddressLines(address).map((line) => (
                  <span key={line} className={styles.fieldAddressLine}>
                    {line}
                  </span>
                ))}
              </address>
            </FieldRow>
          ))}
        </DetailSection>
      )}

      {birthday && (
        <DetailSection title={t('contacts.detail.sections.birthday')}>
          <FieldRow>
            <span>{formatBirthday(birthday, i18n.language) ?? ''}</span>
          </FieldRow>
        </DetailSection>
      )}

      {notes.length > 0 && (
        <DetailSection title={t('contacts.detail.sections.note')}>
          {notes.map(([id, note]) => (
            <FieldRow key={id}>
              <p className={styles.fieldNote}>{note.note}</p>
            </FieldRow>
          ))}
        </DetailSection>
      )}
    </article>
  )
}

function ContactPhoto({ card, name }: { card: ContactCardRow; name: string }) {
  const { accountId } = useReplica()
  const media: ContactCardMedia | undefined = contactPhoto(card)
  const url = useContactPhoto(accountId, media)
  if (url === undefined) {
    return (
      <Avatar
        name={name}
        size="lg"
        {...(styles.detailAvatar ? { className: styles.detailAvatar } : {})}
      />
    )
  }
  return (
    // The name is the accessible identity (the <h2> beside it), so the photo itself is decorative here.
    <img src={url} alt="" className={styles.detailPhoto} />
  )
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.detailSection}>
      <h3 className={styles.detailSectionTitle}>{title}</h3>
      <div className={styles.detailSectionBody}>{children}</div>
    </section>
  )
}

function FieldRow({
  label,
  icon,
  children,
}: {
  label?: string | undefined
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={styles.fieldRow}>
      {icon}
      <div className={styles.fieldMain}>
        {label !== undefined && <span className={styles.fieldLabel}>{label}</span>}
        <div className={styles.fieldValue}>{children}</div>
      </div>
    </div>
  )
}

/**
 * The localized type label for a communication entry. A user-typed free-text `label` wins (it is data,
 * shown verbatim); otherwise a KNOWN feature/context key (`mobile`, `work`, …) is translated, and an
 * unrecognised key is dropped rather than shown raw — so nothing untranslated ever reaches the screen.
 */
function typeLabel(
  t: ReturnType<typeof useTranslation>['t'],
  entry: {
    readonly label?: string
    readonly features?: Readonly<Record<string, true>>
    readonly contexts?: Readonly<Record<string, true>>
  },
): string | undefined {
  const free = entry.label?.trim()
  if (free) return free
  const key = communicationTypeKey(entry)
  if (key === undefined) return undefined
  const translated = t(`contacts.labels.${key}`, { defaultValue: '' })
  return translated === '' ? undefined : translated
}
