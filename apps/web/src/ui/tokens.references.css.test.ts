import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectSources, lineOf, readAppFile, type SourceFile } from './css-sources'

/**
 * Static lint for the `--waxwing-*` namespace (B5).
 *
 * The failure this exists for shipped for eight milestones: `--waxwing-surface-hover` and
 * `--waxwing-surface-selected` were referenced by the message list from M1.6 and defined
 * nowhere, so an opened or selected row computed to `transparent` and looked like every
 * other row. Nothing could catch it — CSS custom properties are not typechecked, Biome has
 * no cross-file `var()` resolution, and the E2E assert `aria-current`, never colour. This
 * test is that missing net. Its honest headline today is that it finds NOTHING: the value
 * is prospective, not a bug harvest.
 *
 * Sound only because the namespace has exactly one definition site — every `--waxwing-*`
 * declaration in the repo lives in `tokens.css`. The "no stray definitions" assertion below
 * is what keeps that premise true.
 *
 * Runs in the Node "unit" project (see ../../../vitest.config.ts): it reads the shipped CSS
 * from disk, which the jsdom project cannot do — vitest stubs `.css` imports to empty there.
 */

const TOKENS_PATH = 'src/ui/tokens.css'
const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

// ---------------------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------------------

/**
 * The five token blocks in tokens.css, each pinned by an ANCHORED selector pattern.
 *
 * Anchoring is load-bearing, not fussiness. A naive `/:root\s*\{/` matches the base block at
 * every call — including the lookups for the two blocks whose real selectors are NOT `:root`
 * (`@media (prefers-color-scheme: dark)` wraps `:root:not([data-theme="light"])`, and
 * `@media (pointer: coarse)` wraps a second, indented `:root`). The symmetry assertion would
 * then compare the base block with itself and pass vacuously. `^` at column 0 separates the
 * base block from the media-nested ones, and the distinct-offset assertion below proves all
 * five matches really are five different blocks.
 */
// Indentation is load-bearing here: it is what separates a top-level block from a media-nested one.
// Since M4.5 the whole file sits inside `@layer waxwing.tokens { … }` (so an unlayered hoster
// override wins on any selector), which adds one level to every depth below — top-level blocks are
// at 2 spaces, media-nested ones at 4.
const BLOCK_PATTERNS = {
  root: /^ {2}:root \{([^}]*)\}/m,
  coarse: /^ {4}:root \{([^}]*)\}/m,
  mediaDark: /^ {4}:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/m,
  dataDark: /^ {2}:root\[data-theme="dark"\] \{([^}]*)\}/m,
  dataLight: /^ {2}:root\[data-theme="light"\] \{([^}]*)\}/m,
} as const

type BlockName = keyof typeof BLOCK_PATTERNS

interface Block {
  /** Token names declared in the block, in source order. Values are irrelevant here. */
  readonly names: readonly string[]
  /** Character offset of the match — used only to prove the five blocks are distinct. */
  readonly offset: number
}

function parseBlock(name: BlockName): Block {
  const match = css.match(BLOCK_PATTERNS[name])
  if (!match || match.index === undefined) {
    throw new Error(`token block not found in ${TOKENS_PATH}: ${name} (${BLOCK_PATTERNS[name]})`)
  }
  // Names only, matched per line, so multi-line values (--waxwing-font-sans) parse correctly.
  const names = [...(match[1] ?? '').matchAll(/^\s*(--waxwing-[\w-]+)\s*:/gm)].map(
    (m) => m[1] ?? '',
  )
  return { names, offset: match.index }
}

const blocks = Object.fromEntries(
  (Object.keys(BLOCK_PATTERNS) as BlockName[]).map((name) => [name, parseBlock(name)]),
) as Record<BlockName, Block>

/** Every token the app can legitimately reference: the union of all five blocks. */
const defined = new Set(Object.values(blocks).flatMap((block) => block.names))

// ---------------------------------------------------------------------------------------
// Reference collection
// ---------------------------------------------------------------------------------------

