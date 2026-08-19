import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import { getReadingPaneMode, setReadingPaneMode } from '../app/shell/layout'
import { getTheme, setTheme } from '../app/theme'
import { formatBytes } from '../i18n/formatters'
import {
  BODY_OVERHEAD_BYTES,
  ENVELOPE_BYTES_ESTIMATE,
  type EstimateFn,
  putEmails,
  type ReplicaDb,
  ReplicaProvider,
} from '../sync'
import { putEmailBody } from '../sync/repo'
import { email, freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import SettingsPage from './SettingsPage'
import { StorageSection, type StorageSectionProps } from './StorageSection'

const ACC = 'a'
let db: ReplicaDb

// SettingsPage renders BrandLinks, which reads the config context; provide it (DEFAULT_CONFIG
// has no branding links, so none render — the reading-pane/theme/axe assertions are unaffected).
//
// The RouterProvider is not decoration either: the page reads `route.rest` to resolve a
// `/settings/<section>` deep link, and it is a route screen — testing it outside a router would be
// testing a shape the app never renders.
function renderSettings() {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ToastProvider>
          <ReplicaProvider accountId={ACC} db={db}>
            <SettingsPage />
          </ReplicaProvider>
        </ToastProvider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

const estimate: EstimateFn = async () => ({ usage: 40 * 1024 * 1024, quota: 200 * 1024 * 1024 })

function renderStorage(props: StorageSectionProps = {}) {
  return render(
    <ConfigProvider config={DEFAULT_CONFIG}>
      <ToastProvider>
        <ReplicaProvider accountId={ACC} db={db}>
          <StorageSection
            estimate={estimate}
            persisted={async () => false}
            freeUpSpace={async () => 0}
            {...props}
          />
        </ReplicaProvider>
      </ToastProvider>
    </ConfigProvider>,
  )
}

beforeEach(async () => {
  // Both are module-level singletons; reset so tests don't leak into each other.
  setTheme('auto')
  setReadingPaneMode('right')
  db = freshDb()
  await putEmails(db, ACC, [email('e1'), email('e2')])
  await putEmailBody(db, {
    accountId: ACC,
    id: 'e1',
    bodyValues: { t: { value: 'x'.repeat(512), isEncodingProblem: false, isTruncated: false } },
    bodyStructure: {} as never,
    textBody: [],
    htmlBody: [],
    attachments: [],
    hasAttachment: false,
    authResults: [],
    fetchedAt: 1,
    lastAccessedAt: 1,
  })
  await db.blobsMeta.put({
    accountId: ACC,
    blobId: 'b1',
    type: 'image/png',
    size: 4096,
    name: null,
    data: new Uint8Array(4096).buffer,
    fetchedAt: 1,
    lastAccessedAt: 1,
    bytes: 4096,
  })
})

afterEach(async () => {
  await db.delete()
})

describe('the settings shell (M3.7)', () => {
  it('renders its sections in the order the plan lays out', async () => {
    // The shell is the one place the WHOLE screen is asserted; each section owns its own tests.
    // Without a session there is no Server section and no vacation responder, which is itself the
    // FR-SRV-02 promise: a capability we cannot verify is absent, never broken.
    renderSettings()
    const headings = (await screen.findAllByRole('heading', { level: 2 })).map(
      (heading) => heading.textContent,
    )
    expect(headings).toEqual([
      'General',
      'Appearance',
      'Reading',
      'Swipe actions',
      'Compose',
      // Next to Compose because that is what a template is for (M5.5, FR-CMP-12). Unlike the
      // sections below it needs only a replica, not a session — templates are stored locally.
      'Templates',
      'Notifications',
      'Offline & storage',
      'About',
    ])
  })

  it('hides the vacation responder, the identities and the server panel without a session', async () => {
    renderSettings()
    await screen.findByLabelText('Theme')
    expect(screen.queryByRole('heading', { name: 'Vacation responder' })).not.toBeInTheDocument()
    // Identities are session- AND capability-gated (they live under the submission capability):
    // without a session there is nothing to ask, so the section must not appear at all rather than
    // render an editor that would immediately fail to load (FR-SRV-02).
    expect(screen.queryByRole('heading', { name: 'Identities' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Server' })).not.toBeInTheDocument()
  })
})

describe('SettingsPage', () => {
  it('changes the reading-pane layout preference', async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.selectOptions(screen.getByLabelText('Reading pane'), 'off')

    expect(getReadingPaneMode()).toBe('off')
  })

  it('changes the theme preference', async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.selectOptions(screen.getByLabelText('Theme'), 'dark')

    expect(getTheme()).toBe('dark')
  })

  it('has no WCAG 2.x A/AA axe violations', async () => {
    const { container } = renderSettings()
    await screen.findByText('Storage used')
    await expectNoA11yViolations(container)
  })
})

describe('Settings — Offline & storage (M3.4)', () => {
  it('reports the real stored sizes, plus the browser total and the un-attributed remainder', async () => {
    renderStorage()

    // The meter is a real progressbar, named by its label and described by the summary line.
    const meter = await screen.findByRole('progressbar', { name: 'Storage used' })
    expect(meter).toHaveAttribute('max', String(200 * 1024 * 1024))
    expect(screen.getByText(/of .* used/)).toBeInTheDocument()

    const list = meter.closest('div')?.parentElement as HTMLElement
    expect(within(list).getByText('Message index (estimated)')).toBeInTheDocument()
    expect(within(list).getByText('Message bodies')).toBeInTheDocument()
    expect(within(list).getByText('Attachments')).toBeInTheDocument()
    expect(within(list).getByText('Other (app & offline shell)')).toBeInTheDocument()

    // The NUMBERS, not just the labels — "the usage UI matches reality" is the Done-when of this WP,
    // and a test that only counts <dd> elements passes just as happily when every category reads 0 B,
    // or when bodies and attachments are swapped. The seed is two envelopes, one 512-char body and one
    // 4 KB blob, so every figure below is derived, not copied from the implementation.
    const bodyBytes = 512 * 2 + BODY_OVERHEAD_BYTES
    const envelopeBytes = 2 * ENVELOPE_BYTES_ESTIMATE
    const accounted = envelopeBytes + bodyBytes + 4096
    const rows = screen.getAllByRole('definition')
    expect(rows.map((row) => row.textContent)).toEqual([
      formatBytes(envelopeBytes),
      formatBytes(bodyBytes),
      formatBytes(4096),
      formatBytes(40 * 1024 * 1024 - accounted), // the origin's usage minus everything we can attribute
    ])
  })

  it('hides "Other" entirely when the browser reports no quota (never a made-up number)', async () => {
    renderStorage({ estimate: async () => null })

    expect(
      await screen.findByText('Your browser does not report a storage quota.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Other (app & offline shell)')).not.toBeInTheDocument()
  })

  it('asks for persistence only on the user’s click, and reports a denial without retrying', async () => {
    const user = userEvent.setup()
    const requestPersist = vi.fn(async () => false)
    renderStorage({ requestPersist })

    const toggle = await screen.findByRole('switch', { name: 'Keep data on this device' })
    expect(requestPersist).not.toHaveBeenCalled() // never on first paint — it can PROMPT

    await user.click(toggle)

    expect(requestPersist).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByText(/Not granted — your browser may clear cached mail/),
    ).toBeInTheDocument()
    expect(requestPersist).toHaveBeenCalledTimes(1) // and it does NOT auto-retry
  })

  it('shows the switch as already granted (and disabled) when persistence is in place', async () => {
    renderStorage({ persisted: async () => true })
    const toggle = await screen.findByRole('switch', { name: 'Keep data on this device' })
    expect(toggle).toBeChecked()
    expect(toggle).toBeDisabled()
  })

  it('hides the switch entirely where the StorageManager is unsupported', async () => {
    renderStorage({ persisted: async () => null })
    await screen.findByText('Storage used')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('"Free up space" toasts the freed size', async () => {
    const user = userEvent.setup()
    renderStorage({ freeUpSpace: async () => 3 * 1024 * 1024 })

    await user.click(await screen.findByRole('button', { name: 'Free up space now' }))

    expect(await screen.findByText('Freed 3 MB')).toBeInTheDocument()
  })

  it('"Free up space" says so when there was nothing to free', async () => {
    const user = userEvent.setup()
    renderStorage({ freeUpSpace: async () => 0 })

    await user.click(await screen.findByRole('button', { name: 'Free up space now' }))

    expect(await screen.findByText('Nothing to free up')).toBeInTheDocument()
  })

  it('states the offline window and the pin count', async () => {
    await db.localPrefs.put({ accountId: ACC, key: 'offline.pinnedMailboxes', value: ['work'] })
    renderStorage()

    expect(
      await screen.findByText('Mail from the last 30 days is kept offline.'),
    ).toBeInTheDocument()
    expect(await screen.findByText('1 folder kept offline')).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = renderStorage()
    await screen.findByText('Storage used')
    await expectNoA11yViolations(container)
  })
})
