import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { getReadingPaneMode, setReadingPaneMode } from '../app/shell/layout'
import { getTheme, setTheme } from '../app/theme'
import { expectNoA11yViolations } from '../test/axe'
import SettingsPage from './SettingsPage'

// SettingsPage renders BrandLinks, which reads the config context; provide it (DEFAULT_CONFIG
// has no branding links, so none render — the reading-pane/theme/axe assertions are unaffected).
function renderSettings() {
  return render(
    <ConfigProvider config={DEFAULT_CONFIG}>
      <SettingsPage />
    </ConfigProvider>,
  )
}

describe('SettingsPage', () => {
  beforeEach(() => {
    // Both are module-level singletons; reset so tests don't leak into each other.
    setTheme('auto')
    setReadingPaneMode('right')
  })

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
    await expectNoA11yViolations(container)
  })
})
