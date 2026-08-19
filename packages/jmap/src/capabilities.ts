/**
 * JMAP capability URNs and the method → capability mapping used to auto-manage the
 * request `using` set (RFC 8620 §2, FR-SRV-02).
 */

/** Well-known JMAP capability URNs. Slots for capabilities implemented in later phases are reserved. */
export const Capabilities = {
  /** RFC 8620 — JMAP Core. Always required. */
  core: 'urn:ietf:params:jmap:core',
  /** RFC 8621 — Mailbox, Thread, Email, SearchSnippet. */
  mail: 'urn:ietf:params:jmap:mail',
  /** RFC 8621 — EmailSubmission + Identity. */
  submission: 'urn:ietf:params:jmap:submission',
  /** RFC 8621 — VacationResponse. */
  vacationResponse: 'urn:ietf:params:jmap:vacationresponse',
  /** RFC 9404 — Blob/upload, Blob/get, Blob/lookup. */
  blob: 'urn:ietf:params:jmap:blob',
  /** RFC 9425 — Quota. */
  quota: 'urn:ietf:params:jmap:quota',
  /** RFC 9661 — SieveScript. */
  sieve: 'urn:ietf:params:jmap:sieve',
  /** RFC 9610 — AddressBook + ContactCard. */
  contacts: 'urn:ietf:params:jmap:contacts',
  /** `draft-ietf-jmap-calendars` (RFC Editor queue) — Calendar + CalendarEvent. */
  calendars: 'urn:ietf:params:jmap:calendars',
  /** RFC 8887 — JMAP over WebSocket. */
  webSocket: 'urn:ietf:params:jmap:websocket',
  /** RFC 8620 §8 (JMAP Sharing) — principals. */
  principals: 'urn:ietf:params:jmap:principals',
  /**
   * RFC 9749 — Use of VAPID in JMAP Web Push. Carries the server's `applicationServerKey`.
   *
   * Not a method capability (nothing is added to `PREFIX_TO_CAPABILITY`): it is a pure session-level
   * announcement, read by {@link getWebPushVapidCapability}. `PushSubscription/*` is core.
   */
  webPushVapid: 'urn:ietf:params:jmap:webpush-vapid',
} as const

/** Union of the known capability URN string literals. */
export type CapabilityUrn = (typeof Capabilities)[keyof typeof Capabilities]

/**
 * Method-name prefix (the part before `/`) → capability URN required to invoke it.
 * `Core/*` and unknown prefixes fall back to {@link Capabilities.core}.
 */
const PREFIX_TO_CAPABILITY: Readonly<Record<string, string>> = {
  Core: Capabilities.core,
  Blob: Capabilities.blob,
  PushSubscription: Capabilities.core,
  Mailbox: Capabilities.mail,
  Thread: Capabilities.mail,
  Email: Capabilities.mail,
  SearchSnippet: Capabilities.mail,
  EmailSubmission: Capabilities.submission,
  Identity: Capabilities.submission,
  VacationResponse: Capabilities.vacationResponse,
  Quota: Capabilities.quota,
  SieveScript: Capabilities.sieve,
  AddressBook: Capabilities.contacts,
  ContactCard: Capabilities.contacts,
  Calendar: Capabilities.calendars,
  CalendarEvent: Capabilities.calendars,
  Principal: Capabilities.principals,
  ShareNotification: Capabilities.principals,
}

/**
 * Returns the capability URN a method call opts into, derived from its `Type/verb`
 * name. Unknown types map to the core capability so a request is never emitted without
 * a `using` entry.
 */
export function capabilityForMethod(methodName: string): string {
  const slash = methodName.indexOf('/')
  const prefix = slash === -1 ? methodName : methodName.slice(0, slash)
  return PREFIX_TO_CAPABILITY[prefix] ?? Capabilities.core
}

/**
 * Computes the `using` set for a batch of method names: the core capability plus the
 * capability required by each method, de-duplicated and sorted for stable output.
 */
export function usingForMethods(methodNames: Iterable<string>): string[] {
  const set = new Set<string>([Capabilities.core])
  for (const name of methodNames) set.add(capabilityForMethod(name))
  return [...set].sort()
}
