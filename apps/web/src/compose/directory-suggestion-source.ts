/**
 * The organisation directory as a recipient-suggestion source (S-5).
 *
 * `Principal/get` returns **every user of the organisation to every user of it, with no share of any
 * kind** — measured against Stalwart v0.16.18: alice, bob and carol each see all three. Waxwing had
 * been spending that on one thing only, the file share picker, while the composer could not offer a
 * colleague whose address the writer did not already know.
 *
 * ## Three rules, and each of them is a measurement
 *
 * **1. Two characters, minimum.** One character matches nothing useful and costs a round trip per
 * keystroke of it.
 *
 * **2. The server matches WHOLE WORDS.** `text:"Baker"` finds Bob Baker; `text:"bak"` finds nobody,
 * and neither does `bak*` — there is no wildcard syntax (re-measured 2026-08-21, see
 * `principalSearchFilter`). So this source is silent until a complete word has been typed and then
 * answers at once. That is the server's behaviour and not something a client can paper over: the
 * alternative would be fetching the whole directory and filtering locally, which is fine for three
 * colleagues and unbounded for three thousand.
 *
 * **3. A FAILURE ANSWERS EMPTY, NEVER THROWS.** The local sources — the recents replica and the
 * contact cards — work offline; this one cannot. A directory that is unreachable must cost the
 * writer nothing, so every failure here becomes "no directory hits" and the addresses the writer
 * already had stay on screen. {@link RecipientField} queries this source SEPARATELY from the local
 * ones for the same reason: merged into `combineSuggestionSources`, one `Promise.all` would hold
 * every local hit back for as long as the network took.
 *
 * Group principals are deliberately skipped. Whether a grant to a group reaches its members is
 * still unmeasured (the sharing plan's standing rule is "do not offer groups until it is"), and a
 * directory group's address is exactly the kind of recipient a writer cannot check afterwards.
 */

import type { Id, JmapClient, Principal } from '@waxwing/jmap'
import { searchPrincipals } from '../sharing/principals'
import type { AddressSuggestion, RecipientSuggestionSource } from './recipient-suggestions'

/** Below this, the directory is not asked. See rule 1. */
export const DIRECTORY_MIN_CHARS = 2

/** How long the field waits after the last keystroke before asking the directory. */
export const DIRECTORY_DEBOUNCE_MS = 250

/**
 * The organisation a directory hit belongs to — the mail domain, which is the only affiliation
 * Stalwart's `Principal` carries (there is no `organization` property; measured).
 *
 * Rendered as a quiet line under the name rather than a badge: it is what tells a reader that a row
 * came from the company directory instead of their own address book, and it says so by stating a
 * fact about the person rather than by labelling the row.
 */
export function principalOrganization(email: string): string | undefined {
  const at = email.lastIndexOf('@')
  const domain = at === -1 ? '' : email.slice(at + 1)
  return domain === '' ? undefined : domain
}

/** One principal as an option, or `undefined` for one that can never become a recipient. */
export function directorySuggestion(principal: Principal): AddressSuggestion | undefined {
  if (principal.type === 'group') return undefined
  const email = principal.email ?? ''
  if (email === '') return undefined
  // `description` is the human name ("Bob Baker"); `name` is the login address, which the second
  // line already shows. Falling back to `null` lets the option render the address as its title.
  const name = principal.description ?? null
  const organization = principalOrganization(email)
  return {
    name: name === '' ? null : name,
    email,
    ...(organization === undefined ? {} : { organization }),
  }
}

export interface DirectorySourceOptions {
  readonly client: JmapClient | null
  readonly accountId: Id | null
  /** Excluded from the results — the writer is not a colleague they need to look up. */
  readonly selfPrincipalId?: Id | null
}

/**
 * A {@link RecipientSuggestionSource} over `Principal/query` + `Principal/get`.
 *
 * Answers `[]` — never rejects — for a short needle, a missing session, or any failure at all.
 */
export function createDirectorySuggestionSource(
  options: DirectorySourceOptions,
): RecipientSuggestionSource {
  const { client, accountId, selfPrincipalId = null } = options
  return {
    async query(prefix, limit) {
      const needle = prefix.trim()
      if (client === null || accountId === null) return []
      if (needle.length < DIRECTORY_MIN_CHARS || limit <= 0) return []
      try {
        const principals = await searchPrincipals(client, accountId, needle, selfPrincipalId)
        const out: AddressSuggestion[] = []
        const seen = new Set<string>()
        for (const principal of principals) {
          const suggestion = directorySuggestion(principal)
          if (suggestion === undefined) continue
          const key = suggestion.email.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          out.push(suggestion)
          if (out.length >= limit) break
        }
        return out
      } catch {
        // Rule 3. Nothing is logged and nothing is shown: the writer asked for an address, not for
        // a report on the directory server.
        return []
      }
    },
  }
}
