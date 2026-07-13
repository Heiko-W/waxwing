/**
 * Settings → Vacation responder (M3.7, FR-VAC-01).
 *
 * The JMAP client is a fake, and so is the editor (the real one lazy-loads Squire, which jsdom cannot
 * run). What is asserted is the contract with the server: the singleton `update`, the `ifInState` that
 * came from the `/get`, both body alternatives — and the three ways a save can fail.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PatchObject, VacationResponse } from '@waxwing/jmap'
import { JmapMethodError } from '@waxwing/jmap'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionContext } from '../app/session/context'
import type { ConnectedSession, SessionContextValue } from '../app/session/types'
import { createFakeEngine, fakeEditorFactory } from '../compose/test-editor'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { VacationSection } from './VacationSection'
import { type VacationClient, VacationSetError, type VacationSnapshot } from './vacation-client'

const SINGLETON: VacationResponse = {
  id: 'singleton',
  isEnabled: false,
  fromDate: null,
  toDate: null,
  subject: null,
  textBody: null,
  htmlBody: null,
}

interface Recorded {
  readonly patch: PatchObject
  readonly ifInState: string
}

function fakeClient(options: {
  vacation?: VacationResponse
  onSave?: (patch: PatchObject, ifInState: string) => Promise<VacationSnapshot>
}): { client: VacationClient; saves: Recorded[] } {
  const saves: Recorded[] = []
  let current = options.vacation ?? SINGLETON
  const client: VacationClient = {
    get: async () => ({ vacation: current, state: 'st-1' }),
    save: async (patch, ifInState) => {
      saves.push({ patch, ifInState })
      if (options.onSave) return await options.onSave(patch, ifInState)
      current = { ...current, ...(patch as Partial<VacationResponse>) }
      return { vacation: current, state: 'st-2' }
    },
  }
  return { client, saves }
}

function renderSection(client: VacationClient) {
  return render(
    <ToastProvider>
      <VacationSection client={client} editorFactory={fakeEditorFactory()} />
    </ToastProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('<VacationSection>', () => {
  it('loads the singleton and saves an update keyed by it, with the ifInState from the get', async () => {
    const user = userEvent.setup()
    const { client, saves } = fakeClient({})
    renderSection(client)

    await screen.findByLabelText('Send automatic replies')
    await user.click(screen.getByLabelText('Send automatic replies'))
    await user.type(screen.getByLabelText('Subject'), 'Away')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.ifInState).toBe('st-1')
    expect(saves[0]?.patch).toMatchObject({ isEnabled: true, subject: 'Away' })
  })

  it('turning it OFF does not wipe the subject or the body', async () => {
    // A "back on Monday" message is worth keeping between holidays; switching off means "stop
    // replying", not "forget what I wrote".
    const user = userEvent.setup()
    const { client, saves } = fakeClient({
      vacation: { ...SINGLETON, isEnabled: true, subject: 'Away', htmlBody: '<p>Back soon</p>' },
    })
    renderSection(client)

    await waitFor(() => expect(screen.getByLabelText('Send automatic replies')).toBeChecked())
    await user.click(screen.getByLabelText('Send automatic replies'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.patch).toMatchObject({ isEnabled: false, subject: 'Away' })
    expect(saves[0]?.patch.htmlBody).toContain('Back soon')
  })

  it('blocks Save when the end is before the start, and names the problem', async () => {
    const user = userEvent.setup()
    const { client, saves } = fakeClient({})
    renderSection(client)

    await screen.findByLabelText('Start')
    await user.type(screen.getByLabelText('Start'), '2026-07-20T09:00')
    await user.type(screen.getByLabelText('End'), '2026-07-13T09:00')

    expect(await screen.findByRole('alert')).toHaveTextContent(/end must be after the start/i)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(saves).toHaveLength(0)
  })

  it('a stale ifInState repaints from the server rather than overwriting someone else', async () => {
    const user = userEvent.setup()
    const server: VacationResponse = { ...SINGLETON, isEnabled: true, subject: 'Set elsewhere' }
    const client: VacationClient = {
      get: async () => ({ vacation: server, state: 'st-9' }),
      save: async () => {
        throw new JmapMethodError({ type: 'stateMismatch' }, 'v0', 'VacationResponse/set')
      },
    }
    renderSection(client)

    await screen.findByLabelText('Subject')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/changed elsewhere/i)
    // …and the form now shows the SERVER's version, not the one we tried to write.
    await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveValue('Set elsewhere'))
  })

  it('surfaces a per-object rejection inline', async () => {
    const user = userEvent.setup()
    const { client } = fakeClient({
      onSave: async () => {
        throw new VacationSetError('invalidProperties', 'Subject too long')
      },
    })
    renderSection(client)

    await screen.findByLabelText('Subject')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected/i)
  })

  it('previews the message inside the reader’s own sandboxed frame', async () => {
    const user = userEvent.setup()
    const { client } = fakeClient({ vacation: { ...SINGLETON, htmlBody: '<p>Back Monday</p>' } })
    renderSection(client)

    await screen.findByLabelText('Subject')
    const toggle = screen.getByRole('button', { name: 'Show preview' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggle)
    expect(await screen.findByTitle('Vacation reply preview')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide preview' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('has no a11y violations', async () => {
    // Scanned with the preview CLOSED, deliberately. The preview is a sandboxed `srcdoc` iframe and
    // axe cannot traverse one under jsdom ("Respondable target must be a frame in the current
    // window") — a limitation of the test environment, not of the component. The frame's own
    // accessible name is asserted above; its CONTENTS are the recipient's mail, sanitized by the same
    // code path the reading pane uses and covered by that pane's tests.
    const { client } = fakeClient({})
    const { container } = renderSection(client)
    await screen.findByLabelText('Subject')
    await expectNoA11yViolations(container)
  })
})

/**
 * The regression guard for the defect the unit tests structurally could not see.
 *
 * Every test above INJECTS a `VacationClient`, and an injected client is a stable object — so the
 * load effect's dependency never changes and nothing loops. The shipped component takes the other
 * branch: it builds its client from the session with `makeVacationClient()`, which returns a FRESH
 * object on every render. That made the effect re-run on every render, so each `setDraft` from a
 * load scheduled the next load: an unbounded `VacationResponse/get` storm for as long as the screen
 * was open (Stalwart 429s within seconds), and the user's toggle was overwritten by the server's
 * copy before it could ever be saved — the switch could not be turned on at all.
 *
 * So this test must go through the SESSION, not the prop. It is the only shape that can fail.
 */
