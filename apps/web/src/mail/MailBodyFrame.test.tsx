/**
 * The message body frame's focus indicator (B6, WCAG 2.4.7).
 *
 * The frame is a TAB STOP, and across the iframe boundary there is nothing to hang a CSS rule on.
 * Measured in Chromium against the live fixture, with focus on the frame: the `<iframe>` matches
 * neither `:focus`, `:focus-visible` nor `:focus-within` and fires no focus event, while
 * `document.activeElement` IS the iframe and the framed document reports `hasFocus()`. A rule inside
 * the frame does not help either — its `activeElement` is the default `<body>`, which is not a
 * focused element.
 *
 * What is left is the window-blur signal, and this file pins it: the E2E sweep proves the ring is
 * painted, and these prove the STATE MACHINE that drives it, including the half a browser test
 * cannot easily reach — that a blur caused by anything other than the frame leaves it alone.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MailBodyFrame } from './MailBodyFrame'

function renderFrame() {
  render(
    <MailBodyFrame
      bodyHtml="<p>body</p>"
      allowRemote={false}
      title="Message: Lunch"
      onOpenLink={() => {}}
    />,
  )
  return screen.getByTitle('Message: Lunch')
}

describe('MailBodyFrame focus indicator', () => {
  it('marks itself focused when the window loses focus TO it', () => {
    const frame = renderFrame()
    frame.focus()
    fireEvent.blur(window)
    expect(frame).toHaveAttribute('data-focused')
  })

  it('stays unmarked when the window loses focus to something else', () => {
    // The other half, and the one a browser test would struggle to stage: switching to another
    // application blurs the window too. Marking the frame focused there would leave a ring on a
    // frame nobody is on.
    const frame = renderFrame()
    document.body.focus()
    fireEvent.blur(window)
    expect(frame).not.toHaveAttribute('data-focused')
  })

  it('clears the mark as soon as focus lands back in this document', () => {
    const frame = renderFrame()
    frame.focus()
    fireEvent.blur(window)
    expect(frame).toHaveAttribute('data-focused')

    // A Tab out of the frame focuses the next control here, which fires `focusin`.
    fireEvent.focusIn(document.body)
    expect(frame).not.toHaveAttribute('data-focused')
  })
})
