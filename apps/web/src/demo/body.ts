/**
 * Pure helpers over the RFC 8621 Email body shape used by the SP.4 demo message view.
 * `Email/get` with `fetchTextBodyValues`/`fetchHTMLBodyValues` populates `bodyValues` keyed
 * by `partId`; these join the referenced parts into a single string for display.
 */

import type { EmailAddress, EmailBodyPart, EmailBodyValue } from '@waxwing/jmap'

/** Joins the decoded values of the referenced body parts, in order. */
export function joinBody(
  parts: EmailBodyPart[] | undefined,
  values: Record<string, EmailBodyValue> | undefined,
): string {
  if (!parts || !values) return ''
  return parts
    .map((part) => (part.partId ? (values[part.partId]?.value ?? '') : ''))
    .filter((value) => value.length > 0)
    .join('\n\n')
}

/** An Email is unread when it carries neither `$seen` nor (for drafts) is otherwise seen. */
export function isUnread(keywords: Record<string, true> | undefined): boolean {
  return !keywords?.$seen
}

/** Formats an address list as `Name <email>` (or just the address), comma-separated. */
export function formatAddresses(addresses: EmailAddress[] | null | undefined): string {
  if (!addresses || addresses.length === 0) return ''
  return addresses
    .map((address) => (address.name ? `${address.name} <${address.email}>` : address.email))
    .join(', ')
}

/** The display label for a list row's sender: the first address's name, else its email. */
export function senderLabel(addresses: EmailAddress[] | null | undefined): string {
  const first = addresses?.[0]
  if (!first) return ''
  return first.name ?? first.email
}