describe('the load effect (via the real session path, not an injected client)', () => {
  it('fetches the vacation responder ONCE, not once per render', async () => {
    const call = vi.fn(async () => ({
      get: () => ({ state: 'st-1', list: [SINGLETON] }),
    }))
    const session = {
      connected: {
        client: { call } as unknown as ConnectedSession['client'],
        accountId: 'acc-1',
      },
    } as unknown as SessionContextValue

    render(
      <SessionContext.Provider value={session}>
        <ToastProvider>
          <VacationSection editorFactory={fakeEditorFactory()} />
        </ToastProvider>
      </SessionContext.Provider>,
    )

    await screen.findByLabelText('Send automatic replies')
    // Give any runaway effect several render cycles to prove itself.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('lets the user turn the switch ON — a reload must not overwrite the edit', async () => {
    const user = userEvent.setup()
    const call = vi.fn(async () => ({
      get: () => ({ state: 'st-1', list: [SINGLETON] }),
    }))
    const session = {
      connected: {
        client: { call } as unknown as ConnectedSession['client'],
        accountId: 'acc-1',
      },
    } as unknown as SessionContextValue

    render(
      <SessionContext.Provider value={session}>
        <ToastProvider>
          <VacationSection editorFactory={fakeEditorFactory()} />
        </ToastProvider>
      </SessionContext.Provider>,
    )

    const enable = await screen.findByLabelText('Send automatic replies')
    await user.click(enable)
    await waitFor(() => expect(enable).toHaveAttribute('aria-checked', 'true'))
  })
})

/**
 * The regression guard for the SECOND defect the E2E exposed: the away message was silently dropped.
 *
 * `RichTextEditor` debounces `onChange` by 200 ms to keep typing off the parent's render path. The
 * vacation form built its patch straight from React state, so a user who typed their message and
 * reached for Save inside that window saved an EMPTY body — subject and the on-switch arrived at the
 * server, the message did not. This is precisely the data loss `RichTextEditorHandle.flush()` was
 * added for in M2.8, when the composer hit it on send; the vacation form simply did not use it.
 *
 * The test writes into the engine and saves WITHOUT letting the debounce elapse — the one shape that
 * can fail.
 */
describe('the away message survives an immediate Save (the editor debounce)', () => {
  it('flushes the editor before building the patch', async () => {
    const user = userEvent.setup()
    const engine = createFakeEngine()
    const { client, saves } = fakeClient({})

    render(
      <ToastProvider>
        <VacationSection client={client} editorFactory={fakeEditorFactory(engine)} />
      </ToastProvider>,
    )

    await screen.findByLabelText('Send automatic replies')
    await user.click(screen.getByLabelText('Send automatic replies'))

    // The user types — the engine holds the text, but the debounced onChange has NOT fired yet.
    engine.html = '<p>Back on Monday.</p>'
    engine.emit('input')

    // …and reaches straight for Save, inside the 200 ms window.
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saves).toHaveLength(1))
    const patch = saves[0]?.patch as PatchObject & {
      htmlBody: string | null
      textBody: string | null
    }
    expect(patch.htmlBody).toContain('Back on Monday')
    expect(patch.textBody).toContain('Back on Monday')
  })
})
