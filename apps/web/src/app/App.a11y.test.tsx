import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { App } from './App'
import { DEFAULT_CONFIG } from './config'
import { fakeAuthSession, makeFakeServices } from './session/test-fakes'

afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  window.history.pushState(null, '', '/')
})

describe('App accessibility', () => {
  it('has no axe violations on the connect step', async () => {
    const fake = makeFakeServices({ probePresent: false })
    const { container } = render(<App config={DEFAULT_CONFIG} services={fake.services} />)
    await screen.findByText(/Welcome to/i)
    await expectNoA11yViolations(container)
  })

  it('has no axe violations on the sign-in step', async () => {
    const fake = makeFakeServices({ probePresent: true, oauthAvailable: true })
    const { container } = render(<App config={DEFAULT_CONFIG} services={fake.services} />)
    await screen.findByRole('button', { name: /^sign in$/i })
    await expectNoA11yViolations(container)
  })

  it('has no axe violations on the connected shell', async () => {
    const fake = makeFakeServices({ restore: fakeAuthSession('basic') })
    const { container } = render(<App config={DEFAULT_CONFIG} services={fake.services} />)
    await screen.findByText(DEFAULT_CONFIG.branding.productName)
    await expectNoA11yViolations(container)
  })

  it('has no axe violations on the re-auth dialog', async () => {
    const fake = makeFakeServices({ restore: fakeAuthSession('basic') })
    render(<App config={DEFAULT_CONFIG} services={fake.services} />)
    await screen.findByText(DEFAULT_CONFIG.branding.productName)
    fake.expire()
    await act(async () => {
      try {
        await fake.capturedProvider()?.authorization()
      } catch {
        // Provider rethrows after firing the re-auth funnel.
      }
    })
    await screen.findByRole('dialog', { name: 'Session expired' })
    // The dialog portals into document.body — scan the whole document.
    await expectNoA11yViolations()
  })
})
