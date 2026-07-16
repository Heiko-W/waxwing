import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { JmapHttpError } from '@waxwing/jmap'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SessionContext } from '../app/session/context'
import type { SessionContextValue } from '../app/session/types'
import { type EmailRow, toEmailRow } from '../sync'
import { email } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import MessageSourceDialog from './MessageSourceDialog'

const RAW = 'From: alice@x.test\r\nSubject: Hi\r\n\r\nHello there.\r\n'

const ROW: EmailRow = toEmailRow('a', email('e1', { subject: 'Hi', blobId: 'blob-1' }))

type Download = (
  accountId: string,
  blobId: string,
  type: string,
  name: string,
) => Promise<Uint8Array>

function renderDialog(
  download: Download | null,
  props: { autoSave?: boolean; onClose?: () => void } = {},
): ReactNode {
  const session = {
    getClient: () => (download === null ? null : { download }),
  } as unknown as SessionContextValue
  return render(
    <SessionContext.Provider value={session}>
      <MessageSourceDialog
        open
        accountId="a"
        email={ROW}
        onClose={props.onClose ?? (() => {})}
        {...(props.autoSave === undefined ? {} : { autoSave: props.autoSave })}
      />
    </SessionContext.Provider>,
  ) as unknown as ReactNode
}

const ok: Download = async () => new TextEncoder().encode(RAW)

describe('MessageSourceDialog', () => {
  it('renders the raw source in a <pre> once it loads', async () => {
    renderDialog(ok)
    const pre = await waitFor(() => {
      const node = document.querySelector('pre')
      expect(node).not.toBeNull()
      return node as HTMLPreElement
    })
    expect(pre.textContent).toBe(RAW)
  })

  it('renders the source as TEXT — a script tag in the message is never live markup', async () => {
    // The one view that shows an attacker's bytes verbatim. If this ever regresses to
    // dangerouslySetInnerHTML, every phishing message gets a free script tag.
    const hostile = 'Subject: <script>window.pwned = 1</script>\r\n\r\n<img src=x onerror=alert(1)>'
    renderDialog(async () => new TextEncoder().encode(hostile))
    const pre = await waitFor(() => {
      const node = document.querySelector('pre')
      expect(node).not.toBeNull()
      return node as HTMLPreElement
    })
    expect(pre.textContent).toBe(hostile)
    expect(pre.querySelector('script')).toBeNull()
    expect(pre.querySelector('img')).toBeNull()
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined()
  })

  it('shows a spinner while loading', () => {
    renderDialog(() => new Promise<Uint8Array>(() => {}))
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('reports offline when there is no client', async () => {
    renderDialog(null)
    expect(
      await screen.findByText('The message source could not be loaded because you are offline.'),
    ).toBeInTheDocument()
  })

  it('reports a message that is gone from the server', async () => {
    renderDialog(async () => {
      throw new JmapHttpError(404, '')
    })
    expect(await screen.findByText('This message is no longer on the server.')).toBeInTheDocument()
  })

  it('reports any other failure', async () => {
    renderDialog(async () => {
      throw new JmapHttpError(500, '')
    })
    expect(await screen.findByText('The message source could not be loaded.')).toBeInTheDocument()
  })

  it('notes when only the head of a large message is shown', async () => {
    renderDialog(async () => new Uint8Array(1_200_000).fill(0x61))
    expect(
      await screen.findByText(/Showing the beginning of this message only/),
    ).toBeInTheDocument()
  })

  it('copies the source to the clipboard', async () => {
    // `userEvent.setup()` installs its own navigator.clipboard stub, so spy AFTER it, not before.
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    try {
      renderDialog(ok)
      const copy = await screen.findByRole('button', { name: 'Copy' })
      await waitFor(() => expect(copy).toBeEnabled())
      await user.click(copy)
      expect(writeText).toHaveBeenCalledWith(RAW)
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    } finally {
      writeText.mockRestore()
    }
  })

  it('saves the .eml from the footer button', async () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:fake', revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const user = userEvent.setup()
      renderDialog(ok)
      const save = await screen.findByRole('button', { name: 'Save as .eml' })
      await waitFor(() => expect(save).toBeEnabled())
      await user.click(save)
      expect(click).toHaveBeenCalledOnce()
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake')
    } finally {
      click.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('autoSave downloads once and closes, without a second click', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:fake', revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const onClose = vi.fn()
    try {
      renderDialog(ok, { autoSave: true, onClose })
      await waitFor(() => expect(click).toHaveBeenCalledOnce())
      expect(onClose).toHaveBeenCalled()
    } finally {
      click.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('has no a11y violations', async () => {
    renderDialog(ok)
    await waitFor(() => expect(document.querySelector('pre')).not.toBeNull())
    // The Dialog renders through a portal, so scan document.body, not the RTL container.
    await expectNoA11yViolations()
  })
})
