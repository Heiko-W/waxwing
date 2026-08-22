/**
 * Sharing one object — a file, a mail folder, a calendar, an address book (S-1 … S-4, RFC 9670).
 *
 * Two lists: who has access now, and who could be given it. The rights model is in `roles.ts` plus
 * one spec per object type, tested without rendering; this file is the surface.
 *
 * **The role list comes from the model, not from this file** (S-2). It used to iterate the
 * module-level `SHARE_ROLES`, which was correct while every type had the same three; a calendar has
 * four, because `mayReadFreeBusy` alone is a grant people ask for by name. Reading the list off
 * {@link RoleModel.roles} is the whole of that change here — one `<Select>` renders three options or
 * four, and the picker's default becomes whatever the model calls least rather than the literal
 * "viewer".
 *
 * **Lifted, not rewritten.** This is `files/ShareDialog.tsx` with three things made into parameters —
 * the rights vocabulary ({@link ShareDialogProps.roles}), the write ({@link SharingClient}) and the
 * word for what is being shared ({@link ShareDialogProps.kind}, which selects the explanation
 * texts). Everything else is byte-for-byte the file dialog, because that dialog was the only sharing
 * UI in the app and it worked; `files/ShareDialog.tsx` is now a nine-line binding of this one and
 * its whole test file runs unchanged against the result.
 *
 * **Every change is written immediately**, not on an OK button. A `Foo/set` replaces the whole
 * `shareWith` map, so a dialog holding pending edits would be holding a value that goes stale the
 * moment another client touches the object — and would then overwrite their change on save. Writing
 * each grant as it is made keeps the window in which that can happen as short as a round trip.
 *
 * A grant this client cannot express — set by another client, or in a combination these three roles
 * do not produce — is shown as "custom" and left alone. It can be revoked, because revoking is
 * unambiguous; it cannot be silently rewritten into whichever role looks closest.
 */

import type { Id, Principal } from '@waxwing/jmap'
import { Check, UserMinus, UserPlus } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, EmptyState, SectionLabel, Select, Spinner, TextInput } from '../ui'
import { principalLabel } from './principals'
import type { RightsMap, RoleModel, ShareRole, ShareRoleOrCustom } from './roles'
import styles from './sharing.module.css'

/**
 * The two calls a share dialog makes. Deliberately NOT the object's own client: a mailbox is shared
 * through `Mailbox/set` and a file through `FileNode/set`, and the dialog has no business knowing
 * which — nor which id it is writing to, which the binding closes over.
 */
export interface SharingClient<R extends RightsMap<R>> {
  /**
   * Everyone this account may share with, matching `query` — never including the user themself.
   *
   * An empty query lists everyone rather than nobody: a picker that shows nothing until you type
   * hides the fact that there are only three colleagues to choose from.
   */
  searchPrincipals(query: string): Promise<Principal[]>
  /** Replaces the object's WHOLE grant map. See `roles.ts` on why the rest must be carried over. */
  setShareWith(shareWith: Record<Id, R>): Promise<void>
}

/**
 * Which object type is being shared — picks the explanation texts, nothing else.
 *
 * The roles themselves come from {@link ShareDialogProps.roles}, which is what lets a calendar offer
 * four of them and a mail folder three. This union only decides which sentence explains each one,
 * and every `sharing.explain.<kind>.<role>` key it can reach has to exist: a calendar without
 * `explain.calendar.freeBusy` would render the key itself under the picker.
 */
export type ShareKind = 'file' | 'mailbox' | 'calendar' | 'addressBook'

/**
 * Whether the grant map is here yet.
 *
 * A file node arrives with its `shareWith` attached, so the Files binding never passes anything but
 * the default. A MAILBOX does not — `Mailbox/get` omits the property unless it is asked for
 * (measured) — so it opens on `loading` and this dialog shows a spinner where the two lists go.
 *
 * **The dialog, not the caller, owns those states**, and that is the whole reason this prop exists.
 * A wrapper that rendered its own `<Dialog>` while loading and swapped to this one when ready would
 * unmount a focus trap mid-load: `useFocusTrap` restores focus to the opener on unmount, so the
 * user's focus jumped back to the folder menu the instant the fetch returned. One `<Dialog>`,
 * mounted once, from the first frame to the last.
 */
export type ShareLoadState = 'loading' | 'failed' | 'ready'

