/**
 * Sandboxed-iframe renderer (M1.7, tech-stack §4.5 step 2). Renders the sanitized body inside an
 * isolated `srcdoc` document with its OWN strict CSP and a conservative light theme.
 *
 * ## Security posture — a script-FREE sandbox
 * The frame is mounted with `sandbox="allow-same-origin"` and NOTHING else: no `allow-scripts`, no
 * `allow-top-navigation`, no `allow-forms`, no `allow-popups`. Because no script can execute inside
 * the frame, a sanitizer miss cannot run JS at all — a strictly stronger guarantee than the
 * postMessage-based auto-height the plan sketched, which would require `allow-scripts`.
 * `allow-same-origin` (WITHOUT `allow-scripts`) is the safe combination: it lets the OUTER page read
 * the frame's height and intercept its link clicks with zero code running inside the frame. The
 * inner `<meta>` CSP (`script-src 'none'`) is a second wall, and the app's own CSP is the third.
 *
 * ## Dark mode
 * Mail CSS assumes a light canvas; forcing a dark background misrenders most mail. The frame keeps a
 * conservative light background and dark text regardless of the host theme (documented trade-off).
 */

import { joinLinkText, type LinkText } from './link-host'

export interface FrameOptions {
  /** Allow remote `https:` images in the inner CSP (paired with a remote-allowing sanitize pass). */
  readonly allowRemote?: boolean
  /**
   * Colours for the frame's reset, when the caller knows the message brings none of its own.
   *
   * Omit it and the frame is forced to black-on-white, which is the only safe default for arbitrary
   * mail: a message that sets `color:#eee` and no background is unreadable on anything but white,
   * and the frame cannot know what it will be dropped onto. But that safety has a cost the caller
   * CAN measure — a message with no colour declarations at all is the common case, and forcing it
   * white punched a 670x150 px sheet of `#ffffff` into the middle of a `#2c2c2e` card in the dark
   * theme, at a contrast of about 12.8:1 against its surroundings. Passing the app's own surface and
   * text tokens for that case is what makes the dark theme first-class here (FR-UI-02).
   */
  readonly palette?: FramePalette
  /**
   * Cap the text measure. Only for bodies that carry no layout of their own: a plain-text message
   * rendered into the frame otherwise runs the full width of the reading pane — measured at 87
   * characters per line on a 1440 px desktop, well past the 45–75 that is comfortable, and the app
   * applies exactly this rule to its own prose (`.screenLead { max-inline-size: 60ch }`). A designed
   * HTML mail is left alone, because its author already chose a width.
   */
  readonly constrainWidth?: boolean
}

/** Frame colours. Hex or any CSS colour — they are interpolated into the frame's own stylesheet. */
export interface FramePalette {
  readonly background: string
  readonly text: string
  readonly link: string
}

export interface MailLinkInfo {
  readonly href: string
  /**
   * The link's text prepared FOR CLASSIFICATION — hand it straight to `classifyLink`. It is NOT a
   * display string: when the anchor has element children this holds BOTH renderings of its text (see
   * {@link linkTextOf} and `link-host.ts`'s header), newline-joined, and a reader shown it would see
   * the text twice. `raw` is the one to show a human.
   *
   * NOT clamped — `link-host.ts` explains at length why any cap here is a bypass rather than a bound:
   * the attacker chooses both the padding and where the claim sits.
   *
   * Empty only when the anchor renders no text AT ALL. An image-only link and an `<area>` are NOT
   * such cases — both carry their label in an attribute, and {@link linkTextOf} reads it. (The doc
   * here said the opposite until wave 4; it had described the state of affairs before wave 3 made
   * exactly those two cases non-empty.)
   */
  readonly text: string
  /**
   * The anchor's rendered text with no separators: its text nodes concatenated, plus the text its
   * descendants render out of ATTRIBUTES rather than text nodes — an `<img>`/`<area>`/image-button
   * `alt`, an `<input>` `value`/`placeholder`, an `<option>` `label`. That is `textContent` PLUS
   * those; the two coincide for an anchor holding none of them, which is most of them, but they are
   * not the same thing and code that needs `textContent` must ask the DOM for it. This is the field
   * to DISPLAY. On its own it is not safe to classify — see {@link linkTextOf}. Optional so that a
   * caller constructing a `MailLinkInfo` by hand (tests) need not restate it; `mountMailFrame`
   * always sets it.
   */
  readonly raw?: string
  /**
   * The same text nodes joined with a space at every element boundary. Optional for the same reason
   * as {@link MailLinkInfo.raw}; `mountMailFrame` always sets it.
   */
  readonly separated?: string
}

