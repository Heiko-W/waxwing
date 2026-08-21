/**
 * The JMAP seam for Stalwart's self-service registry (`urn:stalwart:jmap`): app passwords, the
 * account password, the server-side account settings, the account's public keys and its spam
 * training samples.
 *
 * ── Why this is allowed to exist at all ──────────────────────────────────────────────────────
 * Product principle 6 forbids *requiring* a proprietary extension, not using one: "Stalwart-specific
 * niceties are progressive enhancements." Everything here is therefore gated on
 * {@link serverSupportsSelfService}, and the gate is not cosmetic — RFC 8620 §3.3 obliges a server
 * to fail the WHOLE request with `unknownCapability` when it does not know a `using` entry, so a
 * single one of these calls against a non-Stalwart server would take out the batch it rides in. The
 * URN is opted into per call (`CallOptions.using`), never added to `PREFIX_TO_CAPABILITY`.
 *
 * ── Where the capability is advertised, and where it is NOT ──────────────────────────────────
 * `urn:stalwart:jmap` is **absent from the session-level `capabilities`** and present only in
 * `accounts[id].accountCapabilities` (and `primaryAccounts`). Measured against the pinned fixture,
 * v0.16.18: 17 top-level URNs, none of them this one. A probe written against `session.capabilities`
 * finds nothing and hides the section on the very server it was built for — the mirror image of the
 * `getMailCapability` trap `capabilities-model.ts` documents. `hasCapability(session, urn,
 * accountId)` asks both levels, which is why it is the one used here.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────────────────
 *  - **TOTP / two-factor (`x:AccountPassword/set` with `otpAuth`).** It works — but switching it on
 *    disables HTTP Basic for the account (`402 MFA required`; `mfa_token` is filled by the OAuth
 *    login endpoint alone, while `authenticate.rs`, IMAP, POP3 and SASL all pass `None`). Waxwing
 *    signs in with Basic (`auth/controller.ts` `buildBasicSession`), so the switch would lock the
 *    reader out of the client they threw it from. An app password would get them back in — and an
 *    app password bypasses the second factor entirely, which is not two-factor authentication, it
 *    is a longer password. Offering it needs an MFA-capable login first.
 *  - **`x:ApiKey/*`.** Same feature as an app password with a Bearer header instead of Basic; its
 *    audience is scripts, not mail apps.
 *  - **Turning encryption at rest ON, and `x:PublicKey` create/destroy.** Waxwing has no OpenPGP
 *    stack: it cannot display a message the server has encrypted. A switch that makes the reader's
 *    own mailbox unreadable to the client offering the switch is not a feature. The state is read
 *    and reported; it is not written.
 *  - **`ifInState`.** These `/get`s return no `state` (measured), so there is nothing to send.
 *    Writes are last-one-wins and every one of them re-reads.
 */

import type { Id, JmapClient } from '@waxwing/jmap'
import { hasCapability, JmapMethodError } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'
import {
  type AppPasswordView,
  type EncryptionView,
  type PublicKeyView,
  REGISTRY_SINGLETON,
  type SpamSampleView,
  toAppPassword,
  toEncryption,
  toPublicKey,
  toSpamSample,
  type WireAccountSettings,
  type WireAppPassword,
  type WirePublicKey,
  type WireSpamSample,
} from './stalwart-model'

/** Stalwart's registry capability. Proprietary, hence every use of it sits behind a check. */
export const STALWART_CAPABILITY = 'urn:stalwart:jmap'

/** Does this server offer its self-service registry on this account? */
export function serverSupportsSelfService(
  session: JmapSession | null,
  accountId: string | null,
): boolean {
  if (session === null || accountId === null) return false
  return hasCapability(session, STALWART_CAPABILITY, accountId)
}

/**
 * A `/set` the server refused per object.
 *
 * `serverDescription` is carried separately from `message` and is shown to the reader **verbatim**,
 * under a translated sentence. That is a deliberate, documented compromise: the two refusals of a
 * password change — `forbidden` "Current secret is incorrect." and `forbidden` "Operation not
 * allowed." (an external LDAP/SQL directory owns the password) — are the same `type`, and telling
 * them apart would mean matching English server prose that is free to change between releases. A
 * translated headline plus the server's own words is honest; a guess dressed as a translation is
 * not.
 */
