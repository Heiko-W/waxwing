/**
 * The wire shapes of Stalwart's `urn:stalwart:jmap` registry, and the views the Account & security
 * section renders — pure, so the tests assert values rather than pixels.
 *
 * **This is a PROPRIETARY extension, and the file exists to keep that contained** (product
 * principle 6: "Standards over cleverness. JMAP RFCs and drafts only; no proprietary server
 * extensions required. Stalwart-specific niceties are progressive enhancements."). Every shape
 * below follows Stalwart's own schema generator rather than JMAP convention, and each one is
 * measured against the pinned fixture (v0.16.18 on :18080) rather than read off documentation:
 *
 *  - **Singletons carry the literal id `"singleton"`** and have no `/query` at all.
 *  - **A "set" is a MAP, not an array.** `allowedIps: {"127.0.0.1": true}`, `emailAddresses:
 *    {"a@b.test": true}`. An array is rejected with `invalidPatch`.
 *  - **Variant objects carry `@type`** — `encryptionAtRest: {"@type": "Disabled"}`, `permissions:
 *    {"@type": "Inherit"}`.
 *  - **`/get` returns NO `state` string.** There is no `ifInState` to send on a write, so none of
 *    the optimistic-concurrency machinery the identity and vacation clients rely on is available
 *    here. Writes are last-one-wins; the section re-reads after every one.
 *  - Every property is declared optional on the wire types. A registry that gains or loses a field
 *    between server versions must degrade to a missing row, never to a `TypeError` in a settings
 *    screen.
 */

import type { Id } from '@waxwing/jmap'

/** Stalwart's registry singletons all answer to this id (`x:AccountPassword`, `x:AccountSettings`). */
export const REGISTRY_SINGLETON = 'singleton'

// ─── wire ────────────────────────────────────────────────────────────────────────────────────

export interface WireAppPassword {
  readonly id: Id
  readonly description?: string
  readonly createdAt?: string
  readonly expiresAt?: string | null
  /** `{ "@type": "Inherit" | "Disable" | "Replace", permissions?: {…} }`. */
  readonly permissions?: { readonly '@type'?: string } | null
  /** A SET: `{ "127.0.0.1": true }`. Read back normalized (a `/32` mask loses its suffix). */
  readonly allowedIps?: Readonly<Record<string, boolean>> | null
}

/** `{ "@type": "Disabled" | "Aes128" | "Aes256" | "Aes256Gcm" | "ChaCha20Poly1305", … }`. */
export interface WireEncryptionAtRest {
  readonly '@type'?: string
  readonly publicKey?: Id
  readonly encryptOnAppend?: boolean
  readonly allowSpamTraining?: boolean
}

export interface WireAccountSettings {
  readonly id: Id
  /** POSIX name — `en_US`, `de_DE`. A bare `de` is rejected with `invalidPatch`. */
  readonly locale?: string
  readonly timeZone?: string | null
  readonly encryptionAtRest?: WireEncryptionAtRest | null
}

export interface WirePublicKey {
  readonly id: Id
  readonly description?: string
  readonly emailAddresses?: Readonly<Record<string, boolean>> | null
}

export interface WireSpamSample {
  readonly id: Id
  readonly from?: string
  readonly subject?: string
  readonly isSpam?: boolean
  readonly expiresAt?: string | null
}

// ─── views ───────────────────────────────────────────────────────────────────────────────────

export interface AppPasswordView {
  readonly id: Id
  readonly description: string
  readonly createdAt: string | null
  readonly expiresAt: string | null
  /** Its own clock has run out — the server refuses it, so the row says so instead of looking live. */
  readonly expired: boolean
  /**
   * Rights narrowed away from `Inherit`, or an IP allowlist in force.
   *
   * Waxwing never SETS either (see the section's comment on why), so this can only have been done
   * from another client or by an administrator. Reporting it is the difference between "this
   * password does not work" and "this password works only from the office".
   */
  readonly restricted: boolean
}

export type EncryptionView =
  | { readonly kind: 'off' }
  /** `cipher` is the raw `@type` (`Aes256`, `ChaCha20Poly1305`, …) — a name, not a translated word. */
  | { readonly kind: 'on'; readonly cipher: string; readonly keyLabel: string | null }

export interface PublicKeyView {
  readonly id: Id
  readonly description: string
  readonly addresses: readonly string[]
}

export interface SpamSampleView {
  readonly id: Id
  readonly from: string
  readonly subject: string
  readonly isSpam: boolean
}

// ─── mapping ─────────────────────────────────────────────────────────────────────────────────

/** Keys of a Stalwart "set" — `{ "127.0.0.1": true }` — in wire order, with a `null` map as empty. */
function setKeys(map: Readonly<Record<string, boolean>> | null | undefined): readonly string[] {
  if (typeof map !== 'object' || map === null) return []
  return Object.keys(map).filter((key) => map[key] === true)
}