export interface MailFrameCallbacks {
  /**
   * A link inside the frame was clicked; the app opens it (`noopener` + visible host, FR-RD-08).
   * `info.text` is what the reader saw — the app compares it against the real host (`link-host.ts`)
   * before opening, which is a check only the app can do: nothing executes in the frame.
   */
  readonly onLink?: (href: string, info: MailLinkInfo) => void
  /** The rendered content height changed (px) — the app may mirror it onto the iframe. */
  readonly onHeight?: (px: number) => void
}

export interface MailFrameController {
  readonly destroy: () => void
}

/**
 * Black on white, and a link colour that was `#2f6fe0` — the app's accent as it stood when this line
 * was written, and a fossil of it ever since: the token moved to `#2761c4` (light) / `#82acf5`
 * (dark) and nothing here noticed. That is also why a hoster's `accentColor` reached every link in
 * the app EXCEPT the ones inside a message (FR-THEME-01). Callers that know better pass a palette.
 */
const DEFAULT_PALETTE: FramePalette = {
  background: '#ffffff',
  text: '#111111',
  link: '#2f6fe0',
}

function resetStyle(palette: FramePalette, constrainWidth: boolean): string {
  const measure = constrainWidth ? 'max-width:68ch;margin-inline:auto;' : ''
  return (
    `html,body{margin:0;padding:8px;background:${palette.background};color:${palette.text};` +
    `${measure}font-family:system-ui,-apple-system,sans-serif;overflow-wrap:break-word}` +
    `img{max-width:100%;height:auto}a{color:${palette.link}}`
  )
}

function framePolicy(allowRemote: boolean): string {
  const img = allowRemote ? 'blob: data: https:' : 'blob: data:'
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src ${img}`,
    'font-src data:',
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ')
}

/** Assemble the full `srcdoc` document: charset, an inner CSP, a conservative reset, and the body. */
export function buildFrameDocument(bodyHtml: string, options: FrameOptions = {}): string {
  const csp = framePolicy(options.allowRemote === true)
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>${resetStyle(options.palette ?? DEFAULT_PALETTE, options.constrainWidth === true)}</style>` +
    `</head><body>${bodyHtml}</body></html>`
  )
}

/** DOM node types, by number: referencing the global `Node` would break the non-DOM degradation. */
const ELEMENT_NODE = 1
const TEXT_NODE = 3

/**
 * Both renderings of a link's text, which is the input the phishing gate actually needs.
 *
 * `textContent` concatenates text nodes with NO separator, so a hidden `<span>evil.tld/</span>` in
 * front of a visible `bank.test` arrives as the single word `evil.tld/bank.test` — one host-shaped
 * word whose path happens to spell the visible host. Read from that string alone the visible claim is
 * not merely diluted, it is gone. Glue junk on the other side instead (`bank.test` + `x9`) and the
 * word stops being host-shaped at all, so no claim is produced and the empty-claims rule returns
 * `ok`. `link-host.ts`'s header works both families through end to end.
 *
 * So this walks the anchor's subtree twice over in one pass and emits:
 *  - `raw` — text nodes concatenated with no separator (`textContent`, plus the attribute-borne text
 *    below), which is what a human should be SHOWN and what catches a legitimately styled host
 *    (`<b>bank</b>.test` is `bank.test` here and nowhere else); and
 *  - `separated` — the same text nodes with a space at every ELEMENT boundary, which is what puts the
 *    spliced-in run into a word of its own.
 *
 * `classifyLink` unions the claims of the two. It is the union and not one or the other because
 * neither rendering dominates: `separated` is the only one that survives splicing, `raw` is the only
 * one that sees a host split across elements.
 *
 * ## A label that lives in an ATTRIBUTE is text the reader reads, so it is text this walk emits
 * `textContent` ignores attributes, and that made the shortest phishing link in the file work:
 *
 *     <a href="https://evil.tld/steal"><img src="https://cdn.evil.tld/l.png" alt="Sign in to bank.test"></a>
 *
 * `sanitize` strips the remote `src` — the privacy default, FR-RD-02 — which is exactly what
 * GUARANTEES the browser falls back to rendering the `alt` string. The reader literally sees the
 * words `bank.test`. Both renderings were empty, the empty-claims rule returned `ok`, and the link
 * opened with no dialog. Our own remote-blocking is what makes that reliable rather than incidental,
 * so it is not a corner case: it is the default rendering of every image-only link in the client.
 *
 * Wave 3 fixed that for `<img>`/`<area>` and left the identical defect under other tags — an
 * `<input type="image" alt>` renders its alt as the button's label under exactly the same
 * remote-stripping guarantee, and `<input value>` paints a label the walk never read. {@link attrTextOf}
 * now enumerates the whole set deliberately, tag by tag, against what `sanitize` permits; read its
 * table for what is in, what is out and why. Each is emitted into BOTH renderings, fenced by the same
 * element boundaries as any other content, so `alt="bank.test"` is its own word in `separated`.
 *
 * `title` is deliberately NOT emitted, on ANY element, and that is a false-positive judgement rather
 * than an oversight. A `title` surfaces on hover and never at all on touch, so a host named in one is
 * text the reader most likely never read — while `title="shop.example.com"` on a tracked link is an
 * ordinary newsletter shape that would start warning. The cost is a real residual, written down in
 * ADR-016 and pinned by tests on the elements `attrTextOf` actually inspects, which is the only place
 * the decision could drift.
 *
 * The walk is ITERATIVE with an explicit stack, not recursive: mail is attacker-authored and 20 000
 * nested `<span>`s in one anchor would otherwise overflow the stack on a click. Every node is pushed
 * once, so it stays O(nodes) — the same bound `textContent` itself pays.
 *
 * Duck-typed throughout (`nodeType`, `childNodes`, `nodeValue`, `nodeName`, `getAttribute`): these
 * nodes come from the FRAME's realm, so any `instanceof` against this realm's constructors is false —
 * the bug this file's cross-realm note in `onClick` exists for.
 */
