/**
 * Settings → Filters (M5.2, FR-SIEVE-01/02).
 *
 * The JMAP client is a fake. What is asserted is the promise the section makes about scripts it
 * did not write: a foreign script is displayed and left alone, and the moment the user does start
 * adding rules, every line of theirs is still in what gets saved.
 *
 * The rest — compiling rules to Sieve, reading them back, the protocol shape of a save — is pinned
 * in `script-io.test.ts` and `sieve-client.test.ts`.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SieveScript } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ReplicaDb, ReplicaProvider } from '../../sync'
import { freshDb } from '../../sync/test-utils'
import { expectNoA11yViolations } from '../../test/axe'
import { ToastProvider } from '../../ui'
import { FiltersSection } from './FiltersSection'
import type { SieveClient, SieveSnapshot } from './sieve-client'

const SCRIPT: SieveScript = { id: 's1', name: 'waxwing', blobId: 'b1', isActive: true }

/** A Roundcube-shaped script — the realistic thing to find in a mailbox that predates this app. */
const FOREIGN = `require ["fileinto"];
# rule:[Invoices]
if header :contains "from" "billing@acme.test"
{
\tfileinto "Invoices";
}
`

function fakeClient(source: string): { client: SieveClient; saved: string[] } {
  const saved: string[] = []
  let current = source
  const snapshot = (): SieveSnapshot => ({
    scripts: [SCRIPT],
    active: { script: SCRIPT, source: current },
    state: 'st-1',
  })
  const client: SieveClient = {
    load: async () => snapshot(),
    read: async () => current,
    save: async (next) => {
      saved.push(next)
      current = next
      return snapshot()
    },
    validate: async () => null,
    deactivate: async () => snapshot(),
    destroy: async () => snapshot(),
  }
  return { client, saved }
}

/**
 * The section reads mailboxes from the replica for its "move to folder" picker, and `SettingsPage`
 * only mounts it when there is one — so the test provides a real (empty) Dexie database rather
 * than faking the hook.
 */
let db: ReplicaDb

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

function renderSection(source: string) {
  const { client, saved } = fakeClient(source)
  const result = render(
    <ReplicaProvider accountId="a" db={db}>
      <ToastProvider>
        <FiltersSection client={client} />
      </ToastProvider>
    </ReplicaProvider>,
  )
  return { saved, container: result.container }
}

/** Walks the create-rule dialog: name it, target the subject, save. */
async function addRule(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: 'Add rule' }))
  await user.type(await screen.findByLabelText('Name'), name)
  await user.selectOptions(screen.getByLabelText('Part'), 'subject')
  await user.type(screen.getByLabelText('Value'), 'Newsletter')
  await user.click(screen.getByRole('button', { name: 'Save rule' }))
}

describe('<FiltersSection>', () => {
  it('lists the rules it wrote itself', async () => {
    const managed = `# @waxwing:rules:v1 {"version":1,"rules":[{"id":"r1","name":"Invoices","enabled":true,"match":"all","conditions":[],"actions":[{"kind":"discard"}],"stop":false}]}
# @waxwing:rules:end
`
    renderSection(managed)

    expect(await screen.findByText('Invoices')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeInTheDocument()
  })

  describe('a script this client did not write', () => {
    it('shows it as source and offers no rule editing at all', async () => {
      renderSection(FOREIGN)

      // Their script is on screen, verbatim…
      expect(await screen.findByText(/rule:\[Invoices\]/)).toBeInTheDocument()
      // …and nothing pretends to have understood it.
      expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
      expect(
        screen.getByText(/already has a filter script that was not written here/),
      ).toBeInTheDocument()
    })

    it('keeps every line of it when the user starts managing filters alongside', async () => {
      // The failure this guards against is the one that has bitten every client of this shape:
      // adopting the script silently drops the rules that were already filtering the user's mail.
      const user = userEvent.setup()
      const { saved } = renderSection(FOREIGN)

      await user.click(await screen.findByRole('button', { name: 'Manage filters alongside it' }))

      await waitFor(() => expect(saved).toHaveLength(1))
      const written = saved[0] ?? ''
      expect(written).toContain('# rule:[Invoices]')
      expect(written).toContain('fileinto "Invoices";')
      // Their `require` survived too — losing it makes the `fileinto` below fail to compile.
      expect(written).toMatch(/^require \[.*"fileinto".*\];/)
    })
  })

  it('saves a new rule into the managed region, leaving foreign source intact', async () => {
    const user = userEvent.setup()
    const { saved } = renderSection(FOREIGN)

    await user.click(await screen.findByRole('button', { name: 'Manage filters alongside it' }))
    await waitFor(() => expect(saved).toHaveLength(1))

    await addRule(user, 'Newsletters')

    await waitFor(() => expect(saved).toHaveLength(2))
    const written = saved[1] ?? ''
    expect(written).toContain('@waxwing:rules:v1')
    expect(written).toContain('"name":"Newsletters"')
    expect(written).toContain('header :contains "Subject" "Newsletter"')
    // Still theirs, still there.
    expect(written).toContain('fileinto "Invoices";')
  })

  it('has no accessibility violations', async () => {
    const { container } = renderSection(FOREIGN)
    await screen.findByRole('button', { name: 'Manage filters alongside it' })
    await expectNoA11yViolations(container)
  })
})
