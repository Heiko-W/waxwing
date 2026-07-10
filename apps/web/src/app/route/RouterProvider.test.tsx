import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../../test/axe'
import { useNavigate, useRoute } from './hooks'
import { Link } from './Link'
import { RouterProvider } from './RouterProvider'

function Probe() {
  const match = useRoute()
  const navigate = useNavigate()
  return (
    <div>
      <span data-testid="id">{match.id}</span>
      <span data-testid="path">{match.path}</span>
      <span data-testid="mailbox">{match.params.mailboxId ?? ''}</span>
      <button type="button" onClick={() => navigate('/contacts')}>
        go-contacts
      </button>
      <Link to="/settings">go-settings</Link>
    </div>
  )
}

function renderRouter(baseUri: string) {
  return render(
    <RouterProvider baseUri={baseUri}>
      <Probe />
    </RouterProvider>,
  )
}

beforeEach(() => {
  window.history.pushState(null, '', '/')
})

describe('RouterProvider', () => {
  it('starts at the current location', () => {
    renderRouter('http://localhost/')
    expect(screen.getByTestId('id')).toHaveTextContent('mail')
  })

  it('navigate() pushes and updates the match', async () => {
    const user = userEvent.setup()
    renderRouter('http://localhost/')
    await user.click(screen.getByRole('button', { name: 'go-contacts' }))
    expect(screen.getByTestId('id')).toHaveTextContent('contacts')
    expect(window.location.pathname).toBe('/contacts')
  })

  it('Link renders a real href and navigates on an unmodified click', async () => {
    const user = userEvent.setup()
    renderRouter('http://localhost/')
    const link = screen.getByRole('link', { name: 'go-settings' })
    expect(link).toHaveAttribute('href', '/settings')
    await user.click(link)
    expect(screen.getByTestId('id')).toHaveTextContent('settings')
    expect(window.location.pathname).toBe('/settings')
  })

  it('does not intercept a modified (ctrl) click', () => {
    renderRouter('http://localhost/')
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const link = screen.getByRole('link', { name: 'go-settings' })
    fireEvent.click(link, { ctrlKey: true })
    expect(pushSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('id')).toHaveTextContent('mail')
    pushSpy.mockRestore()
  })

  it('recomputes the match on popstate (browser back/forward)', () => {
    renderRouter('http://localhost/')
    act(() => {
      window.history.pushState(null, '', '/mail/inbox')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.getByTestId('id')).toHaveTextContent('mail')
    expect(screen.getByTestId('mailbox')).toHaveTextContent('inbox')
  })

  it('resolves navigation under a mount prefix', async () => {
    const user = userEvent.setup()
    window.history.pushState(null, '', '/deploy/mail/')
    renderRouter('http://localhost/deploy/mail/')
    await user.click(screen.getByRole('button', { name: 'go-contacts' }))
    expect(window.location.pathname).toBe('/deploy/mail/contacts')
    expect(screen.getByTestId('id')).toHaveTextContent('contacts')
  })

  it('has no axe violations', async () => {
    const { container } = renderRouter('http://localhost/')
    await expectNoA11yViolations(container)
  })
})