export function linkTextOf(link: Element): LinkText {
  const rawParts: string[] = []
  const sepParts: string[] = []
  // Emission order is `' '`, the element's own attribute-borne text, its children in order, `' '`;
  // the stack is LIFO, so each frame is pushed in reverse of that.
  const stack: Array<Node | string | SyntheticText> = [link]
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === undefined) break
    if (typeof item === 'string') {
      // A boundary. It marks where one element's content ends, so it belongs to SEPARATED alone —
      // RAW is the unseparated concatenation, and the classifier needs it to stay that way.
      sepParts.push(item)
      continue
    }
    if (isSyntheticText(item)) {
      rawParts.push(item.synthetic)
      sepParts.push(item.synthetic)
      continue
    }
    if (item.nodeType === TEXT_NODE) {
      const value = item.nodeValue ?? ''
      rawParts.push(value)
      sepParts.push(value)
      continue
    }
    // Comments and processing instructions contribute to neither rendering, exactly as `textContent`
    // ignores them — an attacker gains nothing by hiding a host in one, because the reader sees none
    // of it either. Note what that means for SEPARATED's invariant: a comment is not a boundary, so
    // `bank.test<!--c-->x9` is one word in BOTH renderings (see `link-host.ts`).
    if (item.nodeType !== ELEMENT_NODE) continue
    const children = item.childNodes
    stack.push(' ')
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children.item(i)
      if (child !== null) stack.push(child)
    }
    const attrText = attrTextOf(item)
    if (attrText !== '') stack.push({ synthetic: attrText })
    stack.push(' ')
  }
  return { raw: rawParts.join('').trim(), separated: sepParts.join('').trim() }
}

/**
 * A run of text that is rendered but is not a text node — an attribute-borne label, see
 * {@link attrTextOf}. Distinguished from a DOM node by the ABSENCE of a numeric `nodeType` rather
 * than by the presence of its own key: an `alt` or `text` property name would collide with
 * `HTMLImageElement.alt`/`HTMLAnchorElement.text` and silently swallow real elements.
 */
interface SyntheticText {
  readonly synthetic: string
}

function isSyntheticText(item: Node | SyntheticText): item is SyntheticText {
  return typeof (item as { nodeType?: unknown }).nodeType !== 'number'
}

/**
 * `<input type>` values whose control draws NO legible text from its `value`, so reading one would
 * put text in front of the classifier that no reader was ever shown.
 *
 *  - `hidden` renders nothing at all — and a `value` is universally present on one, so reading it
 *    would be the single largest source of invented claims.
 *  - `checkbox`/`radio` draw a box; the `value` is submission data and is never painted.
 *  - `image` draws a button whose label is its `alt`, read below; `value` is not painted.
 *  - `file`/`color`/`range` paint a chooser, a swatch and a slider; the value is a fakepath, a hex
 *    triple and a number, none of which can be host-shaped in any case.
 *  - `password` paints one bullet per character, so no host in it is ever legible.
 *
 * Every other type — `text`, `search`, `url`, `tel`, `email`, `number`, the date/time family, and
 * `submit`/`reset`/`button` whose `value` IS the button's label — draws its value, so it is read. An
 * absent or unknown `type` is `text` per the HTML spec, and is read.
 */
