/**
 * The From-identity selector (M2.5, FR-CMP-06). Lists the account's send identities and, on first
 * load, seeds the default identity's signature above the quote; changing the selection swaps the
 * signature in place (without clobbering the user's text). Rendered only when there is more than one
 * identity — a single identity still gets its signature seeded, just without a visible control.
 *
 * The outer component's ONLY hook is `useReplicaOptional` (so the rule-of-hooks holds across the
 * early return); all real hooks live in the inner component, which never mounts without a replica.
 */

import { useEffect, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { type IdentityRow, useIdentities, useReplicaOptional } from '../sync'
import { Select } from '../ui'
import styles from './composer.module.css'
import { type DraftWindow, useComposerStore } from './composer-store'
import {
  applySignature,
  pickDefaultIdentity,
  replaceSignature,
  signatureHtmlForIdentity,
} from './signature'

export function FromField({ draft }: { readonly draft: DraftWindow }) {
  // Without a replica (isolated composer tests) there are no identities to choose or seed.
  if (useReplicaOptional() === null) return null
  return <FromFieldInner draft={draft} />
}

function formatIdentityOption(identity: IdentityRow): string {
  return identity.name.trim() !== '' ? `${identity.name} <${identity.email}>` : identity.email
}

function FromFieldInner({ draft }: { readonly draft: DraftWindow }) {
  const { t } = useTranslation()
  const identities = useIdentities()
  const setFromIdentity = useComposerStore((state) => state.setFromIdentity)
  const selectId = useId()

  // Seed the default identity + its signature above the quote once, when identities first load.
  useEffect(() => {
    if (identities === undefined || identities.length === 0) return
    if (draft.fromIdentityId !== undefined) return
    const chosen = pickDefaultIdentity(identities, draft.fromIdentityHint)
    if (chosen === undefined) return
    const body = applySignature(draft.body, signatureHtmlForIdentity(chosen))
    setFromIdentity(draft.id, chosen.id, body, { markDirty: false })
  }, [
    identities,
    draft.id,
    draft.fromIdentityId,
    draft.fromIdentityHint,
    draft.body,
    setFromIdentity,
  ])

  if (identities === undefined || identities.length <= 1) return null // seed-only for one identity

  return (
    <div className={styles.field}>
      <label className={styles.fromLabel} htmlFor={selectId}>
        {t('compose.fromLabel')}
      </label>
      <Select
        id={selectId}
        value={draft.fromIdentityId ?? ''}
        onChange={(event) => {
          const chosen = identities.find((identity) => identity.id === event.target.value)
          if (chosen === undefined) return
          const body = replaceSignature(draft.body, signatureHtmlForIdentity(chosen))
          setFromIdentity(draft.id, chosen.id, body, { markDirty: true })
        }}
      >
        {identities.map((identity) => (
          <option key={identity.id} value={identity.id}>
            {formatIdentityOption(identity)}
          </option>
        ))}
      </Select>
    </div>
  )
}
