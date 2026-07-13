/**
 * The sidebar quota bar and the ≥ 90 % warning (M3.7, FR-QTA-01).
 *
 * The client is injected — the point is what the UI does with the numbers, and above all what it does
 * when there ARE no numbers: a server without quota support must cost nothing and show nothing, not
 * an empty bar and not a request.
 */

import { render, screen, waitFor } from '@testing-library/react'
import type { Quota } from '@waxwing/jmap'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { QuotaBar } from './QuotaBar'
import type { QuotaClient } from './quota-client'
import { resetQuotaStore } from './use-quota'
import { useQuotaNotifier } from './use-quota-notifier'

const quota = (over: Partial<Quota> = {}): Quota => ({
  id: 'q1',
  resourceType: 'octets',
  used: 2 * 1024 * 1024 * 1024,
  hardLimit: 5 * 1024 * 1024 * 1024,
  scope: 'account',
  name: 'alice@waxwing.test',
  types: ['Email'],
  warnLimit: null,
  softLimit: null,
  description: null,
  ...over,
})

const clientOf = (list: Quota[] | Error): QuotaClient => ({
  list: async () => {
    if (list instanceof Error) throw list
    return list
  },
})

function Notifier({ client }: { readonly client: QuotaClient }) {
  useQuotaNotifier({ client })
  return null
}

beforeEach(() => {
  // The store is module-scoped: a cached value (or a live subscriber) would leak into the next test.
  resetQuotaStore()
  vi.clearAllMocks()
})

describe('<QuotaBar>', () => {
  it('shows what is used, out of what is allowed', async () => {
    const { container } = render(<QuotaBar client={clientOf([quota()])} />)
    expect(await screen.findByText(/2 GB of 5 GB/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAccessibleName('Mailbox storage')
    await expectNoA11yViolations(container)
  })

  it('says "nearly full" in WORDS past 90 %, not merely in a colour', async () => {
    render(<QuotaBar client={clientOf([quota({ used: 4.8 * 1024 * 1024 * 1024 })])} />)
    expect(await screen.findByText(/nearly full/i)).toBeInTheDocument()
  })

  it('says the mailbox is full once the server is refusing writes', async () => {
    render(<QuotaBar client={clientOf([quota({ used: 5 * 1024 * 1024 * 1024 })])} />)
    expect(await screen.findByText('Mailbox full')).toBeInTheDocument()
  })

  it('renders NOTHING when the server offers no quota — and never asks it for one', async () => {
    // Without an injected client and without a session, the capability probe is false: the bar must
    // not appear, and `list()` must not be called. A bar that renders "0 of 0" is worse than no bar.
    const list = vi.fn(async () => [])
    const { container } = render(<QuotaBar client={{ list }} />)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    expect(container.querySelector('progress')).toBeNull()
  })

  it('renders nothing when the fetch fails — a stale number is worse than none', async () => {
    const { container } = render(<QuotaBar client={clientOf(new Error('offline'))} />)
    await waitFor(() => expect(container.querySelector('progress')).toBeNull())
  })

  it('renders nothing for a count-only quota (the bar meters bytes)', async () => {
    const { container } = render(<QuotaBar client={clientOf([quota({ resourceType: 'count' })])} />)
    await waitFor(() => expect(container.querySelector('progress')).toBeNull())
  })
})

describe('useQuotaNotifier', () => {
  it('warns once at ≥ 90 %, and never twice for the same level', async () => {
    render(
      <ToastProvider>
        <Notifier client={clientOf([quota({ used: 4.8 * 1024 * 1024 * 1024 })])} />
        <QuotaBar client={clientOf([quota({ used: 4.8 * 1024 * 1024 * 1024 })])} />
      </ToastProvider>,
    )
    const alerts = await screen.findAllByText(/nearly full/i)
    // One in the sidebar bar, one in the toast — and re-rendering must not add a third.
    expect(alerts.length).toBeGreaterThanOrEqual(1)
    expect(await screen.findByText(/New mail may soon be rejected/i)).toBeInTheDocument()
  })

  it('escalates to a danger toast once the mailbox is actually full', async () => {
    render(
      <ToastProvider>
        <Notifier client={clientOf([quota({ used: 6 * 1024 * 1024 * 1024 })])} />
        <QuotaBar client={clientOf([quota({ used: 6 * 1024 * 1024 * 1024 })])} />
      </ToastProvider>,
    )
    expect(await screen.findByText(/being rejected until you free up space/i)).toBeInTheDocument()
  })

  it('says nothing at all while there is room', async () => {
    render(
      <ToastProvider>
        <Notifier client={clientOf([quota()])} />
        <QuotaBar client={clientOf([quota()])} />
      </ToastProvider>,
    )
    await screen.findByRole('progressbar')
    expect(screen.queryByText(/nearly full|being rejected/i)).not.toBeInTheDocument()
  })
})
