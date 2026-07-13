/**
 * Settings → Reading and Compose (M3.7).
 *
 * Every control here writes a `localPrefs` key that some OTHER module reads, so the assertions go
 * through `getPref` rather than through the rendered control: what matters is that the reader will
 * see it, not that the switch looked flipped.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { COMPOSE_PREF_KEYS } from '../compose'
import { READING_PREF_KEYS } from '../mail/reading-prefs'
import { getPref, type ReplicaDb, ReplicaProvider, setPref } from '../sync'
import { freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { ComposeSection } from './ComposeSection'
import { ReadingSection } from './ReadingSection'

const ACC = 'a'
let db: ReplicaDb

function renderSection(node: React.ReactNode) {
  return render(
    <ConfigProvider config={DEFAULT_CONFIG}>
      <ToastProvider>
        <ReplicaProvider accountId={ACC} db={db}>
          {node}
        </ReplicaProvider>
      </ToastProvider>
    </ConfigProvider>,
  )
}

beforeEach(async () => {
  db = await freshDb()
})

describe('<ReadingSection>', () => {
  it('defaults the remote-image switch from the deployment config', async () => {
    renderSection(<ReadingSection />)
    // DEFAULT_CONFIG blocks remote content — the privacy-safe side.
    expect(await screen.findByLabelText(/Load remote images/i)).not.toBeChecked()
  })

  it('writes the user override, which the reader honours over the config', async () => {
    const user = userEvent.setup()
    renderSection(<ReadingSection />)

    await user.click(await screen.findByLabelText(/Load remote images/i))
    await waitFor(async () =>
      expect(await getPref(db, ACC, READING_PREF_KEYS.remoteContent)).toBe('allow'),
    )
  })

  it('turns auto-mark-read off — a preference that has existed since M1.8 with no way to set it', async () => {
    const user = userEvent.setup()
    renderSection(<ReadingSection />)

    await user.click(await screen.findByLabelText(/Mark messages as read/i))
    await waitFor(async () =>
      expect(await getPref(db, ACC, READING_PREF_KEYS.autoMarkRead)).toBe(false),
    )
  })

  it('shows the sender allow-list only when it has entries, and can empty it', async () => {
    const user = userEvent.setup()
    const { unmount } = renderSection(<ReadingSection />)
    await screen.findByLabelText(/Load remote images/i)
    expect(screen.queryByRole('button', { name: /Clear the list/i })).not.toBeInTheDocument()
    unmount()

    await setPref(db, ACC, READING_PREF_KEYS.remoteAllow, ['a@example.com', 'b@example.com'])
    renderSection(<ReadingSection />)

    expect(await screen.findByText(/2 senders always load remote content/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Clear the list/i }))
    await waitFor(async () =>
      expect(await getPref(db, ACC, READING_PREF_KEYS.remoteAllow)).toEqual([]),
    )
  })

  it('has no a11y violations', async () => {
    const { container } = renderSection(<ReadingSection />)
    await screen.findByLabelText(/Load remote images/i)
    await expectNoA11yViolations(container)
  })
})

describe('<ComposeSection>', () => {
  it('shows the deployment default until the user picks something else', async () => {
    renderSection(<ComposeSection />)
    expect(await screen.findByLabelText('Undo send')).toHaveValue('15')
  })

  it('writes the undo-send grace, including "off"', async () => {
    const user = userEvent.setup()
    renderSection(<ComposeSection />)

    await user.selectOptions(await screen.findByLabelText('Undo send'), '30')
    await waitFor(async () =>
      expect(await getPref(db, ACC, COMPOSE_PREF_KEYS.undoSendSeconds)).toBe(30),
    )

    await user.selectOptions(screen.getByLabelText('Undo send'), '0')
    await waitFor(async () =>
      expect(await getPref(db, ACC, COMPOSE_PREF_KEYS.undoSendSeconds)).toBe(0),
    )
  })

  it('writes the signature placement (FR-CMP-02)', async () => {
    const user = userEvent.setup()
    renderSection(<ComposeSection />)

    await user.selectOptions(await screen.findByLabelText('Signature placement'), 'belowQuote')
    await waitFor(async () =>
      expect(await getPref(db, ACC, COMPOSE_PREF_KEYS.signaturePlacement)).toBe('belowQuote'),
    )
  })

  it('has no a11y violations', async () => {
    const { container } = renderSection(<ComposeSection />)
    await screen.findByLabelText('Undo send')
    await expectNoA11yViolations(container)
  })
})