export class StalwartSetError extends Error {
  readonly properties: readonly string[]

  constructor(
    readonly type: string,
    readonly serverDescription: string | null,
    properties?: readonly string[],
  ) {
    super(serverDescription ?? type)
    this.name = 'StalwartSetError'
    this.properties = properties ?? []
  }
}

/**
 * One read of everything the section shows.
 *
 * Each field is independently `null`-able and `null` means **"this account may not"**, not "empty".
 * The registry's permissions are per object type (`sysAppPasswordGet`, `sysAccountPasswordUpdate`,
 * …) and a server may withhold any of them — an external directory takes the password away, a
 * restricted app password takes nearly everything away. The section hides the block rather than
 * rendering a control that can only fail (FR-SRV-02: hidden, never broken).
 */
export interface SelfServiceSnapshot {
  readonly appPasswords: readonly AppPasswordView[] | null
  /** The password singleton is readable ⇒ offering to change it is worth the reader's time. */
  readonly passwordReadable: boolean
  /** POSIX locale name, or `null` where the settings singleton is not readable. */
  readonly language: string | null
  readonly encryption: EncryptionView | null
  readonly publicKeys: readonly PublicKeyView[]
  readonly spamSamples: readonly SpamSampleView[] | null
}

export interface SelfServiceClient {
  load(signal?: AbortSignal): Promise<SelfServiceSnapshot>
  /**
   * Creates an app password and returns the **only copy of the secret that will ever exist**.
   *
   * Every later `/get` answers `"****"`. The caller must keep it in component state and nowhere
   * else: not in the replica, not in `localStorage`, not in a log line.
   */
  createAppPassword(input: {
    description: string
    expiresAt: string | null
  }): Promise<{ readonly id: Id; readonly secret: string }>
  destroyAppPassword(id: Id): Promise<void>
  /** `currentSecret` is mandatory; the server bans an account that gets it wrong too often. */
  changePassword(currentSecret: string, secret: string): Promise<void>
  setLanguage(locale: string): Promise<void>
  destroySpamSample(id: Id): Promise<void>
}

/** A SetError as servers really send it — looser than the package's, whose `description` is required. */
interface WireSetError {
  type: string
  description?: string | null
  properties?: string[]
  /** Stalwart's registry shape for a missing/invalid field, alongside (not instead of) the above. */
  validationErrors?: { type?: string; property?: string }[]
}

interface SetEcho<T> {
  created?: Record<string, T> | null
  notCreated?: Record<string, WireSetError> | null
  updated?: Record<Id, unknown> | null
  notUpdated?: Record<Id, WireSetError> | null
  destroyed?: Id[] | null
  notDestroyed?: Record<Id, WireSetError> | null
}

interface GetEcho<T> {
  list: T[]
}

/** The creation id a single create uses. */
const NEW = 'new'

function toSetError(wire: WireSetError): StalwartSetError {
  const fromValidation = (wire.validationErrors ?? [])
    .map((one) => one.property)
    .filter((one): one is string => typeof one === 'string')
  const properties = wire.properties ?? fromValidation
  return new StalwartSetError(wire.type, wire.description ?? null, properties)
}