export function toAppPassword(wire: WireAppPassword, now: number): AppPasswordView {
  const expiresAt = wire.expiresAt ?? null
  const parsed = expiresAt === null ? Number.NaN : Date.parse(expiresAt)
  return {
    id: wire.id,
    description: wire.description ?? '',
    createdAt: wire.createdAt ?? null,
    expiresAt,
    // An unparseable date is not an expiry. Saying "expired" because a server sent a format we do
    // not read would tell someone to revoke a credential that is working perfectly.
    expired: Number.isFinite(parsed) && parsed <= now,
    restricted:
      (wire.permissions?.['@type'] !== undefined && wire.permissions['@type'] !== 'Inherit') ||
      setKeys(wire.allowedIps).length > 0,
  }
}

export function toPublicKey(wire: WirePublicKey): PublicKeyView {
  return {
    id: wire.id,
    description: wire.description ?? '',
    addresses: setKeys(wire.emailAddresses),
  }
}

export function toSpamSample(wire: WireSpamSample): SpamSampleView {
  return {
    id: wire.id,
    from: wire.from ?? '',
    subject: wire.subject ?? '',
    isSpam: wire.isSpam ?? false,
  }
}

/**
 * Encryption at rest, resolved against the keys the account holds.
 *
 * `Disabled` and "no `@type` at all" are the same answer — a server that stops sending the field is
 * not a server that started encrypting. Anything else is on, whether or not Waxwing recognises the
 * cipher name: the consequence for the reader (this client cannot display those messages) does not
 * depend on which AES variant it is.
 */
export function toEncryption(
  wire: WireEncryptionAtRest | null | undefined,
  keys: readonly PublicKeyView[],
): EncryptionView {
  const type = wire?.['@type']
  if (type === undefined || type === 'Disabled') return { kind: 'off' }
  const key = keys.find((one) => one.id === wire?.publicKey)
  const label = key === undefined ? null : key.description !== '' ? key.description : key.id
  return { kind: 'on', cipher: type, keyLabel: label }
}

/**
 * The languages the SERVER can actually speak, as POSIX locale names.
 *
 * Stalwart's `Locale` enum has **336** variants, and offering all of them would be a lie in 324
 * cases: `resources/locales/i18n.yml` (v0.16.18) carries translations for exactly twelve languages,
 * and `common::i18n::locale_or_default` silently falls back to English for everything else. So the
 * list is the twelve — the ones where choosing has an effect — sorted by their POSIX name.
 *
 * Every entry is verified to exist in the server's enum (`b"de_DE" => Locale::DeDE`, …); a value
 * outside it comes back as `invalidPatch`, not as a fallback.
 */
export const SERVER_LANGUAGES: readonly string[] = [
  'ca_ES',
  'da_DK',
  'de_DE',
  'el_GR',
  'en_US',
  'es_ES',
  'fr_FR',
  'it_IT',
  'nl_NL',
  'pl_PL',
  'pt_PT',
  'sv_SE',
]

/**
 * The options to offer, given what the account is set to now.
 *
 * A locale outside {@link SERVER_LANGUAGES} is KEPT and offered first. An administrator may have
 * set `ja_JP`; a `<select>` that does not contain the current value silently reports a different
 * one, and the first stray change event would then write it — a settings control that alters a
 * setting by being looked at.
 */
export function languageOptions(current: string | null): readonly string[] {
  if (current === null || current === '' || SERVER_LANGUAGES.includes(current)) {
    return SERVER_LANGUAGES
  }
  return [current, ...SERVER_LANGUAGES]
}

/**
 * A POSIX locale name as a language name in the reader's language — `de_DE` → "Deutsch
 * (Deutschland)" for a German reader, "German (Germany)" for an English one.
 *
 * `Intl.DisplayNames` rather than twelve more locale keys per language: the names are already in
 * the platform, and a hand-maintained table of endonyms is a list that goes stale silently. Falls
 * back to the raw code wherever the platform has no answer, which is honest — an unrecognised code
 * shown as itself is better than an empty option.
 */
export function languageLabel(posix: string, uiLanguage: string): string {
  // `en_IE@euro` and friends: the modifier is not part of a BCP-47 tag.
  const tag = posix.split('@')[0]?.replace('_', '-') ?? posix
  try {
    return new Intl.DisplayNames([uiLanguage], { type: 'language' }).of(tag) ?? posix
  } catch {
    return posix
  }
}

/** How long a new app password may live. `null` ⇒ no expiry, which is what Stalwart defaults to. */
export const APP_PASSWORD_LIFETIMES: readonly (number | null)[] = [null, 30, 90, 365]

/** A lifetime in days → the `expiresAt` instant Stalwart wants (UTC, second precision). */
export function expiryFromDays(days: number | null, now: number): string | null {
  if (days === null) return null
  return `${new Date(now + days * 86_400_000).toISOString().slice(0, 19)}Z`
}
