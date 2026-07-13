/**
 * Public type surface for `@waxwing/jmap`.
 *
 * SP.1 ships the RFC 8620 core types and the RFC 8621 mail types (Mailbox, Thread, Email).
 * Remaining data-type modules are added here as they land — the layout is reserved now so
 * later phases only append:
 *
 *   export * from './blob'        // RFC 9404  — Blob/upload, Blob/get, Blob/lookup
 *   export * from './sieve'       // RFC 9661  — SieveScript
 *   export * from './contacts'    // RFC 9610  — AddressBook, ContactCard
 */
export * from './core'
export * from './mail'
// RFC 8620 §7 push + RFC 8887 WebSocket wire frames (StateChange, Request/Response, …).
export * from './push'
// RFC 9425 — Quota (M3.7, FR-QTA-01).
export * from './quota'
// RFC 8621 §6 — EmailSubmission / Identity (M2.5 uses Identity).
export * from './submission'
// RFC 8621 §8 — VacationResponse (M3.7, FR-VAC-01).
export * from './vacation'
