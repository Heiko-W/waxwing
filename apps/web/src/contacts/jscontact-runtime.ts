/**
 * The jscontact CONVERSION RUNTIME (M4.3, FR-CON-06), isolated behind its own module so a dynamic
 * `import('./jscontact-runtime')` puts it — and everything it transitively pulls in (the vCard lexer,
 * writer and the JSContact⇄vCard mapping, ~26 KB ESM) — into a SEPARATE lazy chunk named after this
 * file. That chunk is fetched only when a user actually imports or exports contacts.
 *
 * This indirection is the whole size story of the etape:
 *
 *  - `contact-fields.ts` and `contact-card-mapping.ts` import `@waxwing/jscontact` as TYPES ONLY, so
 *    the read/edit path carries none of the runtime;
 *  - `contact-io.ts` reaches this runtime EXCLUSIVELY through `import('./jscontact-runtime')`, never a
 *    static import, so the pure IO helpers (dedup, export-card sanitising, JSON parsing) stay in the
 *    contacts chunk while the conversion code lives here;
 *  - the emitted chunk gets a distinct, greppable name (`jscontact-runtime-*.js`) rather than the
 *    `index-*` that a bare `import('@waxwing/jscontact')` would produce (which would collide with the
 *    app entry chunk in `.size-limit.js`).
 *
 * Verified in `dist`: `fromVCard` / `toVCard` / `parseContentLines` appear ONLY in this chunk — not in
 * the entry, not in `ContactsPage`.
 */

export { fromVCard, toVCards } from '@waxwing/jscontact'
