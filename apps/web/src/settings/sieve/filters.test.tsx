/**
 * Settings → Filters (M5.2, FR-SIEVE-01/02).
 *
 * The JMAP client is a fake. What is asserted is the promise the section makes about scripts it
 * did not write — a foreign script is displayed and left alone, and the moment the user does start
 * adding rules, every line of theirs is still in what gets saved — plus the three server calls
 * that were implemented and then never wired to anything: `validate` before a save, `deactivate`
 * behind the master switch, and `destroy` behind a confirmation.
 *
 * The rest — compiling rules to Sieve, reading them back, the protocol shape of a save — is pinned
 * in `script-io.test.ts` and `sieve-client.test.ts`.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SetError, SieveScript } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ReplicaDb, ReplicaProvider } from '../../sync'
import { INITIAL_ENGINE_STATUS } from '../../sync/engine'
import { setEngineStatus } from '../../sync/engine/status'
import { freshDb } from '../../sync/test-utils'
import { expectNoA11yViolations } from '../../test/axe'
import { ToastProvider } from '../../ui'
import { FiltersSection } from './FiltersSection'
import { type SieveClient, SieveSetError, type SieveSnapshot } from './sieve-client'

const SCRIPT: SieveScript = { id: 's1', name: 'waxwing', blobId: 'b1', isActive: true }

/** A Roundcube-shaped script — the realistic thing to find in a mailbox that predates this app. */
const FOREIGN = `require ["fileinto"];
# rule:[Invoices]
if header :contains "from" "billing@acme.test"
{
\tfileinto "Invoices";
}
`

interface Fake {
  readonly client: SieveClient
  /** Every script written, in order. */
  readonly saved: string[]
  /** Every source handed to `SieveScript/validate`, in order. */
  readonly validated: string[]
  readonly log: string[]
  /** Whether the script the section writes to is currently activated on save. */
  readonly activations: boolean[]
}

function fakeClient(source: string, options: { refuse?: SetError } = {}): Fake {
  const saved: string[] = []
  const validated: string[] = []
  const log: string[] = []
  const activations: boolean[] = []
  let current = source
  let script: SieveScript | null = { ...SCRIPT }

  const snapshot = (): SieveSnapshot => {
    const withSource = script === null ? null : { script, source: current }
    return {
      scripts: script === null ? [] : [script],
      active: script?.isActive === true ? withSource : null,
      managed: withSource,
      state: 'st-1',
    }
  }

  const client: SieveClient = {
    load: async () => snapshot(),
    read: async () => current,
    save: async (next, _existing, saveOptions) => {
      saved.push(next)
      activations.push(saveOptions?.activate ?? true)
      current = next
      if (script !== null && (saveOptions?.activate ?? true)) script = { ...script, isActive: true }
      return snapshot()
    },
    validate: async (next) => {
      validated.push(next)
      return options.refuse ?? null
    },
    activate: async () => {
      log.push('activate')
      if (script !== null) script = { ...script, isActive: true }
      return snapshot()
    },
    deactivate: async () => {
      log.push('deactivate')
      if (script !== null) script = { ...script, isActive: false }
      return snapshot()
    },
    destroy: async () => {
      log.push('destroy')
      script = null
      current = ''
      return snapshot()
    },
  }
  return { client, saved, validated, log, activations }
}

/**
 * The section reads mailboxes from the replica for its "move to folder" picker, and `SettingsPage`
 * only mounts it when there is one — so the test provides a real (empty) Dexie database rather
 * than faking the hook.
 */
let db: ReplicaDb

const managedScript = (...rules: { id: string; name: string }[]) =>
  `# @waxwing:rules:v2 ${JSON.stringify({
    version: 2,
    rules: rules.map(({ id, name }) => ({
      id,
      name,
      enabled: true,
      match: 'all',
      conditions: [],
      actions: [{ kind: 'discard' }],
      stop: false,
    })),
  })}\n# @waxwing:rules:end\n`

const MANAGED = managedScript({ id: 'r1', name: 'Invoices' })
const TWO_RULES = managedScript({ id: 'r1', name: 'Invoices' }, { id: 'r2', name: 'Newsletters' })

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  setEngineStatus(INITIAL_ENGINE_STATUS)
  await db.delete()
})

function renderSection(source: string, options: { refuse?: SetError } = {}) {
  const fake = fakeClient(source, options)
  const result = render(
    <ReplicaProvider accountId="a" db={db}>
      <ToastProvider>
        <FiltersSection client={fake.client} />
      </ToastProvider>
    </ReplicaProvider>,
  )
  return { ...fake, container: result.container }
}

