import { render, screen, waitFor, within } from '@testing-library/react'
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
import styles from './settings.module.css'

const ACC = 'a'
let db: ReplicaDb

const originalMatchMedia = window.matchMedia

/** Force the phone tier — no `matchMedia` match makes `useLayoutTier()` return 'phone'. */
function forcePhone(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false
      },
    }),
  })
}

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

/**
 * Open a section from the rail — the panel-per-section layout means a test has to say WHICH panel it
 * is about, which is also the honest shape: the reader has to choose one too.
 */
async function openSection(user: ReturnType<typeof userEvent.setup>, name: string) {
  const rail = await screen.findByRole('navigation', { name: 'Settings' })
  await user.click(within(rail).getByRole('link', { name }))
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
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
  window.history.pushState(null, '', '/settings')
  await db.delete()
})

describe('the settings shell (M3.7)', () => {
  it('groups its sections in the rail, in the order the plan lays out', async () => {
    // The shell is the one place the WHOLE screen is asserted; each section owns its own tests.
    // Without a session there is no Server section and no vacation responder, which is itself the
    // FR-SRV-02 promise: a capability we cannot verify is absent, never broken.
    renderSettings()

    // The GROUPS, in order — the information architecture, which is what this screen is now. They
    // are list labels rather than headings, so a reader navigating by heading meets the page title
    // and the open section, not nine rail captions in between.
    const rail = await screen.findByRole('navigation', { name: 'Settings' })
    const groupNames = within(rail)
      .getAllByRole('list')
      .map(
        (list) => document.getElementById(list.getAttribute('aria-labelledby') ?? '')?.textContent,
      )
    // FOUR, not five: every section of "Accounts & rules" needs a session, so without one the group
    // is not empty-but-present, it is absent. A heading over nothing is worse than no heading.
    expect(groupNames).toEqual(['General', 'Appearance', 'Mail', 'System'])

    // …and every section reachable from it. One rail link per section, in group order.
    const links = within(rail)
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(links).toEqual([
      'General',
      'Notifications',
      'Appearance',
      'Swipe actions',
      'Reading',
      'Compose',
      // Next to Compose because that is what a template is for (M5.5, FR-CMP-12). Unlike the
      // capability-gated ones it needs only a replica — templates are stored locally.
      'Templates',
      'Offline & storage',
      'About',
    ])
  })

  it('opens the first section on a wide screen, and the one the URL names', async () => {
    // Landing on `/settings` with room for both columns shows a section rather than an empty panel:
    // the reader asked for settings, not for a menu.
    renderSettings()
    expect(await screen.findByRole('heading', { level: 2, name: 'General' })).toBeInTheDocument()
    // The deep link `/settings/<slug>` has been buildable since M1.4 and did nothing until now.
    window.history.pushState(null, '', '/settings/compose')
    renderSettings()
    expect(await screen.findByRole('heading', { level: 2, name: 'Compose' })).toBeInTheDocument()
  })

  it('hides the vacation responder, the identities and the server panel without a session', async () => {
    renderSettings()
    // Absent from the RAIL is the stronger claim now: unreachable, not merely unrendered.
    const rail = await screen.findByRole('navigation', { name: 'Settings' })
    expect(within(rail).queryByRole('link', { name: 'Vacation responder' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Vacation responder' })).not.toBeInTheDocument()
    // Identities are session- AND capability-gated (they live under the submission capability):
    // without a session there is nothing to ask, so the section must not appear at all rather than
    // render an editor that would immediately fail to load (FR-SRV-02).
    expect(within(rail).queryByRole('link', { name: 'Identities' })).not.toBeInTheDocument()
    expect(within(rail).queryByRole('link', { name: 'Server' })).not.toBeInTheDocument()
  })
})

/**
 * ONE card per section — the invariant the whole card/row split exists to hold.
 *
 * `.controls` was `display: flex` and a gap when eleven section components adopted it as their own
 * root; the day it became a bordered card, every one of them drew a second card inside the one
 * `Section` already renders. Ten of fourteen sections showed two concentric borders offset by a
 * pixel, Notifications managed three, and nothing anywhere could see it: it is a class name used in
 * two places that mean different things.
 *
 * The count is the check, and it is deliberately taken for EVERY section reachable in this fixture
 * rather than for a chosen one — the defect arrived section by section, and so would the next.
 */
describe('the section card (G2)', () => {
  it('draws exactly one card in every section, never a card inside a card', async () => {
    const user = userEvent.setup()
    const { container } = renderSettings()
    const rail = await screen.findByRole('navigation', { name: 'Settings' })
    const names = within(rail)
      .getAllByRole('link')
      .map((link) => link.textContent ?? '')
    expect(names.length).toBeGreaterThan(5) // a loop over nothing passes just as happily

    for (const name of names) {
      await openSection(user, name)
      const cards = container.querySelectorAll(`.${styles.controls}`)
      expect(cards, `${name} should be one card`).toHaveLength(1)
    }
  })
})

/**
 * The heading a screen opens with (G6).
 *
 * On a phone the rail is REPLACED by the section, and the page's only `<h1>` — "Settings", in the
 * rail — goes with it. All fourteen sections therefore began at level 2 with no level 1 anywhere,
 * in every viewport that matters most for heading navigation. And in every viewport, the `<h1>` sat
 * inside `<nav aria-label="Settings">`: a landmark named after a heading it contains says the same
 * word twice and distinguishes nothing.
 */
describe('heading structure (G6)', () => {
  it('gives the phone’s detail screen its own h1 — the section’s name', async () => {
    forcePhone()
    const user = userEvent.setup()
    renderSettings()
    await openSection(user, 'Compose')

    const levelOnes = screen.getAllByRole('heading', { level: 1 })
    expect(levelOnes.map((heading) => heading.textContent)).toEqual(['Compose'])
    // …and the rail's title is gone with the rail, so there is exactly one.
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
  })

  it('keeps page title over section title where both are on screen', async () => {
    const user = userEvent.setup()
    renderSettings()
    await openSection(user, 'Compose')

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Settings')
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Compose')
  })

  it('never puts the page heading inside the navigation named after it', async () => {
    renderSettings()
    const rail = await screen.findByRole('navigation', { name: 'Settings' })
    expect(within(rail).queryByRole('heading')).not.toBeInTheDocument()
  })
})

/**
 * Focus follows the navigation, in both directions (G5).
 *
 * The `tabIndex={-1}` on the section has been there since M1.4 for exactly this and nothing ever
 * called `focus()`. On a phone that is not a nicety: opening a section removes the rail from the
 * DOM together with the focused `<a>`, so the reader is dropped at the top of the document and has
 * to walk through the header and the main navigation again — after every section they open.
 */
describe('focus on navigation (G5)', () => {
  it('moves focus into the section that was opened, and back to the row that was left', async () => {
    forcePhone()
    const user = userEvent.setup()
    renderSettings()

    const rail = await screen.findByRole('navigation', { name: 'Settings' })
    const row = within(rail).getByRole('link', { name: 'Compose' })
    await user.click(row)

    const section = await screen.findByRole('region', { name: 'Compose' })
    await waitFor(() => expect(document.activeElement).toBe(section))

    await user.click(screen.getByRole('link', { name: 'Settings' }))

    await waitFor(() => {
      const back = screen.getByRole('navigation', { name: 'Settings' })
      expect(document.activeElement).toBe(within(back).getByRole('link', { name: 'Compose' }))
    })
  })

  it('does not seize focus on first paint', async () => {
    // Landing on `/settings` shows a section because there is room for one, which is not the
    // reader asking to be put inside it.
    renderSettings()
    await screen.findByRole('heading', { level: 2, name: 'General' })
    expect(document.activeElement).toBe(document.body)
  })
})

/**
 * A slug that names no section rewrites the address (G14).
 *
 * `/settings/gibtsnicht` rendered the first section and marked it `aria-current="page"` while the
 * address bar kept a section name that does not exist — the URL and the only thing on screen saying
 * different things, and a bookmark of it silently wrong.
 */
describe('an unknown section slug (G14)', () => {
  it('replaces the address rather than disagreeing with what is on screen', async () => {
    window.history.pushState(null, '', '/settings/gibtsnicht')
    renderSettings()

    await waitFor(() => expect(window.location.pathname).toBe('/settings'))
    expect(await screen.findByRole('heading', { level: 2, name: 'General' })).toBeInTheDocument()
  })

  it('leaves a slug that DOES name a section alone', async () => {
    window.history.pushState(null, '', '/settings/compose')
    renderSettings()

    await screen.findByRole('heading', { level: 2, name: 'Compose' })
    expect(window.location.pathname).toBe('/settings/compose')
  })

  it('leaves a section that this server merely cannot offer alone', async () => {
    // "Server" is a real section, gated on having a session — and this fixture has none. Rewriting
    // it would mean racing the session and the replica: a deep link would be thrown away in
    // whatever frames pass before they arrive. A capability we do not have is not a typo.
    window.history.pushState(null, '', '/settings/server')
    renderSettings()

    await screen.findByRole('heading', { level: 2, name: 'General' })
    expect(window.location.pathname).toBe('/settings/server')
  })
})

describe('SettingsPage', () => {
  it('changes the reading-pane layout preference', async () => {
    const user = userEvent.setup()
    renderSettings()
    await openSection(user, 'Appearance')

    await user.selectOptions(screen.getByLabelText('Reading pane'), 'off')

    expect(getReadingPaneMode()).toBe('off')
  })

  it('changes the theme preference', async () => {
    const user = userEvent.setup()
    renderSettings()
    await openSection(user, 'Appearance')

    await user.selectOptions(screen.getByLabelText('Theme'), 'dark')

    expect(getTheme()).toBe('dark')
  })

  it('has no WCAG 2.x A/AA axe violations', async () => {
    const user = userEvent.setup()
    const { container } = renderSettings()
    // With a panel per section the sweep has to name one; Offline & storage is the richest of them
    // (a meter, a breakdown, a switch and a destructive button) and the one this test always used.
    await openSection(user, 'Offline & storage')
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
