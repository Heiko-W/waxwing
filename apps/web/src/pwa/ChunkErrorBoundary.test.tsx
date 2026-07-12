import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChunkErrorBoundary, isChunkLoadError } from './ChunkErrorBoundary'

const reload = vi.fn()

/** What a lazy route chunk throws once a deploy has removed it from the server. */
function chunkLoadError(): Error {
  return new TypeError('Failed to fetch dynamically imported module: /assets/SettingsPage-a1b2.js')
}

function Boom({ error }: { error: Error }): never {
  throw error
}

let now = 1_000_000

function renderBoundary(error: Error) {
  return render(
    <ChunkErrorBoundary reload={reload} now={() => now}>
      <Boom error={error} />
    </ChunkErrorBoundary>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  now = 1_000_000
  sessionStorage.clear() // the reload guard lives here
  // React logs every caught error; the boundary IS the handling, so keep the output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('ChunkErrorBoundary', () => {
  it('renders its children when nothing is wrong', () => {
    render(
      <ChunkErrorBoundary reload={reload}>
        <p>Inbox</p>
      </ChunkErrorBoundary>,
    )
    expect(screen.getByText('Inbox')).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })

  it('self-heals a missing chunk with exactly ONE reload', () => {
    renderBoundary(chunkLoadError())
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('never loops: a second failure in the same tab shows the panel instead of reloading again', () => {
    const first = renderBoundary(chunkLoadError())
    expect(reload).toHaveBeenCalledTimes(1)
    first.unmount() // stand in for the reload the injected fake did not actually perform

    // The reload did not fix it (a broken deploy, an offline precache miss) — the guard holds.
    renderBoundary(chunkLoadError())
    expect(reload).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  })

  it('heals a LATER deploy in the same long-lived tab, once the loop window has passed', () => {
    // A mail tab lives for days and can see several deploys. A plain one-shot flag would self-heal
    // the first and then show an error panel to a user who did nothing wrong.
    const first = renderBoundary(chunkLoadError())
    expect(reload).toHaveBeenCalledTimes(1)
    first.unmount()

    now += 61_000 // hours later, in real life
    renderBoundary(chunkLoadError())
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('does not reload on an error it does not understand — it shows the panel', async () => {
    const user = userEvent.setup()
    renderBoundary(new Error('Cannot read properties of undefined'))

    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')

    // …but the user can still ask for one.
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('clears the panel when the resetKey changes — otherwise navigation looks dead', () => {
    // The route-level boundary is keyed on the route. Without the reset, one broken screen would
    // leave the panel up forever: the user clicks "Mail" in the nav, the route changes underneath,
    // and the panel just sits there.
    function Screen({ broken }: { broken: boolean }) {
      if (broken) throw new Error('render bug in SettingsPage')
      return <p>Inbox</p>
    }
    const view = render(
      <ChunkErrorBoundary reload={reload} now={() => now} resetKey="settings">
        <Screen broken />
      </ChunkErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    view.rerender(
      <ChunkErrorBoundary reload={reload} now={() => now} resetKey="mail">
        <Screen broken={false} />
      </ChunkErrorBoundary>,
    )
    expect(screen.getByText('Inbox')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('isChunkLoadError', () => {
  it('recognises every engine, and nothing else', () => {
    expect(isChunkLoadError(chunkLoadError())).toBe(true)
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true)
    const named = new Error('boom')
    named.name = 'ChunkLoadError'
    expect(isChunkLoadError(named)).toBe(true)

    expect(isChunkLoadError(new Error('undefined is not a function'))).toBe(false)
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false)
  })
})
