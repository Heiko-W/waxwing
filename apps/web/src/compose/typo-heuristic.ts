/**
 * Local "did you mean …?" heuristic for recipient domains (M2.4, FR-CMP-05). Pure, never leaves the
 * device: compares a typed address's domain against a short list of common providers by Levenshtein
 * distance and suggests the nearest correction (e.g. `gmial.com` → `gmail.com`). Deliberately
 * conservative — only within {@link suggestDomainCorrection}'s `maxDistance`, and never for a domain
 * that is already a known provider.
 */

import { isPlausibleEmail } from './address-validation'

/** Common consumer providers, en + de (the `de` bundle ships). Compared case-insensitively. */
export const COMMON_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  't-online.de',
  'freenet.de',
  'yahoo.de',
  'hotmail.de',
  'outlook.de',
]

/** Levenshtein edit distance (insert/delete/substitute = 1). Exported for tests. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 0; i < a.length; i += 1) {
    const current = [i + 1]
    for (let j = 0; j < b.length; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1
      const deletion = (previous[j + 1] ?? 0) + 1
      const insertion = (current[j] ?? 0) + 1
      const substitution = (previous[j] ?? 0) + cost
      current.push(Math.min(deletion, insertion, substitution))
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

/**
 * Suggest a corrected full email (localpart@correctedDomain), or `null` when there is nothing to
 * suggest: the input isn't plausible, the domain is already a known provider, or the nearest
 * provider is farther than `maxDistance` (default 2) or an exact match.
 */
export function suggestDomainCorrection(email: string, maxDistance = 2): string | null {
  if (!isPlausibleEmail(email)) return null
  const trimmed = email.trim()
  const at = trimmed.lastIndexOf('@')
  const domain = trimmed.slice(at + 1).toLowerCase()
  if (COMMON_EMAIL_DOMAINS.includes(domain)) return null

  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of COMMON_EMAIL_DOMAINS) {
    const distance = levenshtein(domain, candidate)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  if (best === null || bestDistance === 0 || bestDistance > maxDistance) return null
  return `${trimmed.slice(0, at + 1)}${best}`
}
