/**
 * Recognising a `winmail.dat` container (M5.21).
 *
 * Separate from `tnef.ts` for one concrete reason: the attachment strip needs this predicate on
 * every render, while the decoder is wanted only when someone clicks. A module that is BOTH
 * statically and dynamically imported cannot be split out — Rollup says so
 * (`INEFFECTIVE_DYNAMIC_IMPORT`) and folds it into the eager chunk. Keeping the cheap test here and
 * the parser there is what makes `import('./tnef')` actually lazy, and it was measured: with the
 * two in one file the initial bundle grew by ~1 KB gz and no `tnef-*.js` chunk was emitted at all.
 */

/** Whether this part is a TNEF container, by declared type or by the name Outlook always uses. */
export function isTnefPart(
  type: string | null | undefined,
  name: string | null | undefined,
): boolean {
  const media = (type ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (media === 'application/ms-tnef' || media === 'application/vnd.ms-tnef') return true
  // Some relays rewrite the type to octet-stream and leave only the name behind.
  return (name ?? '').trim().toLowerCase() === 'winmail.dat' && media === 'application/octet-stream'
}