export function makeSelfServiceClient(client: JmapClient, accountId: Id): SelfServiceClient {
  /**
   * Reads that a server is allowed to refuse one by one.
   *
   * `MethodResponses.get()` throws `JmapMethodError` for a method-level error, and `forbidden` is
   * the registry's answer to "you do not hold `sysXGet`". That is a fact about this account, not a
   * failure of the screen, so it becomes `null` and the block disappears. Anything else — a
   * transport failure, `unknownCapability`, `serverFail` — is re-thrown and surfaces as "could not
   * be loaded", because pretending a broken server is a restricted one would hide a real outage.
   */
  function optional<T>(read: () => T): T | null {
    try {
      return read()
    } catch (thrown) {
      if (thrown instanceof JmapMethodError && thrown.type === 'forbidden') return null
      throw thrown
    }
  }

  async function set<T>(method: string, args: Record<string, unknown>): Promise<SetEcho<T>> {
    const responses = await client.call([[method, { accountId, ...args }, 's0']], {
      using: [STALWART_CAPABILITY],
    })
    return responses.get<SetEcho<T>>('s0')
  }

  async function load(signal?: AbortSignal): Promise<SelfServiceSnapshot> {
    // ONE round trip for five reads. `x:*/get` with no `ids` means "all of them"; app passwords
    // additionally report the account's OWN credential id under `notFound`, which is why nothing
    // here reads `notFound`.
    const responses = await client.call(
      [
        ['x:AppPassword/get', { accountId }, 'a'],
        ['x:AccountPassword/get', { accountId, ids: [REGISTRY_SINGLETON] }, 'p'],
        ['x:AccountSettings/get', { accountId, ids: [REGISTRY_SINGLETON] }, 's'],
        ['x:PublicKey/get', { accountId }, 'k'],
        ['x:SpamTrainingSample/get', { accountId }, 't'],
      ],
      { using: [STALWART_CAPABILITY], ...(signal ? { signal } : {}) },
    )

    const now = Date.now()
    const passwords = optional(() => responses.get<GetEcho<WireAppPassword>>('a'))
    const password = optional(() => responses.get<GetEcho<unknown>>('p'))
    const settings = optional(() => responses.get<GetEcho<WireAccountSettings>>('s'))
    const keys = optional(() => responses.get<GetEcho<WirePublicKey>>('k'))
    const samples = optional(() => responses.get<GetEcho<WireSpamSample>>('t'))

    const publicKeys = (keys?.list ?? []).map(toPublicKey)
    const singleton = settings?.list[0]

    return {
      appPasswords:
        passwords === null ? null : passwords.list.map((one) => toAppPassword(one, now)),
      passwordReadable: password !== null,
      language: singleton?.locale ?? null,
      encryption: settings === null ? null : toEncryption(singleton?.encryptionAtRest, publicKeys),
      publicKeys,
      spamSamples: samples === null ? null : samples.list.map(toSpamSample),
    }
  }

  return {
    load,

    async createAppPassword(input) {
      const echo = await set<{ id: Id; secret?: string }>('x:AppPassword/set', {
        create: {
          [NEW]: {
            description: input.description,
            ...(input.expiresAt === null ? {} : { expiresAt: input.expiresAt }),
          },
        },
      })
      const refused = echo.notCreated?.[NEW]
      if (refused !== undefined) throw toSetError(refused)
      const created = echo.created?.[NEW]
      // The secret is generated server-side and returned exactly once. No secret means no usable
      // credential, and reporting success would leave a password the reader can never enter.
      if (created === undefined || typeof created.secret !== 'string' || created.secret === '') {
        throw new StalwartSetError('serverFail', null)
      }
      return { id: created.id, secret: created.secret }
    },

    async destroyAppPassword(id) {
      const echo = await set('x:AppPassword/set', { destroy: [id] })
      const refused = echo.notDestroyed?.[id]
      if (refused !== undefined) throw toSetError(refused)
    },

    async changePassword(currentSecret, secret) {
      const echo = await set('x:AccountPassword/set', {
        update: { [REGISTRY_SINGLETON]: { currentSecret, secret } },
      })
      const refused = echo.notUpdated?.[REGISTRY_SINGLETON]
      if (refused !== undefined) throw toSetError(refused)
    },

    async setLanguage(locale) {
      /*
       * ONE property per patch, and that is not tidiness.
       *
       * Measured on v0.16.18: a `x:AccountSettings/set` carrying a valid AND an invalid field
       * answers `notUpdated` — and writes the valid field anyway. A caller that batches has no way
       * to know what landed. With a single property the refusal and the write cannot disagree.
       */
      const echo = await set('x:AccountSettings/set', {
        update: { [REGISTRY_SINGLETON]: { locale } },
      })
      const refused = echo.notUpdated?.[REGISTRY_SINGLETON]
      if (refused !== undefined) throw toSetError(refused)
    },

    async destroySpamSample(id) {
      const echo = await set('x:SpamTrainingSample/set', { destroy: [id] })
      const refused = echo.notDestroyed?.[id]
      if (refused !== undefined) throw toSetError(refused)
    },
  }
}
