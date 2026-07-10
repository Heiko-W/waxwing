import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from './db'
import { ReplicaProvider, useLocalPref, useMailboxes, useReplica } from './react'
import { putMailboxes, setPref } from './repo'
import { freshDb, mailbox } from './test-utils'

let db: ReplicaDb
const ACC = 'acc'

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

function wrap(node: React.ReactNode) {
  return render(
    <ReplicaProvider db={db} accountId={ACC}>
      {node}
    </ReplicaProvider>,
  )
}

function MailboxNames() {
  const mailboxes = useMailboxes()
  return (
    <ul aria-label="mailboxes">
      {mailboxes?.map((row) => (
        <li key={row.id}>{row.name}</li>
      ))}
    </ul>
  )
}

describe('ReplicaProvider + hooks', () => {
  it('re-renders live when the replica changes', async () => {
    wrap(<MailboxNames />)
    await putMailboxes(db, ACC, [mailbox('inbox', { name: 'Inbox', role: 'inbox' })])
    expect(await screen.findByText('Inbox')).toBeDefined()
  })

  it('exposes a typed local preference that updates live', async () => {
    function Density() {
      const density = useLocalPref<string>('list.density')
      return <span>{density ?? 'default'}</span>
    }
    wrap(<Density />)
    expect(await screen.findByText('default')).toBeDefined()
    await setPref(db, ACC, 'list.density', 'compact')
    expect(await screen.findByText('compact')).toBeDefined()
  })

  it('throws when used outside a provider', () => {
    function Bad() {
      useReplica()
      return null
    }
    expect(() => render(<Bad />)).toThrow(/ReplicaProvider/)
  })
})