/**
 * `var(--waxwing-label-${color})` (LabelSwatch.tsx, LabelFormDialog.tsx) is the one
 * construct no static pass can resolve. The regex below captures it as the literal prefix
 * `--waxwing-label-`, and this allowlist is matched by EXACT EQUALITY, not `startsWith` —
 * so a hardcoded typo like `var(--waxwing-label-teal)` is still a finding. The prefix's own
 * blind spot (a runtime `color` outside the palette) is closed by the LABEL_COLORS assertion.
 */
const DYNAMIC_TOKEN_PREFIXES = new Set(['--waxwing-label-'])

interface Reference {
  readonly name: string
  readonly where: string
  /** `var(--x, fallback)` degrades gracefully, so an undefined name there is not a defect. */
  readonly hasFallback: boolean
}

function collectReferences(files: readonly SourceFile[]): Reference[] {
  const refs: Reference[] = []
  for (const file of files) {
    for (const match of file.text.matchAll(/var\(\s*(--waxwing-[\w-]+)\s*(,)?/g)) {
      refs.push({
        name: match[1] ?? '',
        where: `${file.path}:${lineOf(file.text, match.index)}`,
        hasFallback: match[2] !== undefined,
      })
    }
  }
  return refs
}

// Shipped sources only. Test files are excluded because they legitimately quote token names
// that do not exist (this file's own doc comments do), and nothing they contain reaches a browser.
const isTest = (file: SourceFile) => /\.(?:test|spec)\.[jt]sx?$/.test(file.path)

const sources = [
  ...collectSources('src', ['.css', '.ts', '.tsx']).filter((file) => !isTest(file)),
  ...collectSources('public', ['.css']),
  readAppFile('index.html'),
]
const references = collectReferences(sources)

// ---------------------------------------------------------------------------------------

describe('token references', () => {
  it('walks a plausible number of sources', () => {
    // Guards the whole file against a silently empty walk: every assertion below is
    // vacuously green if `sources` is empty or the extensions stop matching.
    expect(sources.length).toBeGreaterThan(35)
    expect(references.length).toBeGreaterThan(200)
  })

  it('every var(--waxwing-*) without a fallback resolves to a token in tokens.css', () => {
    const undefinedRefs = references.filter(
      (ref) => !ref.hasFallback && !defined.has(ref.name) && !DYNAMIC_TOKEN_PREFIXES.has(ref.name),
    )
    expect(
      undefinedRefs.map((ref) => `${ref.where}  var(${ref.name})`),
      'undefined custom properties — they compute to nothing at runtime, silently',
    ).toEqual([])
  })

  it('defines every --waxwing-* custom property in tokens.css and nowhere else', () => {
    // The single-definition-site premise the lint rests on. A component-scoped definition
    // would make "not in tokens.css" stop meaning "undefined".
    const strays = sources
      .filter((file) => file.path !== TOKENS_PATH && file.path !== 'public/theme.css')
      .flatMap((file) =>
        [...file.text.matchAll(/^\s*(--waxwing-[\w-]+)\s*:/gm)].map(
          (m) => `${file.path}:${lineOf(file.text, m.index)}  ${m[1]}`,
        ),
      )
    expect(strays, `all --waxwing-* definitions belong in ${TOKENS_PATH}`).toEqual([])
  })
})

describe('theme block symmetry', () => {
  it('matches five distinct blocks', () => {
    // Anti-vacuity: if two patterns collapsed onto the same block, the assertions below
    // would compare a set with itself and pass while proving nothing.
    const offsets = Object.values(blocks).map((block) => block.offset)
    expect(new Set(offsets).size).toBe(offsets.length)
    expect(blocks.root.names.length).toBeGreaterThan(50)
    expect(blocks.coarse.names).toEqual(['--waxwing-control-min'])
  })

  it('the three theme override blocks declare identical token sets', () => {
    // The colour blocks are hand-maintained triplicates across ~110 lines. A token added to
    // one and forgotten in another is invalid at computed-value time in whichever theme was
    // missed — the same failure mode as an undefined reference, and just as invisible.
    // `@media (pointer: coarse)` is deliberately not part of this: it is orthogonal to theme.
    const sorted = (name: BlockName) => [...blocks[name].names].sort()
    expect(sorted('dataDark'), 'data-theme=dark vs prefers-color-scheme:dark').toEqual(
      sorted('mediaDark'),
    )
    expect(sorted('dataLight'), 'data-theme=light vs prefers-color-scheme:dark').toEqual(
      sorted('mediaDark'),
    )
  })

  it('overrides only tokens the base :root block already declares', () => {
    const base = new Set(blocks.root.names)
    const orphans = (['mediaDark', 'dataDark', 'dataLight'] as const).flatMap((name) =>
      blocks[name].names.filter((token) => !base.has(token)).map((token) => `${name}: ${token}`),
    )
    expect(orphans, 'a theme-only token has no value when that theme is not active').toEqual([])
  })
})

describe('token contracts outside tokens.css', () => {
  it('defines one label swatch token per LABEL_COLORS entry', () => {
    // Closes the dynamic allowlist's blind spot: `var(--waxwing-label-${color})` is only safe
    // while the palette and the token family are the same set. Read as text rather than
    // imported so this stays a pure file-level check with no module graph.
    const model = readAppFile('src/mail/labels/label-model.ts').text
    const declaration = model.match(/export const LABEL_COLORS = \[([^\]]*)\]/)
    if (!declaration?.[1]) throw new Error('LABEL_COLORS not found in label-model.ts')
    const colors = [...declaration[1].matchAll(/'([a-z]+)'/g)].map((m) => `--waxwing-label-${m[1]}`)
    expect(colors.length).toBe(7)

    const labelTokens = blocks.root.names.filter((name) => name.startsWith('--waxwing-label-'))
    expect([...labelTokens].sort(), 'tokens.css label family vs LABEL_COLORS').toEqual(
      [...colors].sort(),
    )
  })

  it('keeps every token name docs/theming.md names in its worked example', () => {
    // The operator-facing contract (M4.5, FR-THEME-01). It is a full worked theme, so it names far
    // more tokens than `theme.css`'s three-line sample — and a hoster copies it wholesale. A renamed
    // token turns a whole pasted theme into a silent partial no-op: some colours change, some do
    // not, and nothing anywhere says why. The same failure `theme.css` is guarded against, at the
    // scale people actually use.
    const doc = readFileSync(
      fileURLToPath(new URL('../../../../docs/theming.md', import.meta.url)),
      'utf8',
    )
    const documented = [...doc.matchAll(/(--waxwing-[\w-]+)/g)].map((m) => m[1] ?? '')
    expect(documented.length, 'the worked example should name many tokens').toBeGreaterThan(20)
    expect(
      [...new Set(documented.filter((name) => !defined.has(name)))],
      'docs/theming.md names a token that tokens.css does not define',
    ).toEqual([])
  })

  it('keeps the token names public/theme.css documents by example', () => {
    // theme.css is the hoster white-label override point and is all comments; the examples
    // in it are the only documentation of what an override looks like. A renamed token turns
    // a hoster's copied-and-pasted override into a silent no-op.
    const theme = readAppFile('public/theme.css')
    const documented = [...theme.text.matchAll(/(--waxwing-[\w-]+)\s*:/g)].map((m) => m[1] ?? '')
    expect(documented.length).toBeGreaterThan(2)
    expect(documented.filter((name) => !defined.has(name))).toEqual([])
  })
})

describe('dead tokens', () => {
  it('reports tokens nothing references (warning only, never a failure)', () => {
    // Deliberately never fails: adding a token in one commit and using it in the next is a
    // legitimate order of work, and the entire live cost is two scale-completing tokens
    // (--waxwing-space-8, --waxwing-leading-relaxed) worth ~60 bytes. The list is a signal
    // for review, not a gate.
    const referenced = new Set(references.map((ref) => ref.name))
    const dead = blocks.root.names.filter(
      (name) =>
        !referenced.has(name) &&
        // The label family is referenced only through the dynamic construction.
        !name.startsWith('--waxwing-label-'),
    )
    if (dead.length > 0) console.warn(`[tokens] unreferenced in ${TOKENS_PATH}: ${dead.join(', ')}`)
    expect(dead.length).toBeLessThanOrEqual(blocks.root.names.length)
  })
})
