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
import { INITIAL_ENGINE_STATUS } from '../../sync/engine'
import { setEngineStatus } from '../../sync/engine/status'
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

const MANAGED = `# @waxwing:rules:v1 {"version":1,"rules":[{"id":"r1","name":"Invoices","enabled":true,"match":"all","conditions":[],"actions":[{"kind":"discard"}],"stop":false}]}
# @waxwing:rules:end
`

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  setEngineStatus(INITIAL_ENGINE_STATUS)
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
    renderSection(MANAGED)

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
    expect(written).toContain('@waxwing:rules:v2')
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

/**
 * Offline, filters answer the way identities have answered since M5.1.
 *
 * Saving a Sieve script is online-only — the outbox cannot replay a settings document with
 * last-write-wins semantics — but nothing said so until the save failed. A reader could open the
 * rule form offline, name a rule, pick a field, a comparison, a value and an action, press Save and
 * only THEN be told it was never possible. Identities disable their "Add identity" and print one
 * sentence; this section left every control live. Two sections of one screen, two answers to the
 * same question.
 *
 * "Show script" is the deliberate exception: it discloses what is already on screen and writes
 * nothing, so there is nothing for being offline to prevent.
 */
describe('offline (G11)', () => {
  it('refuses the writes up front and says why, instead of failing after the form is filled in', async () => {
    renderSection(MANAGED)
    await screen.findByText('Invoices')

    setEngineStatus({ ...INITIAL_ENGINE_STATUS, online: false })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add rule' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Active' })).toBeDisabled()
    expect(
      screen.getByText('You are offline. Filters can only be changed while connected.'),
    ).toBeInTheDocument()

    // …and the one control that only READS stays available.
    expect(screen.getByRole('button', { name: 'Show script' })).toBeEnabled()
  })

  it('leaves everything usable while connected', async () => {
    renderSection(MANAGED)
    await screen.findByText('Invoices')

    expect(screen.getByRole('button', { name: 'Add rule' })).toBeEnabled()
    expect(
      screen.queryByText('You are offline. Filters can only be changed while connected.'),
    ).not.toBeInTheDocument()
  })
})
