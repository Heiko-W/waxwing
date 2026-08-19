/**
 * The deployment config generator (M5.20).
 *
 * What is worth pinning is that the file is SHOWN before it can be saved, and that every finding
 * carries a word rather than only a colour. This file decides how every user of the deployment
 * reaches the server; an admin who downloads it unread has been failed by the screen, not by
 * themselves.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JmapSession } from '../app/session/types'
import { expectNoA11yViolations } from '../test/axe'
import { ConfigGeneratorPanel } from './ConfigGeneratorPanel'

const session = (apiUrl: string): JmapSession => ({ apiUrl }) as unknown as JmapSession

let saved: string[] = []

beforeEach(() => {
  saved = []
  URL.createObjectURL = vi.fn((blob: Blob) => {
    // Read synchronously enough for the assertions below: the text is captured at save time.
    void blob.text().then((text) => saved.push(text))
    return 'blob:test/1'
  })
  URL.revokeObjectURL = vi.fn()
})

function renderPanel(apiUrl: string, oauth: boolean | null, origin = 'https://mail.example.com') {
  return render(
    <ConfigGeneratorPanel
      session={session(apiUrl)}
      origin={origin}
      checkOAuth={async () => oauth}
    />,
  )
}

describe('before it is asked', () => {
  it('shows nothing but the button', () => {
    renderPanel('https://mail.example.com/jmap', true)
    expect(screen.getByRole('button', { name: /Generate config/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save config/i })).not.toBeInTheDocument()
  })
})

describe('what it reports', () => {
  it('shows the file BEFORE offering to save it', async () => {
    renderPanel('https://mail.example.com/jmap', true)
    await userEvent.click(screen.getByRole('button', { name: /Generate config/i }))

    // The preview and the save button appear together — the admin can read what they are shipping.
    const preview = await screen.findByText(/"sessionUrl": null/)
    expect(preview).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save config/i })).toBeInTheDocument()
  })

  it('names the cross-origin server in the warning AND pins it in the file', async () => {
    renderPanel('https://jmap.example.net/jmap', true)
    await userEvent.click(screen.getByRole('button', { name: /Generate config/i }))

    // Both places, deliberately: the warning explains the dependency, the file encodes it.
    const findings = await screen.findByRole('list')
    expect(findings).toHaveTextContent('https://jmap.example.net')
    expect(screen.getByText(/"sessionUrl": "https:\/\/jmap\.example\.net"/)).toBeInTheDocument()
  })

  it('labels a warning with a WORD, not only a colour', async () => {
    // WCAG 1.4.1 — the same rule the capabilities list above it already follows.
    renderPanel('https://jmap.example.net/jmap', true)
    await userEvent.click(screen.getByRole('button', { name: /Generate config/i }))
    expect(await screen.findByText(/Check this:/)).toBeInTheDocument()
  })

  it('distinguishes "no OAuth" from "could not check"', async () => {
    const { unmount } = renderPanel('https://mail.example.com/jmap', false)
    await userEvent.click(screen.getByRole('button', { name: /Generate config/i }))
    expect(await screen.findByText(/OAuth discovery did not answer/i)).toBeInTheDocument()
    unmount()

    renderPanel('https://mail.example.com/jmap', null)
    await userEvent.click(screen.getByRole('button', { name: /Generate config/i }))
    expect(await screen.findByText(/could not be checked/i)).toBeInTheDocument()
  })

  it('says branding was not discovered rather than leaving it unexplained', async () => {
    renderPanel('https://mail.example.com/jmap', true)
    await userEvent.click(screen.getByRole('button', { name: /Generate config/i }))
    expect(await screen.findByText(/carried over unchanged/i)).toBeInTheDocument()
  })
})

describe('saving', () => {
  it('writes valid JSON', async () => {
    renderPanel('https://mail.example.com/jmap', true)
    await userEvent.click(screen.getByRole('button', { name: /Generate config/i }))
    await userEvent.click(await screen.findByRole('button', { name: /Save config/i }))

    await waitFor(() => expect(saved).toHaveLength(1))
    const parsed = JSON.parse(saved[0] as string)
    expect(parsed.server.sessionUrl).toBeNull()
    expect(parsed.server.auth).toEqual(['oauth', 'basic'])
  })
})

describe('accessibility', () => {
  it('has no violations with a generated config on screen', async () => {
    const { container } = renderPanel('https://jmap.example.net/jmap', false)
    await userEvent.click(screen.getByRole('button', { name: /Generate config/i }))
    await screen.findByRole('button', { name: /Save config/i })
    await expectNoA11yViolations(container)
  })
})