const UNPAINTED_INPUT_VALUE: ReadonlySet<string> = new Set([
  'hidden',
  'checkbox',
  'radio',
  'image',
  'file',
  'color',
  'range',
  'password',
])

/**
 * The text an element renders from its ATTRIBUTES rather than from a text node, or `''` when it
 * renders none. `linkTextOf` emits this beside the element's text children, fenced by the same
 * boundaries, so an attribute-borne label forms its own word in SEPARATED.
 *
 * ## Why this is an enumeration and not two cases (A4b)
 * Wave 3 read `alt` off `<img>`/`<area>` and stopped there, which left the same defect under a
 * different tag. `sanitize` forbids `<form>` but keeps `<input>`, and an image button whose image is
 * unavailable renders its `alt` as the button's label — which our own privacy default GUARANTEES,
 * because the remote `src` is stripped:
 *
 *     <a href="https://evil.tld/steal"><input type="image" src="https://cdn.evil.tld/l.png"
 *        alt="Sign in to bank.test"></a>
 *
 * The reader sees `bank.test`; the walk saw nothing; the link opened in silence. `<input value>` is
 * the same shape again — a visible label living in an attribute.
 *
 * So the list below was derived by going through what `sanitize` actually permits, not by adding the
 * two tags that were reported. Each element/attribute pair was decided one way or the other:
 *
 * | kept, because it is painted            | skipped, because it is not                              |
 * | -------------------------------------- | ------------------------------------------------------- |
 * | `<img alt>`, `<area alt>`              | `<button value>` — the label is its CONTENT, already read |
 * | `<input type=image alt>`               | `<li value>` — paints a list marker, digits only          |
 * | `<input value>` (see the set above)    | `<data value>`, `<table summary>`, `<td abbr>` — machine  |
 * | `<input placeholder>` — painted empty  |   metadata, painted nowhere                               |
 * | `<textarea placeholder>`               | `<meter value>`, `<progress value>` — a bar, not text     |
 * | `<option label>`, `<optgroup label>`   | `title`, on every element — hover-only, see `linkTextOf`  |
 *
 * The direction of error here is deliberate and is the safe one: reading text the reader did NOT see
 * can only ADD a claim, and an added claim can only move a verdict toward `mismatch` (`link-host.ts`
 * on monotonicity). NOT reading text the reader DID see is the defect. So where a case was genuinely
 * ambiguous it was read.
 *
 * `<select>` needs nothing here: an option's text is a text node the walk already visits, and the
 * walk reads every option rather than only the selected one — over-reading, in the safe direction.
 */
function attrTextOf(element: Node): string {
  const name = (element.nodeName ?? '').toLowerCase()
  const read = (attribute: string): string => {
    const getAttribute = (element as Partial<Element>).getAttribute
    if (typeof getAttribute !== 'function') return ''
    return getAttribute.call(element, attribute) ?? ''
  }
  if (name === 'img' || name === 'area') return read('alt')
  if (name === 'option' || name === 'optgroup') return read('label')
  if (name === 'textarea') return read('placeholder')
  if (name !== 'input') return ''
  // An image button renders its `alt` when the image is unavailable, which is our default.
  const type = read('type').trim().toLowerCase()
  if (type === 'image') return read('alt')
  if (UNPAINTED_INPUT_VALUE.has(type)) return ''
  return [read('value'), read('placeholder')].filter((part) => part !== '').join(' ')
}

/**
 * Mount `srcdoc` into `iframe` under the script-free sandbox and wire outer-page height tracking +
 * link interception. Safe to call in a non-DOM/limited environment: it degrades without throwing.
 */