export interface ShareDialogProps<R extends RightsMap<R>> {
  /** Already translated: the caller owns the object's name and how it is spelled. */
  readonly title: string
  readonly kind: ShareKind
  readonly roles: RoleModel<R>
  /** The grant map as the server last stated it. Ignored unless {@link state} is `ready`. */
  readonly shareWith: Record<Id, Partial<R>>
  readonly client: SharingClient<R>
  /** Defaults to `ready` — the file case, where the map came with the object. */
  readonly state?: ShareLoadState
  /** Shown instead of the lists when {@link state} is `failed`. Already translated. */
  readonly loadFailedMessage?: string
  onClose: () => void
  /** Called after every successful write, so whatever is behind the dialog stays true. */
  onChanged: () => void
}

/** How long to wait after a keystroke before asking the server. */
const SEARCH_DELAY_MS = 250

export function ShareDialog<R extends RightsMap<R>>({
  title,
  kind,
  roles,
  shareWith: initialShareWith,
  client,
  state = 'ready',
  loadFailedMessage,
  onClose,
  onChanged,
}: ShareDialogProps<R>) {
  const { t } = useTranslation()
  const searchId = useId()
  const roleId = useId()
  const [shareWith, setShareWith] = useState<Record<Id, Partial<R>>>(initialShareWith)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Principal[] | null>(null)
  const [searchFailed, setSearchFailed] = useState(false)
  /*
   * The role the Add button will grant. Seeded from the MODEL rather than from the word "viewer":
   * a calendar's least role is `freeBusy`, and a picker that opened on "View" would make the safe
   * choice the one you have to notice and change.
   */
  const [role, setRole] = useState<ShareRole>(() => roles.roles[0] ?? 'viewer')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  // Names for the ids in `shareWith`: the map holds ids alone, and an id is not something to show
  // a person. Filled from whatever the search has returned so far.
  const [names, setNames] = useState<Record<Id, string>>({})

  // The grant map arrives after the dialog opens for a mailbox, and `useState` keeps its first
  // value — so it is adopted here rather than held as state alone.
  useEffect(() => {
    setShareWith(initialShareWith)
  }, [initialShareWith])

  useEffect(() => {
    // Nothing to search for until there is a list to exclude the already-granted from: candidates
    // are `found` minus `current`, and running it early would offer someone who already has access.
    if (state !== 'ready') return
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const principals = await client.searchPrincipals(query)
          if (cancelled) return
          setSearchFailed(false)
          setFound(principals)
          setNames((current) => {
            const next = { ...current }
            for (const principal of principals) next[principal.id] = principalLabel(principal)
            return next
          })
        } catch {
          // NOT `setFound([])`. Turning a failed request into an empty result told the reader
          // "Nobody matches that", so they concluded the person did not exist and gave up — the
          // one outcome from which there is no way back.
          if (!cancelled) setSearchFailed(true)
        }
      })()
    }, SEARCH_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client, query, state])

  const write = useCallback(
    async (next: Record<Id, Partial<R>>): Promise<void> => {
      setBusy(true)
      setFailed(false)
      try {
        await client.setShareWith(next as Record<Id, R>)
        setShareWith(next)
        onChanged()
      } catch {
        // The local map is deliberately NOT updated: the screen keeps showing what the server still
        // has, which is the only honest thing to show after a write that did not happen.
        setFailed(true)
      } finally {
        setBusy(false)
      }
    },
    [client, onChanged],
  )

  const current = roles.grantees(shareWith)
  const currentIds = new Set(current.map((entry) => entry.principalId))
  const candidates = (found ?? []).filter((principal) => !currentIds.has(principal.id))

  const roleLabel = (value: ShareRoleOrCustom): string =>
    value === 'custom' ? t('sharing.custom') : t(`sharing.role.${value}`)

  /*
   * Which roles this object type offers, and the one the Add button is holding.
   *
   * `offered` is the model's list, not a module constant — see `roles.ts`. `addRole` re-reads it
   * every render because the model can change under a mounted dialog (the Files screen swaps the
   * node behind it), and a `role` that is no longer offered would render a `<Select>` whose value
   * matches no option: React shows the first one and the state says another, so Add would grant
   * something the reader never chose.
   */
  const offered = roles.roles
  const addRole = offered.includes(role) ? role : (offered[0] ?? 'viewer')

  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          <Check aria-hidden="true" />
          {t('sharing.done')}
        </Button>
      }
    >
      {state === 'loading' ? (
        <div className={styles.loading}>
          <Spinner label={t('ui.spinner.label')} />
        </div>
      ) : state === 'failed' ? (
        <EmptyState
          tone="error"
          title={loadFailedMessage ?? t('sharing.failed')}
          density="compact"
        />
      ) : (
        <div className={styles.share}>
          <section className={styles.shareSection} aria-label={t('sharing.currentHeading')}>
            <SectionLabel>{t('sharing.currentHeading')}</SectionLabel>
            {current.length === 0 ? (
              <p className={styles.empty}>{t('sharing.none')}</p>
            ) : (
              <ul className={styles.shareList}>
                {current.map((entry) => {
                  const name = names[entry.principalId] ?? entry.principalId
                  return (
                    <li key={entry.principalId} className={styles.shareRow}>
                      <span className={styles.shareName}>{name}</span>
                      {entry.role === 'custom' ? (
                        // Not a Select: there is no role to preselect, and offering one would invite
                        // overwriting a grant this client did not make and cannot describe.
                        <span className={styles.shareRole}>{roleLabel('custom')}</span>
                      ) : (
                        <Select
                          aria-label={t('sharing.roleFor', { name })}
                          value={entry.role}
                          disabled={busy}
                          onChange={(event) =>
                            void write(
                              roles.withGrant(
                                shareWith,
                                entry.principalId,
                                event.target.value as ShareRole,
                              ),
                            )
                          }
                        >
                          {offered.map((value) => (
                            <option key={value} value={value}>
                              {roleLabel(value)}
                            </option>
                          ))}
                        </Select>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={t('sharing.revokeFrom', { name })}
                        onClick={() => void write(roles.withoutGrant(shareWith, entry.principalId))}
                      >
                        <UserMinus aria-hidden="true" />
                        {t('sharing.revoke')}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className={styles.shareSection} aria-label={t('sharing.addHeading')}>
            <SectionLabel>{t('sharing.addHeading')}</SectionLabel>
            <div className={styles.shareControls}>
              <span className={styles.shareField}>
                <label className={styles.shareLabel} htmlFor={searchId}>
                  {t('sharing.search')}
                </label>
                <TextInput
                  id={searchId}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('sharing.searchPlaceholder')}
                />
              </span>
              <span className={styles.shareField}>
                <label className={styles.shareLabel} htmlFor={roleId}>
                  {t('sharing.roleLabel')}
                </label>
                {/* A native `Select`, on every viewport: on a phone this is the platform's own
                  picker wheel, which is a 44px target and a familiar gesture. A custom listbox
                  would have to reinvent both. */}
                <Select
                  id={roleId}
                  value={addRole}
                  onChange={(event) => setRole(event.target.value as ShareRole)}
                >
                  {offered.map((value) => (
                    <option key={value} value={value}>
                      {roleLabel(value)}
                    </option>
                  ))}
                </Select>
              </span>
            </div>
            {/* The role's meaning, spelled out, IN THE TERMS OF THIS OBJECT TYPE. "Manager" is a word;
              "can share this with other people" is what the user is actually agreeing to — and for a
              mail folder "View" has a consequence ("their unread counts will not move") that no
              generic wording could carry. */}
            <p className={styles.shareHint}>{t(`sharing.explain.${kind}.${addRole}`)}</p>

            {searchFailed ? (
              <EmptyState tone="error" title={t('sharing.searchFailed')} density="compact" />
            ) : found === null ? (
              <div className={styles.loading}>
                <Spinner label={t('ui.spinner.label')} />
              </div>
            ) : candidates.length === 0 ? (
              <EmptyState title={t('sharing.noMatches')} density="compact" />
            ) : (
              <ul className={styles.shareList}>
                {candidates.map((principal) => {
                  const name = principalLabel(principal)
                  return (
                    <li key={principal.id} className={styles.shareRow}>
                      <span className={styles.shareName}>{name}</span>
                      {principal.email !== null &&
                        principal.email !== undefined &&
                        principal.email !== name && (
                          <span className={styles.shareEmail}>{principal.email}</span>
                        )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={t('sharing.grantTo', { name })}
                        onClick={() =>
                          void write(roles.withGrant(shareWith, principal.id, addRole))
                        }
                      >
                        <UserPlus aria-hidden="true" />
                        {t('sharing.grant')}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* Assertive: a share that did not happen is not something to find out about later. */}
          <p aria-live="assertive" className={styles.shareStatus}>
            {failed ? t('sharing.failed') : ''}
          </p>
        </div>
      )}
    </Dialog>
  )
}

export default ShareDialog
