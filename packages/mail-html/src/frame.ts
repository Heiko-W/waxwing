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

export interface FrameOptions {
  /** Allow remote `https:` images in the inner CSP (paired with a remote-allowing sanitize pass). */
  readonly allowRemote?: boolean
}

export interface MailFrameCallbacks {
  /** A link inside the frame was clicked; the app opens it (`noopener` + visible host, FR-RD-08). */
  readonly onLink?: (href: string) => void
  /** The rendered content height changed (px) — the app may mirror it onto the iframe. */
  readonly onHeight?: (px: number) => void
}

export interface MailFrameController {
  readonly destroy: () => void
}

const RESET_STYLE =
  'html,body{margin:0;padding:8px;background:#ffffff;color:#111111;' +
  'font-family:system-ui,-apple-system,sans-serif;overflow-wrap:break-word}' +
  'img{max-width:100%;height:auto}a{color:#2f6fe0}'

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
    `<style>${RESET_STYLE}</style>` +
    `</head><body>${bodyHtml}</body></html>`
  )
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
    const target = event.target
    if (!(target instanceof Element)) return
    const link = target.closest('a[href], area[href]')
    const href = link?.getAttribute('href')
    if (href === null || href === undefined) return
    event.preventDefault()
    callbacks.onLink?.(href)
  }

  const onLoad = (): void => {
    const doc = iframe.contentDocument
    if (!doc) return // sandboxed srcdoc may be inaccessible in limited runtimes (e.g. jsdom)
    const root = doc.documentElement
    if (typeof ResizeObserver === 'function' && root) {
      let lastHeight = 0
      let updates = 0
      observer = new ResizeObserver(() => {
        // Clamp to a max and cap the number of updates so viewport-relative content (e.g.
        // `min-height:100vh`, whose height feeds back on the iframe's own height) cannot spin the
        // observer forever or grow the frame without bound.
        const height = Math.min(root.scrollHeight, MAX_FRAME_HEIGHT)
        if (Math.abs(height - lastHeight) < 2) return
        lastHeight = height
        iframe.style.height = `${height}px`
        callbacks.onHeight?.(height)
        updates += 1
        if (updates >= MAX_HEIGHT_UPDATES) observer?.disconnect()
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

/** Hard cap on the auto-sized frame height (px), and on the number of height updates (loop guard). */
const MAX_FRAME_HEIGHT = 20000
const MAX_HEIGHT_UPDATES = 50
