import { describe, expect, it } from 'vitest'
import { collectSources } from '../ui/css-sources'
import { KEY_CAP_KEYS, LIST_KEYS } from './list-keys'

/**
 * The cheat sheet's grid-key table against the switch statement it documents (B21).
 *
 * `LIST_KEYS` is a duplicate of `MessageList`'s `onKeyDown`, and a duplicate with no check between
 * the halves is a documentation bug waiting for its next editor. There is no type that can say
 * "these two agree": one is a `switch` over `event.key`, the other a display table. So this reads
 * the source and compares the SETS.
 *
 * It is deliberately a source scan rather than a behavioural test. A rendering test would prove
 * that the keys in the table work; it could not notice a NEW case added to the switch that nobody
 * documented, which is exactly the direction this defect came from — the grid grew its keys and the
 * sheet, generated from the registry alone, never mentioned any of them.
 */

const source = collectSources('src/mail', ['.tsx']).find(
  (file) => file.path === 'src/mail/MessageList.tsx',
)

/** The `case '…':` labels inside `onKeyDown`, which is the only switch over `event.key` there. */
function handledKeys(text: string): string[] {
  const start = text.indexOf('function onKeyDown(')
  if (start === -1) return []
  const switchStart = text.indexOf('switch (event.key)', start)
  if (switchStart === -1) return []
  // The switch's own body: from its opening brace to the matching close.
  let depth = 0
  let end = switchStart
  for (let i = text.indexOf('{', switchStart); i < text.length; i++) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  return [...text.slice(switchStart, end).matchAll(/case '([^']*)':/g)].map((m) => m[1] as string)
}

/** What a `LIST_KEYS` chord matches on: `Mod+a` → `a`, `Shift+↓` → `↓`. */
function baseKey(chord: string): string {
  return chord.replace(/^Mod\+/, '').replace(/^Shift\+/, '')
}

/** The arrow glyphs the table shows for the two arrow cases the handler names in full. */
const GLYPH_FOR_KEY: Readonly<Record<string, string>> = { ArrowDown: '↓', ArrowUp: '↑' }

describe('the cheat sheet documents the message grid’s own keys', () => {
  it('finds the handler at all', () => {
    // Without this the two assertions below are vacuously true the moment the file is renamed or
    // the handler is extracted — the failure mode a source scan is most prone to.
    expect(source).toBeDefined()
    expect(handledKeys(source?.text ?? '').length).toBeGreaterThan(5)
  })

  it('names every key the grid handles', () => {
    const documented = new Set(LIST_KEYS.flatMap((row) => row.keys.map(baseKey)))
    const missing = handledKeys(source?.text ?? '')
      .map((key) => GLYPH_FOR_KEY[key] ?? key)
      .filter((key) => !documented.has(key))
    expect(
      missing,
      'keys handled by MessageList’s grid but absent from LIST_KEYS — the `?` sheet would not mention them',
    ).toEqual([])
  })

  it('names no key the grid does not handle', () => {
    const handled = new Set(handledKeys(source?.text ?? '').map((key) => GLYPH_FOR_KEY[key] ?? key))
    const stale = [...new Set(LIST_KEYS.flatMap((row) => row.keys.map(baseKey)))].filter(
      (key) => !handled.has(key),
    )
    expect(stale, 'documented in the `?` sheet but no longer handled by the grid').toEqual([])
  })

  it('has a cap name for every named key it shows', () => {
    // A key whose cap is missing renders as its raw `KeyboardEvent.key` — "Escape" reads like a
    // key cap and "ArrowDown" does not, so the failure is silent for exactly the wrong half.
    const named = [...new Set(LIST_KEYS.flatMap((row) => row.keys.map(baseKey)))].filter(
      (key) => key.length > 1,
    )
    expect(named.filter((key) => KEY_CAP_KEYS[key] === undefined)).toEqual([])
  })
})
