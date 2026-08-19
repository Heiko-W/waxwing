/**
 * Building a deployment's `config.json` from the server this app is already talking to (M5.20).
 *
 * Bulwark ships a setup wizard. A static client cannot have one: theirs writes a config file and an
 * admin password to disk, which needs the Node process it runs in. What a static client CAN do is
 * the useful half — describe the server it has already connected to, and hand the admin the
 * `config.json` for it.
 *
 * **Why it reads the live session rather than probing an address the admin types.** CORS, redirects
 * and the URLs the server actually advertises are precisely what the app has ALREADY established by
 * getting far enough to render this screen. Re-deriving them from a second, unauthenticated request
 * would produce a config describing a connection nobody has proved works. The one thing the session
 * does NOT settle is whether OAuth discovery answers, so that is fetched separately and passed in.
 *
 * Everything here is pure: facts in, config and findings out. No fetching, no file writing.
 */

import { type AuthMethod, DEFAULT_CONFIG, type WaxwingConfig } from './config'
import type { JmapSession } from './session/types'

/** Something the admin should know before deploying the generated file. */
export interface ProbeFinding {
  /** i18n key under `settings.server.generate.finding`. */
  readonly key: string
  /** `warn` needs a decision; `info` is context. Nothing here is fatal — the config still builds. */
  readonly level: 'warn' | 'info'
  /** Interpolated into the message. */
  readonly values?: Readonly<Record<string, string>>
}

export interface ProbeResult {
  readonly config: WaxwingConfig
  readonly findings: readonly ProbeFinding[]
}

/** What the caller measured that the session cannot answer. */
export interface ProbeInputs {
  /** The page's own origin, e.g. `https://mail.example.com`. */
  readonly origin: string
  /**
   * Whether `<issuer>/.well-known/openid-configuration` answered.
   *
   * `null` means the check could not be made (offline, or blocked), which is NOT the same as "no
   * OAuth" — and the difference has to survive into the findings rather than being flattened to a
   * false.
   */
  readonly oauthDiscovered: boolean | null
  /** The config currently in force, used for everything this cannot discover. */
  readonly current?: WaxwingConfig
}

/**
 * Whether `sessionUrl` can be left out of the config.
 *
 * `null` means "same-origin `/.well-known/jmap`", which is the better value whenever it is true: it
 * survives the deployment moving to another hostname. Pinning an absolute URL that happens to equal
 * the current origin bakes in an assumption for no gain.
 */
export function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url, origin).origin === new URL(origin).origin
  } catch {
    return false
  }
}

function originOf(url: string, fallback: string): string {
  try {
    return new URL(url).origin
  } catch {
    return fallback
  }
}

/**
 * The `config.json` describing this deployment.
 *
 * Branding is deliberately carried over from the current config rather than invented. It is not
 * discoverable from a server, and deriving a product name from the mail domain would put a value in
 * the file that looks chosen when nobody chose it.
 */
export function buildConfigFromSession(session: JmapSession, inputs: ProbeInputs): ProbeResult {
  const current = inputs.current ?? DEFAULT_CONFIG
  const findings: ProbeFinding[] = []
  const apiUrl = typeof session.apiUrl === 'string' ? session.apiUrl : ''
  const sameOrigin = apiUrl !== '' && isSameOrigin(apiUrl, inputs.origin)

  if (sameOrigin) {
    findings.push({ key: 'sameOrigin', level: 'info' })
  } else {
    // The app and the JMAP server are on different origins, so every request is cross-origin and
    // depends on the server's CORS headers. It evidently sends them right now — this screen could
    // not have rendered otherwise — but the deployment depends on that continuing to be true.
    findings.push({
      key: 'crossOrigin',
      level: 'warn',
      values: { origin: originOf(apiUrl, apiUrl) },
    })
  }

  const auth = authMethods(inputs.oauthDiscovered, current.server.auth)
  if (inputs.oauthDiscovered === false) {
    // Not a style note: Basic sends the password on every request and cannot be revoked per client.
    findings.push({ key: 'basicOnly', level: 'warn' })
  } else if (inputs.oauthDiscovered === null) {
    findings.push({ key: 'oauthUnknown', level: 'warn' })
  }

  if (isInsecureOrigin(inputs.origin)) {
    // A functional limit, not a best practice: without a secure context `crypto.subtle` is absent,
    // so OAuth PKCE cannot run and the encrypted replica cannot key itself.
    findings.push({ key: 'insecureOrigin', level: 'warn' })
  }

  findings.push({ key: 'brandingUntouched', level: 'info' })

  return {
    config: {
      ...current,
      server: {
        ...current.server,
        // `null` where it can be: a same-origin deployment that later moves keeps working.
        sessionUrl: sameOrigin ? null : originOf(apiUrl, apiUrl),
        auth,
      },
    },
    findings,
  }
}

/**
 * Which sign-in methods to enable.
 *
 * When discovery could not be checked, the current config's list is kept — the generator's job is
 * to describe what it found, and "I could not tell" is not grounds for narrowing a working setup.
 */
function authMethods(
  oauthDiscovered: boolean | null,
  currentAuth: readonly AuthMethod[],
): AuthMethod[] {
  if (oauthDiscovered === null) return [...currentAuth]
  return oauthDiscovered ? ['oauth', 'basic'] : ['basic']
}

/**
 * Whether this origin denies a secure context.
 *
 * `localhost` (and `127.0.0.1`) are treated as secure by every browser, which is why the dev
 * fixture works over plain HTTP — flagging them would be wrong, not merely noisy.
 */
export function isInsecureOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:') return false
    return !(
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]'
    )
  } catch {
    return false
  }
}

/** Where OAuth discovery lives for an issuer (RFC 8414 §3). */
export function discoveryUrl(issuer: string): string {
  return new URL('/.well-known/openid-configuration', issuer).toString()
}

/**
 * The file to save, as text.
 *
 * Two-space indentation and a trailing newline: a human opens this in an editor and usually edits
 * the branding block by hand afterwards.
 */
export function serializeConfig(config: WaxwingConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}
