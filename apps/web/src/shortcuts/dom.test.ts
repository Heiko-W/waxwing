/**
 * The two guards the dispatcher runs before it ever looks at the registry (M3.8). They decide whether
 * a single-letter chord fires at all, so their edges are the work package: an `<input type=checkbox>`
 * is NOT text entry (every message row has one), and a portalled overlay swallows everything.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { isInOverlay, isTextEntryTarget } from './dom'

function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
  return host
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isTextEntryTarget', () => {
  it('is true for a text field, a textarea and a select', () => {
    const host = mount(
      '<input id="a"><input id="b" type="email"><textarea id="c"></textarea><select id="d"></select>',
    )
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(isTextEntryTarget(host.querySelector(`#${id}`)), id).toBe(true)
    }
  })

  // THE regression: the row select box and the bulk bar's select-all are `<input type="checkbox">`.
  // Ticking rows with the mouse leaves focus on the last checkbox — `e` must still archive.
  it('is FALSE for the non-text input types (checkbox, radio, button, range, …)', () => {
    const types = [
      'checkbox',
      'radio',
      'button',
      'submit',
      'reset',
      'range',
      'color',
      'file',
      'image',
    ]
    const host = mount(types.map((type) => `<input id="t-${type}" type="${type}">`).join(''))
    for (const type of types) {
      expect(isTextEntryTarget(host.querySelector(`#t-${type}`)), type).toBe(false)
    }
  })

  it('is true for a contenteditable and for anything inside a textbox/combobox/searchbox role', () => {
    const host = mount(
      '<div id="ce" contenteditable="true"></div><div role="combobox"><span id="in"></span></div>',
    )
    const editable = host.querySelector('#ce') as HTMLElement
    // jsdom does not implement `isContentEditable` off the attribute — define it the way a browser does.
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isTextEntryTarget(editable)).toBe(true)
    expect(isTextEntryTarget(host.querySelector('#in'))).toBe(true)
  })

  it('is false for a plain element and for a non-element target', () => {
    const host = mount('<div id="p"></div>')
    expect(isTextEntryTarget(host.querySelector('#p'))).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
  })
})

describe('isInOverlay', () => {
  it('is true anywhere under a [data-waxwing-portal] host (Dialog, Menu, Toast, the composer)', () => {
    const host = mount('<div data-waxwing-portal><button id="in">x</button></div><b id="out"></b>')
    expect(isInOverlay(host.querySelector('#in'))).toBe(true)
    expect(isInOverlay(host.querySelector('#out'))).toBe(false)
  })
})
