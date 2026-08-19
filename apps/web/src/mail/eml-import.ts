/**
 * Importing `.eml` files into a mailbox (M5.3, FR-MBX-06).
 *
 * `Email/import` rather than `Email/set create`: an import keeps the original bytes, so headers,
 * signatures and MIME structure survive exactly. Rebuilding a message from parsed parts loses
 * whatever the client could not model — and for the two things people actually import, an archive
 * restore and a message someone mailed them as an attachment, that loss is the whole point of the
 * exercise.
 *
 * Online-only and direct, like the other settings-shaped writes: an import is a deliberate one-off
 * with no optimistic local state worth rolling back, and queueing it offline would put a message in
 * the replica that the server has never seen.
 */

import type { Id, JmapClient, SetError } from '@waxwing/jmap'
import { Methods } from '@waxwing/jmap'

/** The largest file this will attempt, independent of what the server allows. */
export const MAX_EML_BYTES = 50 * 1024 * 1024

/** Why one file could not be imported. */
export type ImportFailure =
  | 'tooLarge'
  | 'alreadyExists'
  | 'invalidEmail'
  | 'overQuota'
  | 'notFound'
  | 'uploadFailed'
  | 'rejected'

export interface ImportOutcome {
  readonly filename: string
  /** The new message's id, or `null` when it failed. */
  readonly emailId: Id | null
  readonly failure: ImportFailure | null
}

/** Maps a server `SetError` to the reasons the UI can say something useful about. */
export function classifyImportError(error: Pick<SetError, 'type'>): ImportFailure {
  switch (error.type) {
    case 'alreadyExists':
      return 'alreadyExists'
    case 'invalidEmail':
      return 'invalidEmail'
    case 'tooLarge':
      return 'tooLarge'
    case 'overQuota':
      return 'overQuota'
    case 'notFound':
      return 'notFound'
    default:
      return 'rejected'
  }
}

export interface EmlImporter {
  /** Uploads and files one file; never throws. */
  importOne(file: File, mailboxId: Id, signal?: AbortSignal): Promise<ImportOutcome>
}

export function makeEmlImporter(client: JmapClient, accountId: Id): EmlImporter {
  return {
    async importOne(file, mailboxId, signal) {
      if (file.size > MAX_EML_BYTES) {
        return { filename: file.name, emailId: null, failure: 'tooLarge' }
      }

      let blobId: Id
      try {
        const uploaded = await client.upload(accountId, file, {
          type: 'message/rfc822',
          ...(signal ? { signal } : {}),
        })
        blobId = uploaded.blobId
      } catch {
        return { filename: file.name, emailId: null, failure: 'uploadFailed' }
      }

      try {
        const responses = await client.call(
          [
            [
              Methods.emailImport.name,
              {
                accountId,
                emails: {
                  // `$seen` is deliberately NOT set: an imported message is new to this mailbox,
                  // and marking it read on the reader's behalf hides it in the very folder they
                  // just put it in. `receivedAt` is left to the server, which uses the import time
                  // — the original Date header lives on inside the preserved bytes either way.
                  one: { blobId, mailboxIds: { [mailboxId]: true } },
                },
              },
              'i0',
            ],
          ],
          signal ? { signal } : {},
        )
        const response = responses.get<{
          created: Record<string, { id: Id }> | null
          notCreated: Record<string, SetError> | null
        }>('i0')

        const refusal = response.notCreated?.one
        if (refusal !== undefined) {
          return { filename: file.name, emailId: null, failure: classifyImportError(refusal) }
        }
        const created = response.created?.one
        return created === undefined
          ? { filename: file.name, emailId: null, failure: 'rejected' }
          : { filename: file.name, emailId: created.id, failure: null }
      } catch {
        return { filename: file.name, emailId: null, failure: 'rejected' }
      }
    },
  }
}

/** Whether a picked file looks like a message at all — a cheap guard before uploading megabytes. */
export function looksLikeEml(file: File): boolean {
  if (file.type === 'message/rfc822') return true
  return /\.eml$/i.test(file.name)
}
