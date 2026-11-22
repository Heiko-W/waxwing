import type { MailAccount } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from '../sync'
import { putMailboxes } from '../sync/repo'
import { freshDb, mailbox } from '../sync/test-utils'
import { sentTargetFor } from './sent-target'

let db: ReplicaDb

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

const own: MailAccount = { id: 'me', name: 'alice@x.test', isPersonal: true, isReadOnly: false }
const team: MailAccount = { id: 'grp', name: 'team@x.test', isPersonal: false, isReadOnly: false }
const accounts = [own, team]

async function seedTeamSent(mayAddItems = true): Promise<void> {
  const sent = mailbox('grp-sent', { role: 'sent' })
  await putMailboxes(db, 'grp', [{ ...sent, myRights: { ...sent.myRights, mayAddItems } }])
}

describe('sentTargetFor (issue #101)', () => {
  it('names the Sent folder of the group account whose address the message is sent from', async () => {
    await seedTeamSent()
    expect(await sentTargetFor(db, accounts, 'me', 'team@x.test')).toEqual({
      accountId: 'grp',
      mailboxId: 'grp-sent',
    })
  })

  it('matches the address case-insensitively', async () => {
    await seedTeamSent()
    expect(await sentTargetFor(db, accounts, 'me', ' Team@X.test ')).not.toBeNull()
  })

  it('keeps a personal identity in the own Sent', async () => {
    await seedTeamSent()
    expect(await sentTargetFor(db, accounts, 'me', 'alice@x.test')).toBeNull()
  })

  it('keeps an address no account carries (an alias of the group) in the own Sent', async () => {
    await seedTeamSent()
    expect(await sentTargetFor(db, accounts, 'me', 'postmaster@x.test')).toBeNull()
  })

  it('falls back when the group Sent has not synced yet', async () => {
    expect(await sentTargetFor(db, accounts, 'me', 'team@x.test')).toBeNull()
  })

  it('falls back when the user may not add to the group Sent', async () => {
    await seedTeamSent(false)
    expect(await sentTargetFor(db, accounts, 'me', 'team@x.test')).toBeNull()
  })

  it('falls back for a read-only account', async () => {
    await seedTeamSent()
    const readOnly = { ...team, isReadOnly: true }
    expect(await sentTargetFor(db, [own, readOnly], 'me', 'team@x.test')).toBeNull()
  })
})