/** Walks the create-rule dialog: name it, target the subject, save. */
async function addRule(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: 'Add rule' }))
  await user.type(await screen.findByLabelText('Name'), name)
  await user.selectOptions(screen.getByLabelText('Part'), 'subject')
  await user.type(screen.getByLabelText('Value'), 'Newsletter')
  await user.click(screen.getByRole('button', { name: 'Save rule' }))
}

/** The rule names in the order they are listed. */
const listedRules = () =>
  screen
    .getAllByRole('listitem')
    .map((row) => row.querySelector('[data-rule-position]') ?? row)
    .map((row) => row.textContent ?? '')

describe('<FiltersSection>', () => {
  it('lists the rules it wrote itself', async () => {
    renderSection(MANAGED)

    expect(await screen.findByText('Invoices')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeInTheDocument()
  })

  it('still reads a v1 script, so rules written by an earlier build stay editable', async () => {
    renderSection(
      '# @waxwing:rules:v1 {"version":1,"rules":[{"id":"r1","name":"Older","enabled":true,"match":"all","conditions":[],"actions":[{"kind":"discard"}],"stop":false}]}\n# @waxwing:rules:end\n',
    )

    expect(await screen.findByText('Older')).toBeInTheDocument()
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

    it('does not offer to delete a script it refuses to read', async () => {
      renderSection(FOREIGN)
      await screen.findByRole('button', { name: 'Manage filters alongside it' })

      // The one surface whose whole promise is "we left it alone" may not also be the one that
      // throws it away. Switching filtering off — reversible, destructive of nothing — is there.
      expect(screen.queryByRole('button', { name: 'Delete filter script' })).not.toBeInTheDocument()
      expect(screen.getByRole('switch', { name: 'Filtering is on' })).toBeInTheDocument()
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

  it('has no accessibility violations with a rule list', async () => {
    const { container } = renderSection(TWO_RULES)
    await screen.findByText('Newsletters')
    await expectNoA11yViolations(container)
  })
})

/**
 * B-3 — `SieveScript/validate` had no caller at all, while FR-SIEVE-01 claimed it ran before every
 * save. A rule set the server will not compile has to be refused HERE, not discovered when mail
 * stops arriving.
 */
describe('validation before a save (FR-SIEVE-01)', () => {
  it('compiles the script on the server before storing it', async () => {
    const user = userEvent.setup()
    const { saved, validated } = renderSection(MANAGED)
    await screen.findByText('Invoices')

    await addRule(user, 'Newsletters')

    await waitFor(() => expect(saved).toHaveLength(1))
    // The very bytes that were stored, not an approximation of them.
    expect(validated).toEqual([saved[0]])
  })

  it('does not store a script the server refuses to compile, and quotes the refusal', async () => {
    const user = userEvent.setup()
    const { saved } = renderSection(MANAGED, {
      refuse: { type: 'invalidScript', description: 'Expected token "command" at line 4' },
    })
    await screen.findByText('Invoices')

    await addRule(user, 'Newsletters')

    expect(
      await screen.findByText(/Expected token "command" at line 4/, { selector: '[role=alert]' }),
    ).toBeInTheDocument()
    expect(saved).toEqual([])
  })
})

/** B-3 — `deactivate` had no caller: filtering could be set up but never switched off. */
describe('the master switch', () => {
  it('switches filtering off without touching a single rule', async () => {
    const user = userEvent.setup()
    const { log, saved } = renderSection(MANAGED)
    await screen.findByText('Invoices')

    await user.click(screen.getByRole('switch', { name: 'Filtering is on' }))

    await waitFor(() => expect(log).toEqual(['deactivate']))
    expect(saved).toEqual([])
    // The rules are still listed — a section that empties itself looks like it deleted them.
    expect(screen.getByText('Invoices')).toBeInTheDocument()
    expect(
      screen.getByText(/Your rules are kept, but nothing is filtered until you turn this back on/),
    ).toBeInTheDocument()
  })

  it('switches it back on again', async () => {
    const user = userEvent.setup()
    const { log } = renderSection(MANAGED)
    await screen.findByText('Invoices')

    const master = () => screen.getByRole('switch', { name: 'Filtering is on' })
    await user.click(master())
    await waitFor(() => expect(master()).toHaveAttribute('aria-checked', 'false'))
    await user.click(master())

    await waitFor(() => expect(log).toEqual(['deactivate', 'activate']))
  })

  it('editing a rule while filtering is off does not switch it back on', async () => {
    // `SieveScript/set` activates only when asked to; a save that always asked would make the
    // switch a lie the moment anything else was touched.
    const user = userEvent.setup()
    const { activations, log } = renderSection(MANAGED)
    await screen.findByText('Invoices')

    await user.click(screen.getByRole('switch', { name: 'Filtering is on' }))
    await waitFor(() => expect(log).toEqual(['deactivate']))

    await addRule(user, 'Newsletters')

    await waitFor(() => expect(activations).toEqual([false]))
  })
})

/** B-3 — `destroy` had no caller either: a filter script could be created but never removed. */
describe('deleting the filter script', () => {
  it('asks first, then destroys it', async () => {
    const user = userEvent.setup()
    const { log } = renderSection(MANAGED)
    await screen.findByText('Invoices')

    await user.click(screen.getByRole('button', { name: 'Delete filter script' }))
    expect(await screen.findByText(/Every rule is removed from the server/)).toBeInTheDocument()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(log).toEqual(['destroy']))
    await waitFor(() => expect(screen.getByText('No filter rules yet.')).toBeInTheDocument())
  })

  it('says so when the script also carries rules written elsewhere', async () => {
    const user = userEvent.setup()
    renderSection(`${FOREIGN}\n${MANAGED}`)
    await screen.findByText('Invoices')

    await user.click(screen.getByRole('button', { name: 'Delete filter script' }))

    expect(
      await screen.findByText(/also holds rules that were not written here/),
    ).toBeInTheDocument()
  })

  it('deactivates and retries when the server says the script is still active', async () => {
    // RFC 9661 §2.4 refuses to destroy the active script. The client deactivates first when its
    // snapshot says so — this is the case where the snapshot was stale.
    const user = userEvent.setup()
    const fake = fakeClient(MANAGED)
    let refused = false
    const client: SieveClient = {
      ...fake.client,
      destroy: async (script) => {
        if (!refused) {
          refused = true
          throw new SieveSetError('sieveIsActive', 'still active')
        }
        return fake.client.destroy(script)
      },
    }
    render(
      <ReplicaProvider accountId="a" db={db}>
        <ToastProvider>
          <FiltersSection client={client} />
        </ToastProvider>
      </ReplicaProvider>,
    )
    await screen.findByText('Invoices')

    await user.click(screen.getByRole('button', { name: 'Delete filter script' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(fake.log).toEqual(['deactivate', 'destroy']))
  })
})

/**
 * B-4 — order IS the semantics in Sieve: a rule carrying `stop` ends processing and everything
 * below it never runs. Until this, the only way to correct an order was to delete rules and type
 * them in again.
 *
 * The keyboard path is asserted rather than the drag, and not for convenience: jsdom has no layout
 * engine, so every rectangle a pointer drag would measure is zero there. The drag is covered in
 * `e2e/tests/settings.spec.ts`, and the arithmetic under both is `moveItem`/`dropIndex`.
 */
describe('reordering rules', () => {
  it('moves a rule with the keyboard and saves the new order once, on drop', async () => {
    const user = userEvent.setup()
    const { saved } = renderSection(TWO_RULES)
    await screen.findByText('Newsletters')
    expect(
      listedRules().map((text) => text.replace(/Active|Edit|Delete|Reorder.*/g, '').trim()),
    ).toEqual(['Invoices', 'Newsletters'])

    screen.getByRole('button', { name: 'Reorder Invoices' }).focus()
    await user.keyboard('[Space]')
    await user.keyboard('[ArrowDown]')
    // Nothing is written until it is dropped: a drag across four rows is one save, not four.
    expect(saved).toEqual([])
    await user.keyboard('[Space]')

    await waitFor(() => expect(saved).toHaveLength(1))
    const written = saved[0] ?? ''
    expect(written.indexOf('"name":"Newsletters"')).toBeLessThan(
      written.indexOf('"name":"Invoices"'),
    )
  })

  it('puts the rule back on Escape and writes nothing', async () => {
    const user = userEvent.setup()
    const { saved } = renderSection(TWO_RULES)
    await screen.findByText('Newsletters')

    screen.getByRole('button', { name: 'Reorder Invoices' }).focus()
    await user.keyboard('[Space]')
    await user.keyboard('[ArrowDown]')
    await user.keyboard('[Escape]')

    expect(saved).toEqual([])
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Reorder Invoices' }).closest('li'),
      ).toHaveAttribute('data-rule-position', '1'),
    )
  })

  it('announces where the rule landed, because a drag handle announces nothing by itself', async () => {
    const user = userEvent.setup()
    renderSection(TWO_RULES)
    await screen.findByText('Newsletters')

    screen.getByRole('button', { name: 'Reorder Invoices' }).focus()
    await user.keyboard('[Space]')
    await user.keyboard('[ArrowDown]')

    expect(await screen.findByText('Invoices, rule 2 of 2')).toBeInTheDocument()
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
    expect(screen.getByRole('switch', { name: 'Filtering is on' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reorder Invoices' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete filter script' })).toBeDisabled()
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
