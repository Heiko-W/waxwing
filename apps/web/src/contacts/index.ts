/**
 * Public surface of the contacts area for consumers OUTSIDE it (M4.2, stage 6a). Today this is the
 * recipient-EXPANSION seam the composer integration (M4.3) calls to turn a contact group into the
 * recipient pills its members resolve to, plus the pure group helpers that seam is expressed in.
 *
 * Deliberately re-exports only PURE functions and types — no React components — so importing the seam
 * can never drag the lazy `ContactsPage` chunk into an eager one. {@link expandGroup} returns
 * `EmailAddress[]` in the JMAP mail shape, the exact element type
 * {@link import('../compose').RecipientSuggestionSource} yields, so M4.3 consumes it without a
 * conversion layer.
 */

export {
  type GroupDraft,
  groupMemberUids,
  groupName,
  isGroupCard,
} from './contact-group-mapping'
export { expandGroup, expandGroupMembers, indexCardsByUid } from './expand-group'