export function mountMailFrame(
  iframe: HTMLIFrameElement,
  srcdoc: string,
  callbacks: MailFrameCallbacks = {},
): MailFrameController {
  // No allow-scripts / allow-top-navigation / allow-forms / allow-popups (see the file header).
  iframe.setAttribute('sandbox', 'allow-same-origin')

  let observer: ResizeObserver | undefined
  let clickTarget: Document | undefined
  // Intercept anchors AND image-map <area> links, on primary AND auxiliary (middle/ctrl) clicks —
  // any of which would otherwise navigate the frame itself (no sandbox stops same-frame nav).
  const onClick = (event: Event): void => {
    // NOT `instanceof Element`. `event.target` is a node from the FRAME's document, and a frame — a
    // sandboxed `srcdoc` one included — is its own realm with its own `Element` constructor. An
    // `instanceof` against THIS realm's `Element` is therefore always false for the very nodes this
    // listener exists to handle, and the interception would silently never fire (fixed in M3.9;
    // jsdom models the realm split, so `frame.test.ts` now covers it). Duck-type the interface.
    const target = event.target as Element | null
    if (target === null || typeof target.closest !== 'function') return
    const link = target.closest('a[href], area[href]')
    if (link === null) return
    const href = link.getAttribute('href')
    if (href === null) return
    event.preventDefault()
    // Deliberately unclamped — see MailLinkInfo.text.
    const parts = linkTextOf(link)
    callbacks.onLink?.(href, {
      href,
      text: joinLinkText(parts),
      raw: parts.raw,
      separated: parts.separated,
    })
  }

  const onLoad = (): void => {
    const doc = iframe.contentDocument
    if (!doc) return // sandboxed srcdoc may be inaccessible in limited runtimes (e.g. jsdom)
    const root = doc.documentElement
    if (typeof ResizeObserver === 'function' && root) {
      let lastHeight = 0
      let windowStart = 0
      let updatesInWindow = 0
      observer = new ResizeObserver(() => {
        // Clamp the height to a maximum so viewport-relative content (e.g. `min-height:100vh`, whose
        // height feeds back on the iframe's own height) cannot grow the frame without bound.
        const height = Math.min(root.scrollHeight, MAX_FRAME_HEIGHT)
        if (Math.abs(height - lastHeight) < 2) return
        lastHeight = height
        iframe.style.height = `${height}px`
        callbacks.onHeight?.(height)
        // …and guard OSCILLATION by RATE, not by lifetime. The counter this replaced was a lifetime
        // cap: it counted every legitimate resize and never reset, so after 50 the observer was
        // disconnected for good and the frame's height froze for the rest of the message. `text.ts`
        // emits a `<details>` per quote level and the frame is script-free, so ~25 open/close cycles
        // of ordinary reading — or 50 images decoding one after another — spent the budget on a
        // message that was never oscillating at all.
        //
        // A feedback loop is distinguished from reading by its RATE, not by its count and not by
        // repeated heights: a `<details>` toggled back and forth revisits the same two heights too,
        // and does so seconds apart, while a loop is delivered every frame. So the window resets as
        // soon as one goes by without the budget being spent, and only a burst that keeps up
        // ~one update per frame for a whole second disconnects. The disconnect stays permanent — a
        // genuine loop does not settle, and a frozen height beats a spinning observer.
        const now = Date.now()
        if (now - windowStart >= OSCILLATION_WINDOW_MS) {
          windowStart = now
          updatesInWindow = 0
        }
        updatesInWindow += 1
        if (updatesInWindow > MAX_UPDATES_PER_WINDOW) observer?.disconnect()
      })
      observer.observe(root)
    }
    doc.addEventListener('click', onClick)
    doc.addEventListener('auxclick', onClick)
    clickTarget = doc
  }

  iframe.addEventListener('load', onLoad)
  iframe.srcdoc = srcdoc

  return {
    destroy: () => {
      iframe.removeEventListener('load', onLoad)
      observer?.disconnect()
      clickTarget?.removeEventListener('click', onClick)
      clickTarget?.removeEventListener('auxclick', onClick)
    },
  }
}

/** Hard cap on the auto-sized frame height (px). Independent of the loop guard below. */
const MAX_FRAME_HEIGHT = 20000

/**
 * The oscillation guard: more than {@link MAX_UPDATES_PER_WINDOW} height changes inside one
 * {@link OSCILLATION_WINDOW_MS} window is a resize feedback loop, not a reader. 30/s is well above
 * anything a human can produce by toggling a `<details>` or by images arriving, and well below the
 * ~60/s a loop delivers. The window is a fixed one rather than a sliding one on purpose: a loop
 * exceeds the budget in any window, so the coarser test costs nothing and holds no history.
 */
const OSCILLATION_WINDOW_MS = 1000
const MAX_UPDATES_PER_WINDOW = 30
