/**
 * Public type surface for `@waxwing/jmap`.
 *
 * SP.1 ships the RFC 8620 core types and the RFC 8621 mail types (Mailbox, Thread, Email).
 * Remaining data-type modules are added here as they land — the layout is reserved now so
 * later phases only append:
 *
 *   export * from './blob'        // RFC 9404  — Blob/upload, Blob/get, Blob/lookup
 */
// RFC 9610 — AddressBook, ContactCard (M4.2). Types only; ContactCard extends the JSContact
// `Card` from `@waxwing/jscontact` via an erased `import type`, so no runtime edge is added.
export * from './contacts'
export * from './core'
export * from './mail'
// RFC 8620 §7 push + RFC 8887 WebSocket wire frames (StateChange, Request/Response, …).
export * from './push'
// RFC 9425 — Quota (M3.7, FR-QTA-01).
export * from './quota'
// RFC 9661 — SieveScript (M5.2, FR-SIEVE-01/02).
export * from './sieve'
// RFC 8621 §6 — EmailSubmission / Identity (M2.5 uses Identity).
export * from './submission'
// RFC 8621 §8 — VacationResponse (M3.7, FR-VAC-01).
export * from './vacation'
